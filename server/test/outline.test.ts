// 大纲阶段A集成测试：迁移、REST、CAS/幂等、steps/ops、
// 提交/确认/制作来源、配额、级联删除、与 PPT 数据隔离。
// 全部用临时目录数据库 + Fastify inject，不启动监听服务。
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Transform } from 'prosemirror-transform'

import { outlineSchema } from '../../src/utils/outline/schema'
import {
  approveAsUser, auth, confirmSession, confirmTicket, createDoc, createOutline, createUser, editTokenOf,
  heading, imageBlock, makeApp, outlineDocJson, para, PNG_DATA_URL, revokeAsUser,
  textElement, tokenHeader, viewTokenOf,
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
  it('新建数据库直接到最新版本且大纲各表存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pptist-mig-'))
    const db = openDb(dir)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    for (const t of ['outlines', 'outline_revisions', 'outline_submissions', 'outline_approvals', 'outline_confirm_tickets', 'outline_confirm_sessions']) {
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
    expect(db.pragma('user_version', { simple: true })).toBe(6)
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
    const deny = await approveAsUser(ctx, doc.docId, token, { baseVersion: v })
    expect(deny.statusCode).toBe(409)
    expect(deny.json().issues?.openThreads ?? JSON.parse(deny.body).issues?.openThreads).toBe(1)

    // Agent Key 不能代用户确认
    const byAgent = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: auth(alice.key), payload: { baseVersion: v },
    })
    expect(byAgent.statusCode).toBe(403)

    // 显式选择仍确认
    const ok = await approveAsUser(ctx, doc.docId, token, { baseVersion: v, acknowledgeOpenThreads: true, requestId: 'ap-1' })
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
    await approveAsUser(ctx, doc.docId, token, { baseVersion: v })
    const revoke = await revokeAsUser(ctx, doc.docId, token)
    expect(revoke.statusCode).toBe(200)

    const denied = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(denied.statusCode).toBe(409)
  })
})

describe('确认凭证：编辑令牌不能冒充真人确认', () => {
  it('仅凭 X-Doc-Token 编辑令牌 approve/revoke 一律 403；持一次性凭证成功且不可重用', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId) // = create_outline 返回 outlineEditUrl 中的令牌
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version

    // Agent 拿编辑令牌直接确认 → 拒绝（缺一次性确认凭证）
    const bare = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: v },
    })
    expect(bare.statusCode).toBe(403)
    const bareRevoke = await ctx.app.inject({
      method: 'DELETE', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token),
    })
    expect(bareRevoke.statusCode).toBe(403)

    // 真人路径：取票 → 携带 X-Confirm-Token 确认成功
    const ticket = await confirmTicket(ctx, doc.docId, token, 'approve')
    const ok = await approveAsUser(ctx, doc.docId, token, { baseVersion: v }, ticket)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().approval.status).toBe('active')

    // 同一凭证不可重用（用完即废）
    const cur = (await getOutline(auth(alice.key), doc.docId)).json()
    const reuse = await approveAsUser(ctx, doc.docId, token, { baseVersion: cur.version }, ticket)
    expect(reuse.statusCode).toBe(403)
    expect(reuse.json().message).toContain('已使用')
  })

  it('凭证绑定动作：approve/revoke 不能互换；过期凭证拒绝', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version

    // revoke 凭证用于 approve → 403
    const revokeTicket = await confirmTicket(ctx, doc.docId, token, 'revoke')
    const wrongAction = await approveAsUser(ctx, doc.docId, token, { baseVersion: v }, revokeTicket)
    expect(wrongAction.statusCode).toBe(403)

    // 确认一次后：approve 凭证用于 revoke → 403
    await approveAsUser(ctx, doc.docId, token, { baseVersion: v })
    const approveTicket = await confirmTicket(ctx, doc.docId, token, 'approve')
    const wrongRevoke = await revokeAsUser(ctx, doc.docId, token, approveTicket)
    expect(wrongRevoke.statusCode).toBe(403)

    // 过期凭证拒绝
    const stale = await confirmTicket(ctx, doc.docId, token, 'approve')
    ctx.db.prepare('UPDATE outline_confirm_tickets SET expires_at = 0 WHERE token_hash = ?')
      .run(createHash('sha256').update(stale).digest('hex'))
    const expired = await approveAsUser(ctx, doc.docId, token, { baseVersion: v }, stale)
    expect(expired.statusCode).toBe(403)
    expect(expired.json().message).toContain('已过期')
  })

  it('凭证申请仅编辑令牌角色：owner/view 403，他人 Key 404，动作非法 400', async () => {
    const { doc } = await docWithOutline()
    const url = `/api/docs/${doc.docId}/outline/approval/ticket`

    const byOwner = await ctx.app.inject({ method: 'POST', url, headers: auth(alice.key), payload: { action: 'approve' } })
    expect(byOwner.statusCode).toBe(403)
    const byView = await ctx.app.inject({ method: 'POST', url, headers: tokenHeader(viewTokenOf(ctx, doc.docId)), payload: { action: 'approve' } })
    expect(byView.statusCode).toBe(403)
    const byBob = await ctx.app.inject({ method: 'POST', url, headers: auth(bob.key), payload: { action: 'approve' } })
    expect(byBob.statusCode).toBe(404)
    const badAction = await ctx.app.inject({ method: 'POST', url, headers: tokenHeader(editTokenOf(ctx, doc.docId)), payload: { action: 'peek' } })
    expect(badAction.statusCode).toBe(400)

    // 无大纲文档：先取票也 404
    const noOutline = await createDoc(ctx, alice.key, { title: 'no-outline' })
    const noTicket = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${noOutline.docId}/outline/approval/ticket`,
      headers: tokenHeader(editTokenOf(ctx, noOutline.docId)), payload: { action: 'approve' },
    })
    expect(noTicket.statusCode).toBe(404)
  })

  it('领票与编辑令牌脱钩：必须另持同源网页确认会话', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const sessionUrl = `/api/docs/${doc.docId}/outline/approval/session`
    const ticketUrl = `/api/docs/${doc.docId}/outline/approval/ticket`

    // a. 只凭编辑令牌领票 → 403（Agent 拿到 #t= 编辑链接也无法直接领票）
    const bare = await ctx.app.inject({
      method: 'POST', url: ticketUrl,
      headers: tokenHeader(token), payload: { action: 'approve' },
    })
    expect(bare.statusCode).toBe(403)

    // b. 拿会话不带 Origin → 403；Origin 错误 → 403；`*`/`null` 也拒
    const noOrigin = await ctx.app.inject({ method: 'POST', url: sessionUrl, headers: tokenHeader(token) })
    expect(noOrigin.statusCode).toBe(403)
    const badOrigin = await ctx.app.inject({
      method: 'POST', url: sessionUrl,
      headers: { ...tokenHeader(token), origin: 'http://evil.example' },
    })
    expect(badOrigin.statusCode).toBe(403)
    const starOrigin = await ctx.app.inject({
      method: 'POST', url: sessionUrl,
      headers: { ...tokenHeader(token), origin: '*' },
    })
    expect(starOrigin.statusCode).toBe(403)
    // view 角色同样不能拿会话
    const byView = await ctx.app.inject({
      method: 'POST', url: sessionUrl,
      headers: { ...tokenHeader(viewTokenOf(ctx, doc.docId)), origin: ctx.config.publicBaseUrl },
    })
    expect(byView.statusCode).toBe(403)

    // c. API Key（owner）拿会话 → 403（Agent 不能代领，Origin 正确也不行）
    const byOwner = await ctx.app.inject({
      method: 'POST', url: sessionUrl,
      headers: { ...auth(alice.key), origin: ctx.config.publicBaseUrl },
    })
    expect(byOwner.statusCode).toBe(403)

    // d. 真人网页路径：会话 → 领票 → 确认 → 200；会话可重复领票
    const session = await confirmSession(ctx, doc.docId, token)
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version
    const ticket = await confirmTicket(ctx, doc.docId, token, 'approve', session)
    const ok = await approveAsUser(ctx, doc.docId, token, { baseVersion: v }, ticket)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().approval.status).toBe('active')
    // 同一会话有效期内可再领 revoke 票
    const revokeTicket = await confirmTicket(ctx, doc.docId, token, 'revoke', session)
    const revoked = await revokeAsUser(ctx, doc.docId, token, revokeTicket)
    expect(revoked.statusCode).toBe(200)

    // e. 会话过期后领票 → 403（票本身不受影响，只是领不到新的）
    ctx.db.prepare('UPDATE outline_confirm_sessions SET expires_at = 0 WHERE token_hash = ?')
      .run(createHash('sha256').update(session).digest('hex'))
    const staleTicket = await ctx.app.inject({
      method: 'POST', url: ticketUrl,
      headers: { ...tokenHeader(token), 'x-confirm-session': session },
      payload: { action: 'approve' },
    })
    expect(staleTicket.statusCode).toBe(403)
  })

  it('GET 大纲不再向 owner 回吐编辑令牌；编辑/查看不受影响', async () => {
    const { doc } = await docWithOutline()
    const byOwner = await getOutline(auth(alice.key), doc.docId)
    expect(byOwner.statusCode).toBe(200)
    expect(byOwner.json().outlineEditUrl).toBeUndefined()
    expect(byOwner.json().editUrl).toBeUndefined()
    expect(byOwner.json().outlineViewUrl).toContain('mode=view')
    expect(byOwner.json().viewUrl).toContain('mode=view')

    const token = editTokenOf(ctx, doc.docId)
    const byEdit = await getOutline(tokenHeader(token), doc.docId)
    expect(byEdit.statusCode).toBe(200)
    expect(byEdit.json().role).toBe('edit')
    expect(byEdit.json().outlineViewUrl).toContain('mode=view')

    // 编辑令牌仍可读/写大纲内容：ops 写入正常
    const ops = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: byEdit.json().version, ops: [{ op: 'insertBlocks', blocks: [para('k1', '仍可编辑')] }] },
    })
    expect(ops.statusCode).toBe(200)
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

    // PPT 写入不影响大纲版本（先确认+begin 建立制作来源，否则 Agent ops 被门禁拒）
    const v = (await getOutline(auth(alice.key), doc.docId)).json().version
    const ap = await approveAsUser(ctx, doc.docId, token, { baseVersion: v, acknowledgeOpenThreads: true })
    expect(ap.statusCode).toBe(200)
    const gen = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(gen.statusCode).toBe(200)
    const outlineBefore = (await getOutline(auth(alice.key), doc.docId)).json()
    const pptOps = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key),
      payload: { ops: [{ op: 'addSlides', slides: [{ id: 's1', elements: [textElement('e1', 'hi')] }] }], sourceApprovalId: gen.json().approvalId },
    })
    expect(pptOps.statusCode).toBe(200)
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

    const ap = await approveAsUser(ctx, doc.docId, token, { baseVersion: 1 })
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
    await approveAsUser(ctx, doc.docId, token, { baseVersion: v })

    const list = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    let item = list.json().find((d: { id: string }) => d.id === doc.docId)
    expect(item.outline.approvalActive).toBe(true)
    expect(item.outline.approvalValid).toBe(true)

    await revokeAsUser(ctx, doc.docId, token)
    const list2 = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    item = list2.json().find((d: { id: string }) => d.id === doc.docId)
    expect(item.outline.approvalActive).toBe(false)
    expect(item.outline.approvalValid).toBe(false)
  })
})

describe('制作门禁：Agent 写页面必须携带有效确认来源', () => {
  const opsPayload = (src?: string) => ({
    ops: [{ op: 'setTitle', title: 'x' }],
    ...(src ? { sourceApprovalId: src } : {}),
  })

  async function approvedDoc() {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    const ap = await approveAsUser(ctx, doc.docId, token, {
      baseVersion: state.version, acknowledgeOpenThreads: true, requestId: 'ap-g',
    })
    expect(ap.statusCode).toBe(200)
    const gen = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    expect(gen.statusCode).toBe(200)
    return { doc, approvalId: ap.json().approval.id as string }
  }

  it('无 sourceApprovalId 的 Agent ops 被拒并提示下一步', async () => {
    const { doc } = await docWithOutline()
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().issues.code).toBe('production_source_required')
    expect(res.json().message).toContain('begin')
  })

  it('确认+begin 后 Agent ops 带 approvalId 通过；REST PATCH 同样受控', async () => {
    const { doc, approvalId } = await approvedDoc()
    const ops = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(approvalId),
    })
    expect(ops.statusCode).toBe(200)
    // REST patch 同样需要 sourceApprovalId：缺失被拒，携带则按正常校验走
    const noSrc = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/patch`,
      headers: auth(alice.key),
      payload: { baseVersion: 1, ops: [{ op: 'replace', path: '/title', value: 'y' }] },
    })
    expect(noSrc.statusCode).toBe(409)
    const docNow = (await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`, headers: auth(alice.key),
    })).json()
    const withSrc = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/patch`,
      headers: auth(alice.key),
      payload: { baseVersion: docNow.version, ops: [{ op: 'replace', path: '/title', value: 'y' }], sourceApprovalId: approvalId },
    })
    expect(withSrc.statusCode).toBe(200)
  })

  it('未 begin（有确认但无制作来源）拒绝', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    await approveAsUser(ctx, doc.docId, token, {
      baseVersion: state.version, acknowledgeOpenThreads: true, requestId: 'ap-u',
    })
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(),
    })
    expect(res.statusCode).toBe(409)
  })

  it('撤销确认后旧 approvalId 失效；正文变化后同样失效', async () => {
    const { doc, approvalId } = await approvedDoc()
    await revokeAsUser(ctx, doc.docId, editTokenOf(ctx, doc.docId))
    const revoked = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(approvalId),
    })
    expect(revoked.statusCode).toBe(409)

    // 重新确认+begin，再改正文 → stale
    const token = editTokenOf(ctx, doc.docId)
    const cur = (await getOutline(auth(alice.key), doc.docId)).json()
    const ap2 = await approveAsUser(ctx, doc.docId, token, {
      baseVersion: cur.version, acknowledgeOpenThreads: true, requestId: 'ap-g2',
    })
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    const cur2 = (await getOutline(auth(alice.key), doc.docId)).json()
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: cur2.version, ops: [{ op: 'insertBlocks', blocks: [para('p', '新段落')] }] },
    })
    const stale = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(ap2.json().approval.id),
    })
    expect(stale.statusCode).toBe(409)
  })

  it('仅加批注不使确认失效（contentVersion 不变）', async () => {
    const { doc, approvalId } = await approvedDoc()
    const token = editTokenOf(ctx, doc.docId)
    const cur = (await getOutline(auth(alice.key), doc.docId)).json()
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: cur.version, ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '意见' }] },
    })
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(approvalId),
    })
    expect(res.statusCode).toBe(200)
  })

  it('有大纲的文档：PUT 门禁只拦 Agent（API Key），不拦编辑令牌的网页编辑', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const cur = await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(token),
    })
    const docData = cur.json()
    // 真人网页手动编辑不受 Agent 门禁限制：无确认、无来源也直接写
    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(token),
      payload: { baseVersion: docData.version, doc: { ...docData, title: '浏览器改名' } },
    })
    expect(res.statusCode).toBe(200)
    const renamed = await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(token),
    })
    expect(renamed.json().title).toBe('浏览器改名')
    const version = renamed.json().version as number

    // Agent 用 API Key 走同一 PUT 入口：未确认、无来源被拒
    const agentNoSrc = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: auth(alice.key),
      payload: { baseVersion: version, doc: { ...docData, title: 'agent 改名' } },
    })
    expect(agentNoSrc.statusCode).toBe(409)
    expect(agentNoSrc.json().issues.code).toBe('production_source_required')
    // 伪造一个不存在的来源同样被拒
    const forged = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: auth(alice.key),
      payload: { baseVersion: version, doc: { ...docData, title: 'agent 改名' }, sourceApprovalId: 'forged' },
    })
    expect(forged.statusCode).toBe(409)

    // 已确认但 Agent 未 begin：approval 本身不是制作来源，Agent PUT 仍被拒
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    await approveAsUser(ctx, doc.docId, token, {
      baseVersion: state.version, acknowledgeOpenThreads: true,
    })
    const notBegun = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: auth(alice.key),
      payload: { baseVersion: version, doc: { ...docData, title: 'agent 改名' } },
    })
    expect(notBegun.statusCode).toBe(409)
    expect(notBegun.json().issues.code).toBe('production_source_required')
  })

  it('确认+begin 后 Agent PUT 携带 approvalId 正常写；GET 向网页端下发当前制作来源', async () => {
    const { doc, approvalId } = await approvedDoc()
    const token = editTokenOf(ctx, doc.docId)
    const cur = await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(token),
    })
    const docData = cur.json()
    // 网页端自动保存从 GET /api/docs/:id 取当前有效来源并随 PUT 携带（服务端不校验真人来源）
    expect(docData.outline.generation.approvalId).toBe(approvalId)
    expect(docData.outline.generation.stale).toBe(false)

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: auth(alice.key),
      payload: { baseVersion: docData.version, doc: { ...docData, title: 'agent 改名' }, sourceApprovalId: approvalId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(docData.version + 1)

    // 撤销确认后来源失效：同一 approvalId 的 Agent PUT 被拒；真人网页 PUT 仍不受限
    await revokeAsUser(ctx, doc.docId, token)
    const after = (await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(token),
    })).json()
    expect(after.outline.generation).toBeNull()
    const stale = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: auth(alice.key),
      payload: { baseVersion: after.version, doc: { ...after, title: 'again' }, sourceApprovalId: approvalId },
    })
    expect(stale.statusCode).toBe(409)
    const userPut = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(token),
      payload: { baseVersion: after.version, doc: { ...after, title: 'again' } },
    })
    expect(userPut.statusCode).toBe(200)
  })

  it('无大纲文档 PUT 行为不变', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'legacy-put' })
    const token = editTokenOf(ctx, doc.docId)
    const cur = await ctx.app.inject({
      method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(token),
    })
    const docData = cur.json()
    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(token),
      payload: { baseVersion: docData.version, doc: { ...docData, title: '浏览器改名' } },
    })
    expect(res.statusCode).toBe(200)
  })

  it('无大纲旧文档：Agent ops 无需来源直接通过', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'legacy' })
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key), payload: opsPayload(),
    })
    expect(res.statusCode).toBe(200)
  })

  it('generation requestId 超长被拒', async () => {
    const { doc, approvalId } = await approvedDoc()
    void approvalId
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: { requestId: 'x'.repeat(200) },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('边界回归：replaceBlock 子树批注歧义 + requestId 边界', () => {
  it('replaceBlock 后同批对被替换子树内区块加批注 → 拒绝歧义混合批', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    // 建一个含子区块的列表：list_item 有自己的 blockId
    const list = {
      type: 'bullet_list', attrs: { blockId: 'L1' },
      content: [{ type: 'list_item', attrs: { blockId: 'I1' }, content: [{ type: 'paragraph', attrs: { blockId: 'P1' }, content: [{ type: 'text', text: 'x' }] }] }],
    }
    const cur = (await getOutline(auth(alice.key), doc.docId)).json()
    const ins = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: { baseVersion: cur.version, ops: [{ op: 'insertBlocks', blocks: [list] }] },
    })
    expect(ins.statusCode).toBe(200)
    const v = ins.json().version

    // 同批：替换整个列表 + 对子项 I1 加批注 → 必须拒绝（锚点目标已被替换删除）
    const mixed = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(token),
      payload: {
        baseVersion: v,
        ops: [
          { op: 'replaceBlock', blockId: 'L1', block: { type: 'paragraph', attrs: { blockId: 'P2' }, content: [{ type: 'text', text: 'replaced' }] } },
          { op: 'addComment', anchor: { kind: 'block', blockId: 'I1' }, content: 'ambiguous' },
        ],
      },
    })
    expect(mixed.statusCode).toBe(400)
    expect(mixed.json().message).toContain('修改')
  })

  it('generation requestId 长度边界：128 通过，129 拒绝', async () => {
    const { doc } = await docWithOutline()
    const token = editTokenOf(ctx, doc.docId)
    const state = (await getOutline(auth(alice.key), doc.docId)).json()
    await approveAsUser(ctx, doc.docId, token, {
      baseVersion: state.version, acknowledgeOpenThreads: true,
    })
    const bad = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: { requestId: 'x'.repeat(129) },
    })
    expect(bad.statusCode).toBe(400)
    const ok = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: { requestId: 'y'.repeat(128) },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().approvalId).toBeTruthy()
  })
})
