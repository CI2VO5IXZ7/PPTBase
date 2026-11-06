// 大纲阶段A集成测试：迁移、REST、CAS/幂等、steps/ops、
// 提交/确认/制作来源、配额、级联删除、与 PPT 数据隔离。
// 全部用临时目录数据库 + Fastify inject，不启动监听服务。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Transform } from 'prosemirror-transform'

import { outlineSchema } from '../../src/utils/outline/schema'
import {
  auth, createDoc, createOutline, createUser, editTokenOf, heading, imageBlock,
  makeApp, outlineDocJson, para, PNG_DATA_URL, textElement, tokenHeader, viewTokenOf,
  type TestContext,
} from './helpers'
import { MIGRATIONS, openDb } from '../src/db'

let ctx: TestContext
let alice: { userId: string, key: string }
let bob: { userId: string, key: string }

beforeAll(async () => {
  ctx = await makeApp({ RATE_LIMIT_PER_MIN: '100000' })
  alice = createUser(ctx, 'alice')
  bob = createUser(ctx, 'bob')
})

afterAll(async () => {
  await ctx.app.close()
})

async function docWithOutline(key = alice.key) {
  const doc = await createDoc(ctx, key, { title: 'demo' })
  const res = await createOutline(ctx, key, doc.docId)
  expect(res.statusCode).toBe(200)
  return { doc, outline: res.json() }
}

// 用同一共享 schema 生成合法 steps（与网页编辑器同一语义）
function stepsOf(json: unknown, edit: (tr: Transform) => void): Record<string, unknown>[] {
  const doc = outlineSchema.nodeFromJSON(json)
  const tr = new Transform(doc)
  edit(tr)
  return tr.steps.map(s => s.toJSON() as Record<string, unknown>)
}

function getOutline(headers: Record<string, string>, docId: string) {
  return ctx.app.inject({ method: 'GET', url: `/api/docs/${docId}/outline`, headers })
}

describe('v4 迁移', () => {
  it('新建数据库直接到 v4 且四张表存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pptist-mig-'))
    const db = openDb(dir)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    for (const t of ['outlines', 'outline_revisions', 'outline_submissions', 'outline_approvals']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)).toBeTruthy()
    }
    db.close()
  })

  it('v3 数据库顺序迁移到 v4，原有数据保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pptist-mig-'))
    const raw = new Database(join(dir, 'app.db'))
    // 只执行到 v3（索引 0..2），模拟老库
    for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i])
    raw.pragma('user_version = 3')
    raw.prepare(`INSERT INTO users (id, name, status, created_at) VALUES ('u1', 'legacy', 'active', 1)`).run()
    raw.prepare(
      `INSERT INTO documents (id, owner_id, title, data, version, size, link_version, created_at, updated_at)
       VALUES ('d1', 'u1', 'old', '{"title":"old","slides":[]}', 1, 10, 1, 1, 1)`
    ).run()
    raw.close()

    const db = openDb(dir)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect((db.prepare('SELECT title FROM documents WHERE id = ?').get('d1') as { title: string }).title).toBe('old')
    // 新表可用
    db.prepare(
      `INSERT INTO outlines (doc_id, content, threads, version, content_version, size, created_at, updated_at)
       VALUES ('d1', '{}', '[]', 1, 1, 2, 1, 1)`
    ).run()
    db.close()
  })
})

describe('初始化与权限', () => {
  it('API Key 可初始化大纲；重复初始化返回 existing', async () => {
    const { doc, outline } = await docWithOutline()
    expect(outline.existing).toBe(false)
    expect(outline.version).toBe(1)
    expect(outline.contentVersion).toBe(1)
    expect(outline.content.content[0].attrs.blockId).toBeTruthy()

    const again = await createOutline(ctx, alice.key, doc.docId)
    expect(again.json().existing).toBe(true)

    // 初始化不影响 PPT 数据与版本
    const docRes = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: auth(alice.key) })
    expect(docRes.json().version).toBe(1)
    expect(docRes.json().hasOutline).toBe(true)
    expect(docRes.json().outlineEditUrl).toContain('tab=outline')
  })

  it('列表元数据带 hasOutline/outline 状态', async () => {
    const { doc } = await docWithOutline()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    const item = res.json().find((d: { id: string }) => d.id === doc.docId)
    expect(item.hasOutline).toBe(true)
    expect(item.outline.contentVersion).toBe(1)
    expect(item.outline.pendingSubmissions).toBe(0)
  })

  it('view 令牌可读不可写，他人 Key 一律 404', async () => {
    const { doc } = await docWithOutline()
    const view = viewTokenOf(ctx, doc.docId)
    const get = await getOutline(tokenHeader(view), doc.docId)
    expect(get.statusCode).toBe(200)
    expect(get.json().role).toBe('view')

    const patch = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(view), payload: { baseVersion: 1, steps: [] },
    })
    expect(patch.statusCode).toBe(403)

    for (const url of [
      `/api/docs/${doc.docId}/outline`,
      `/api/docs/${doc.docId}/outline/ops`,
      `/api/docs/${doc.docId}/outline/feedback`,
      `/api/docs/${doc.docId}/outline/approval`,
      `/api/docs/${doc.docId}/outline/generation`,
    ]) {
      const res = await ctx.app.inject({ method: 'POST', url, headers: auth(bob.key), payload: {} })
      expect(res.statusCode, url).toBe(404)
    }
  })
})

describe('steps 写入与 CAS/幂等', () => {
  it('steps 应用成功版本递增；baseVersion 不匹配返回 409', async () => {
    const { doc } = await docWithOutline()
    const content = {
      type: 'doc',
      content: [para('b1', 'hello'), para('b2', 'world')],
    }
    // 先 ops 写入两块
    const ops = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: auth(alice.key),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: content.content }] },
    })
    expect(ops.statusCode).toBe(200)
    const version = ops.json().version

    const steps = stepsOf(content, tr => tr.insert(1, outlineSchema.text('hi ')))
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(editTokenOf(ctx, doc.docId)),
      payload: { baseVersion: version, requestId: 'req-1', steps },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(version + 1)
    expect(res.json().contentVersion).toBeGreaterThan(1)

    // requestId 重放：返回原结果，不重复写入
    const replay = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(editTokenOf(ctx, doc.docId)),
      payload: { baseVersion: version, requestId: 'req-1', steps },
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().deduplicated).toBe(true)
    expect(replay.json().version).toBe(version + 1)

    // 同 requestId 不同内容 → 冲突
    const clash = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(editTokenOf(ctx, doc.docId)),
      payload: { baseVersion: version, requestId: 'req-1', steps: [{ stepType: 'replace', from: 1, to: 2 }] },
    })
    expect(clash.statusCode).toBe(409)

    // 旧 baseVersion → 409 带当前版本
    const stale = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(editTokenOf(ctx, doc.docId)),
      payload: { baseVersion: version - 1, steps },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().issues?.currentVersion ?? stale.json().currentVersion).toBe(version + 1)
  })

  it('非法 steps 报 400，不产生半提交', async () => {
    const { doc } = await docWithOutline()
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/docs/${doc.docId}/outline`,
      headers: tokenHeader(editTokenOf(ctx, doc.docId)),
      payload: { baseVersion: 1, steps: [{ stepType: 'bogus' }] },
    })
    expect(res.statusCode).toBe(400)
    const after = await getOutline(auth(alice.key), doc.docId)
    expect(after.json().version).toBe(1)
  })
})

describe('结构化 ops', () => {
  it('insert/replace/delete/move/attrs 全套与锚点线程', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)

    let res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: 1,
        ops: [
          { op: 'insertBlocks', blocks: [heading('h1', 1, '标题'), para('p1', '第一段'), para('p2', '第二段')] },
          { op: 'addComment', anchor: { kind: 'textRange', fragments: [{ blockId: 'p1', from: 0, to: 3 }] }, content: '这段要改' },
          { op: 'addComment', anchor: { kind: 'block', blockId: 'p2' }, content: '整段意见' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    let v = res.json().version

    // 在 p1 前插入文字会让选区失效？replaceBlock 改 p1 内容 → 原选区 detached
    res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: v,
        ops: [
          { op: 'replaceBlock', blockId: 'p1', block: para('p1', '全新内容不一样') },
          { op: 'moveBlock', blockId: 'p2', before: 'h1' },
          { op: 'addComment', anchor: { kind: 'document' }, content: '全文总评' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    v = res.json().version

    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    const blocks = state.content.content.map((n: { attrs?: { blockId?: string } }) => n.attrs?.blockId)
    expect(blocks.indexOf('p2')).toBeLessThan(blocks.indexOf('h1')) // p2 已移动到 h1 之前
    const threads = state.threads as { status: string, detached: boolean, anchor: { kind: string, quote?: { text: string } } }[]
    const rangeT = threads.find(t => t.anchor.kind === 'textRange')!
    const blockT = threads.find(t => t.anchor.kind === 'block')!
    const docT = threads.find(t => t.anchor.kind === 'document')!
    expect(rangeT.detached).toBe(true) // 区块被重写 → 失效
    expect(rangeT.anchor.quote?.text).toBe('第一段')
    expect(blockT.detached).toBe(false) // 移动保持绑定
    expect(docT.detached).toBe(false)

    // 回复 + 显式解决/重开
    res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: v,
        ops: [
          { op: 'replyComment', threadId: blockT && (state.threads as { id: string, anchor: { kind: string } }[]).find(t => t.anchor.kind === 'block')!.id, content: '收到' },
        ],
      },
    })
    // 修正：直接用状态中的 threadId
    const blockThreadId = (state.threads as { id: string, anchor: { kind: string } }[]).find(t => t.anchor.kind === 'block')!.id
    res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: res.json().version,
        ops: [
          { op: 'setThreadStatus', threadId: blockThreadId, status: 'resolved' },
          { op: 'setThreadStatus', threadId: blockThreadId, status: 'open' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const after = (await getOutline(auth(alice.key), doc.docId)).json()
    const bt = (after.threads as { id: string, status: string, messages: unknown[] }[]).find(t => t.id === blockThreadId)!
    expect(bt.status).toBe('open')
    expect(bt.messages.length).toBe(2)
  })

  it('原子性：批量 ops 中任一步失败整体不写', async () => {
    const { doc } = await docWithOutline()
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: auth(alice.key),
      payload: {
        baseVersion: 1,
        ops: [
          { op: 'insertBlocks', blocks: [para('ok', '好')] },
          { op: 'replaceBlock', blockId: 'missing', block: para('x', 'y') },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    expect(state.version).toBe(1)
    expect(state.content.content.length).toBe(1)
  })

  it('不允许修改 blockId，不允许危险节点/链接协议/越权资产', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)

    // 越权资产：bob 上传的图片不能挂到 alice 的大纲
    const up = await ctx.app.inject({
      method: 'POST', url: '/api/assets', headers: auth(bob.key),
      payload: { data: PNG_DATA_URL },
    })
    const bobUrl = up.json().url as string

    const bad = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: 1,
        ops: [
          { op: 'insertBlocks', blocks: [imageBlock('im1', bobUrl)] },
          { op: 'insertBlocks', blocks: [{ type: 'script' }] },
          {
            op: 'insertBlocks',
            blocks: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
            }],
          },
          { op: 'updateBlockAttrs', blockId: 'im1', attrs: { blockId: 'hack' } },
        ],
      },
    })
    expect(bad.statusCode).toBe(400)
    // 批量原子：一个失败整体不写
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    expect(state.content.content.length).toBe(1)
  })

  it('本人资产与 data: 图片可正常引用/转存', async () => {
    const { doc } = await docWithOutline()
    const up = await ctx.app.inject({
      method: 'POST', url: '/api/assets', headers: auth(alice.key),
      payload: { data: PNG_DATA_URL },
    })
    const url = up.json().url as string
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: auth(alice.key),
      payload: {
        baseVersion: 1,
        ops: [
          { op: 'insertBlocks', blocks: [imageBlock('im1', url, { usage: 'include', usageDescription: '首页配图' }), imageBlock('im2', PNG_DATA_URL)] },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    const imgs = state.content.content.filter((n: { type: string }) => n.type === 'image')
    expect(imgs.length).toBe(2)
    expect(imgs[0].attrs.usage).toBe('include')
    expect(imgs[1].attrs.src).toMatch(/^\/assets\/[\w-]+\.png$/) // data: 已转存
  })
})

describe('提交反馈', () => {
  it('快照不可变：提交后修改不影响已提交内容', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: [para('p1', 'v1 content')] }] },
    })
    const sub = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token),
      payload: { requestId: 'fb-1', note: '第一轮' },
    })
    expect(sub.statusCode).toBe(200)
    expect(sub.json().submission.round).toBe(1)
    expect(sub.json().submission.status).toBe('pending')

    // 幂等：同 requestId 返回同一提交
    const dup = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token),
      payload: { requestId: 'fb-1', note: '第一轮' },
    })
    expect(dup.json().submission.id).toBe(sub.json().submission.id)
    expect(dup.json().deduplicated).toBe(true)

    // 继续编辑不影响快照
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: v, ops: [{ op: 'insertBlocks', blocks: [para('p2', 'v2 new')] }] },
    })
    const detail = await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}/outline/feedback/${sub.json().submission.id}`,
      headers: auth(alice.key),
    })
    const snapContent = JSON.stringify(detail.json().snapshot.content)
    expect(snapContent).toContain('v1 content')
    expect(snapContent).not.toContain('v2 new')
  })

  it('新一轮提交使旧 pending 变 superseded；Agent 可完成指定轮次', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const s1 = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: {},
    })
    const s2 = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: {},
    })
    const list = (await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: auth(alice.key),
    })).json()
    expect(list.submissions.length).toBe(2)
    expect(list.submissions.find((s: { round: number }) => s.round === 1).status).toBe('superseded')
    expect(list.submissions.find((s: { round: number }) => s.round === 2).status).toBe('pending')

    // 完成旧轮 → 409；完成新轮 → handled
    const doneOld = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback/${s1.json().submission.id}/complete`,
      headers: auth(alice.key), payload: {},
    })
    expect(doneOld.statusCode).toBe(409)
    const done = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback/${s2.json().submission.id}/complete`,
      headers: auth(alice.key), payload: { note: '已处理' },
    })
    expect(done.statusCode).toBe(200)
    expect(done.json().submission.status).toBe('handled')
    expect(done.json().submission.result.note).toBe('已处理')

    // 网页令牌不能调 complete（Agent 动作）
    const byUser = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback/${s2.json().submission.id}/complete`,
      headers: tokenHeader(token), payload: {},
    })
    expect(byUser.statusCode).toBe(404)
  })
})

describe('确认与制作来源', () => {
  it('未解决批注需显式确认；正文变化使确认失效；仅评论不失效', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: 1,
        ops: [
          { op: 'insertBlocks', blocks: [para('p1', '正文')] },
          { op: 'addComment', anchor: { kind: 'block', blockId: 'p1' }, content: '待处理' },
        ],
      },
    })
    let v = (await getOutline(auth(alice.key), doc.docId)).json().version

    // 有未解决批注且未显式确认 → 409
    const deny = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: v },
    })
    expect(deny.statusCode).toBe(409)
    expect(deny.json().issues?.openThreads ?? JSON.parse(deny.body).issues?.openThreads).toBe(1)

    // Agent Key 不能代用户确认
    const byAgent = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: auth(alice.key), payload: { baseVersion: v },
    })
    expect(byAgent.statusCode).toBe(403)

    // 显式选择仍确认
    const ok = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: v, acknowledgeOpenThreads: true, requestId: 'ap-1' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().approval.openThreads).toBe(1)
    expect(ok.json().approval.acknowledgedOpenThreads).toBe(true)
    v = (await getOutline(auth(alice.key), doc.docId)).json().version

    // begin 制作成功
    const gen = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(gen.statusCode).toBe(200)
    expect(gen.json().approvalId).toBe(ok.json().approval.id)
    expect(gen.json().stale).toBe(false)

    // 仅新增批注（contentVersion 不变）确认仍有效
    const cur = (await getOutline(auth(alice.key), doc.docId)).json()
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: cur.version, ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '补充意见' }] },
    })
    const gen2 = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(gen2.statusCode).toBe(200)
    expect(gen2.json().stale).toBe(false)

    // 正文变化 → 旧确认失效，begin 拒绝
    const cur2 = (await getOutline(auth(alice.key), doc.docId)).json()
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: cur2.version, ops: [{ op: 'insertBlocks', blocks: [para('px', '改动')] }] },
    })
    const stale = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().message).toContain('确认后大纲内容已变化')

    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    expect(state.status.approval.valid).toBe(false)
    expect(state.status.generation.stale).toBe(true)
  })

  it('撤销确认后 begin 被拒绝；未确认不能 begin', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)

    const noApproval = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(noApproval.statusCode).toBe(409)

    const v = (await getOutline(auth(alice.key), doc.docId)).json().version
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: v },
    })
    const revoke = await ctx.app.inject({
      method: 'DELETE', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token),
    })
    expect(revoke.statusCode).toBe(200)

    const denied = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(denied.statusCode).toBe(409)
  })
})

describe('预算、级联与隔离', () => {
  it('大纲与 PPT 合计超过配额拒绝写入', async () => {
    ctx.db.prepare('UPDATE users SET quota_doc_bytes = ? WHERE id = ?').run(4096, alice.userId)
    const { doc } = await docWithOutline()
    const big = 'x'.repeat(5000)
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: auth(alice.key),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: [para('big', big)] }] },
    })
    expect(res.statusCode).toBe(413)
    ctx.db.prepare('UPDATE users SET quota_doc_bytes = NULL WHERE id = ?').run(alice.userId)
  })

  it('删除文档级联清理大纲数据', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: {},
    })
    const del = await ctx.app.inject({
      method: 'DELETE', url: `/api/docs/${doc.docId}`, headers: auth(alice.key),
    })
    expect(del.statusCode).toBe(200)
    for (const t of ['outlines', 'outline_revisions', 'outline_submissions', 'outline_approvals']) {
      const n = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE doc_id = ?`).get(doc.docId) as { n: number }).n
      expect(n, t).toBe(0)
    }
  })

  it('普通修订快照清理不删被提交引用的版本', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    // v1 初始化 → 提交固定 v1 版本
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: {},
    })
    // 追加 110 次流程写入（评论开关），把 v1 挤出口径
    for (let i = 0; i < 110; i++) {
      const v = (await getOutline(auth(alice.key), doc.docId)).json().version
      const r = await ctx.app.inject({
        method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
        headers: tokenHeader(token),
        payload: { baseVersion: v, ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: `c${i}` }] },
      })
      expect(r.statusCode).toBe(200)
    }
    const kept = ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM outline_revisions WHERE doc_id = ? AND version = 1 AND snapshot IS NOT NULL`
    ).get(doc.docId) as { n: number }
    expect(kept.n).toBe(1) // 提交引用的 v1 快照保留
    const others = ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM outline_revisions WHERE doc_id = ? AND version > 2 AND version <= 10 AND snapshot IS NOT NULL`
    ).get(doc.docId) as { n: number }
    expect(others.n).toBe(0) // 老普通修订快照已清理
  })

  it('大纲操作不改变 PPT 数据；PPT 写入也不改大纲版本', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const ops = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: [para('p', 'x')] }] },
    })
    expect(ops.statusCode).toBe(200)
    const docRes = (await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: auth(alice.key) })).json()
    expect(docRes.version).toBe(1) // PPT 版本未变

    // PPT 写入不影响大纲版本
    const outlineBefore = (await getOutline(auth(alice.key), doc.docId)).json()
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key),
      payload: { ops: [{ op: 'addSlides', slides: [{ id: 's1', elements: [textElement('e1', 'hi')] }] }] },
    })
    const outlineAfter = (await getOutline(auth(alice.key), doc.docId)).json()
    expect(outlineAfter.version).toBe(outlineBefore.version)
    expect(outlineAfter.contentVersion).toBe(outlineBefore.contentVersion)
  })
})

describe('边界修复', () => {
  it('deleteBlocks 拒绝重复 id 与祖先+后代同批删除', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    // 结构：bullet_list(l1) > list_item(li1) > paragraph(ip1)
    const build = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: 1,
        ops: [{
          op: 'insertBlocks',
          blocks: [
            para('p1', 'top'),
            {
              type: 'bullet_list',
              attrs: { blockId: 'l1' },
              content: [{ type: 'list_item', attrs: { blockId: 'li1' }, content: [para('ip1', 'nested')] }],
            },
          ],
        }],
      },
    })
    expect(build.statusCode).toBe(200)
    const v = build.json().version

    // 重复 id → 400，且整体不写
    let res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: v, ops: [{ op: 'deleteBlocks', blockIds: ['p1', 'p1'] }] },
    })
    expect(res.statusCode).toBe(400)
    expect((await getOutline(auth(alice.key), doc.docId)).json().version).toBe(v)

    // 祖先(bullet_list)+后代(list_item) → 400，且整体不写
    res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: v, ops: [{ op: 'deleteBlocks', blockIds: ['l1', 'li1'] }] },
    })
    expect(res.statusCode).toBe(400)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    expect(state.version).toBe(v)
    expect(state.content.content.length).toBe(3) // 默认段 + p1 + l1 均保留
  })

  it('同批次先改写区块再对其加批注被拒绝；未修改区块不受影响', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const build = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: [para('p1', '旧文本'), para('p2', '另一块')] }] },
    })
    const v = build.json().version

    // replaceBlock p1 + addComment textRange on p1 → 400 歧义
    let res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: v,
        ops: [
          { op: 'replaceBlock', blockId: 'p1', block: para('p1', '新文本') },
          { op: 'addComment', anchor: { kind: 'textRange', fragments: [{ blockId: 'p1', from: 0, to: 2 }] }, content: '歧义批注' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect((await getOutline(auth(alice.key), doc.docId)).json().version).toBe(v)

    // replaceBlock p1 + addComment on p2（未修改）→ 200
    res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: v,
        ops: [
          { op: 'replaceBlock', blockId: 'p1', block: para('p1', '新文本') },
          { op: 'addComment', anchor: { kind: 'block', blockId: 'p2' }, content: '可以' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(v + 1)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    expect((state.threads as unknown[]).length).toBe(1)
  })

  it('init 相同 requestId 相同内容幂等；不同内容冲突', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'init-idem' })
    const first = await createOutline(ctx, alice.key, doc.docId, {
      requestId: 'init-1',
      content: outlineDocJson(para('a', 'A')),
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().existing).toBe(false)

    // 相同 requestId + 相同内容 → existing:true
    const same = await createOutline(ctx, alice.key, doc.docId, {
      requestId: 'init-1',
      content: outlineDocJson(para('a', 'A')),
    })
    expect(same.statusCode).toBe(200)
    expect(same.json().existing).toBe(true)

    // 相同 requestId + 不同内容 → 409
    const diff = await createOutline(ctx, alice.key, doc.docId, {
      requestId: 'init-1',
      content: outlineDocJson(para('b', 'B')),
    })
    expect(diff.statusCode).toBe(409)

    // 无 requestId 的重试 → existing:true（不覆盖）
    const plain = await createOutline(ctx, alice.key, doc.docId, {})
    expect(plain.json().existing).toBe(true)
    // 仍只有一个 revision v1，没有不受控的重复 INSERT
    const revs = ctx.db.prepare('SELECT COUNT(*) AS n FROM outline_revisions WHERE doc_id = ?').get(doc.docId) as { n: number }
    expect(revs.n).toBe(1)
  })

  it('提交/确认按双份快照计配额', async () => {
    const { gzipSync } = await import('node:zlib')
    const { assetManifest } = await import('../../src/utils/outline/serialize')
    const { outlineSchema: schema } = await import('../../src/utils/outline/schema')

    const { doc } = await docWithOutline()
    const row = ctx.db.prepare('SELECT content, size FROM outlines WHERE doc_id = ?').get(doc.docId) as { content: string, size: number }
    const docRow = ctx.db.prepare('SELECT size FROM documents WHERE id = ?').get(doc.docId) as { size: number }
    const revBytes = (ctx.db.prepare('SELECT COALESCE(SUM(LENGTH(snapshot)),0) AS n FROM outline_revisions WHERE doc_id = ?').get(doc.docId) as { n: number }).n

    // 与 service.makeSnapshot 相同方式计算提交快照字节数
    const parsed = schema.nodeFromJSON(JSON.parse(row.content))
    const snapLen = gzipSync(JSON.stringify({
      content: JSON.parse(row.content), threads: [], assets: assetManifest(parsed),
    })).length

    // 预算恰好只够「单份」快照：双份计费必须 413
    const quota = docRow.size + row.size + revBytes + snapLen + 8
    ctx.db.prepare('UPDATE users SET quota_doc_bytes = ? WHERE id = ?').run(quota, alice.userId)

    const token = editTokenOf(ctx, doc.docId)
    const fb = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: {},
    })
    expect(fb.statusCode).toBe(413)

    const ap = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: 1 },
    })
    expect(ap.statusCode).toBe(413)

    // 半提交检查：没有遗留记录
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM outline_submissions WHERE doc_id = ?').get(doc.docId) as { n: number }).n).toBe(0)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM outline_approvals WHERE doc_id = ?').get(doc.docId) as { n: number }).n).toBe(0)
    ctx.db.prepare('UPDATE users SET quota_doc_bytes = NULL WHERE id = ?').run(alice.userId)
  })

  it('listDocs 只认 active 确认，撤销后 approvalActive=false', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: v },
    })

    const list = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    let item = list.json().find((d: { id: string }) => d.id === doc.docId)
    expect(item.outline.approvalActive).toBe(true)
    expect(item.outline.approvalValid).toBe(true)

    await ctx.app.inject({
      method: 'DELETE', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token),
    })
    const list2 = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    item = list2.json().find((d: { id: string }) => d.id === doc.docId)
    expect(item.outline.approvalActive).toBe(false)
    expect(item.outline.approvalValid).toBe(false)
  })
})
