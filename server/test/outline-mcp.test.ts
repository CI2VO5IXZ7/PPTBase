// 大纲 MCP 工具真实传输测试：SDK Client + StreamableHTTPClientTransport → POST /mcp。
// ⚠️ 本文件整组 describe：app.listen 属于监听 socket，需单独批准后
//    移除 skip 运行。覆盖：工具发现、多轮快照/complete 独立、资产归属+图片内容块、
//    确认来源门禁、旧来源失效、无大纲旧项目兼容。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { approveAsUser, auth, createDoc, createOutline, createUser, editTokenOf, makeApp, PNG_DATA_URL, tokenHeader, type TestContext } from './helpers'

describe('大纲 MCP（真实 HTTP，需单独批准运行）', () => {
  let ctx: TestContext
  let alice: { userId: string, key: string }
  let bob: { userId: string, key: string }
  let client: Client
  let baseUrl: string

  const outlineVersion = async (docId: string) => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/docs/${docId}/outline`, headers: auth(alice.key) })
    return (r.json() as { version: number }).version
  }
  const callJson = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    const item = (res.content as { type: string, text?: string }[])[0]
    return { body: item.text ? JSON.parse(item.text) : res.content, isError: res.isError === true, raw: res.content }
  }

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_PER_MIN: '100000' })
    alice = createUser(ctx, 'alice')
    bob = createUser(ctx, 'bob')
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const address = ctx.app.server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: auth(alice.key) },
    })
    client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close()
    await ctx.app.close()
  })

  it('工具目录含全部七个工具名且旧工具仍在', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const n of [
      'create_outline', 'get_outline', 'edit_outline', 'get_outline_feedback',
      'complete_outline_feedback', 'begin_presentation_from_outline', 'get_outline_asset',
      'create_presentation', 'get_presentation', 'add_slides', 'batch_edit',
    ]) expect(names).toContain(n)
  })

  it('create/get/edit 最小流程 + 编辑链接', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp' })
    const created = await callJson('create_outline', { docId: doc.docId })
    expect(created.body.version).toBe(1)
    expect(created.body.outlineEditUrl).toContain('tab=outline')
    expect(created.body.outlineViewUrl).toContain('mode=view')

    const read = await callJson('get_outline', { docId: doc.docId })
    expect(read.body.content.type).toBe('doc')
    expect(read.body.readable.lines.length).toBeGreaterThan(0)
    expect(read.body.assets).toBeInstanceOf(Array)

    const edited = await callJson('edit_outline', {
      docId: doc.docId, baseVersion: read.body.meta.version,
      ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'hello' }] }] }],
    })
    expect(edited.body.version).toBeGreaterThan(read.body.meta.version)
  })

  it('多轮反馈快照独立：complete A 不影响 B', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-fb' })
    await createOutline(ctx, alice.key, doc.docId)
    const token = editTokenOf(ctx, doc.docId)
    // 第一轮
    await ctx.app.inject({ method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`, headers: tokenHeader(token), payload: { requestId: 'r1' } })
    // 改正文 → 第二轮（A 快照不变）
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`, headers: tokenHeader(token),
      payload: { baseVersion: await outlineVersion(doc.docId), ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'x' }, content: [{ type: 'text', text: 'v2' }] }] }] },
    })
    await ctx.app.inject({ method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`, headers: tokenHeader(token), payload: { requestId: 'r2' } })
    const list = await callJson('get_outline_feedback', { docId: doc.docId })
    expect(list.body.submissions.length).toBe(2)
    // 新提交把旧的 pending 标记 superseded：B(最新) 在前
    const [b, a] = list.body.submissions
    expect(a.status).toBe('superseded')
    expect(b.status).toBe('pending')
    const detail = await callJson('get_outline_feedback', { docId: doc.docId, submissionId: b.id })
    expect(detail.body.submission.id).toBe(b.id)
    expect(detail.body.snapshot).toBeTruthy()
    // 完成最新轮 B：A 保持 superseded，不受影响；pending 清空
    const done = await callJson('complete_outline_feedback', { docId: doc.docId, submissionId: b.id, note: 'done' })
    expect(done.isError).toBe(false)
    const list2 = await callJson('get_outline_feedback', { docId: doc.docId, status: 'pending' })
    expect(list2.body.submissions.length).toBe(0)
    const all = await callJson('get_outline_feedback', { docId: doc.docId })
    expect(all.body.submissions.find((x: { id: string }) => x.id === a.id).status).toBe('superseded')
  })

  it('确认来源门禁：写页面必须带有效 approvalId；旧来源失效；无大纲旧项目直通', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-gate' })
    await createOutline(ctx, alice.key, doc.docId)
    const blocked = await callJson('add_slides', { docId: doc.docId, slides: [{ id: 's', elements: [] }] })
    expect(blocked.isError).toBe(true)
    expect(blocked.body.message).toContain('确认来源')

    const token = editTokenOf(ctx, doc.docId)
    await approveAsUser(ctx, doc.docId, token, { baseVersion: 1, acknowledgeOpenThreads: true })
    const begin = await callJson('begin_presentation_from_outline', { docId: doc.docId })
    const ok = await callJson('add_slides', { docId: doc.docId, slides: [{ id: 's', elements: [] }], sourceApprovalId: begin.body.approvalId })
    expect(ok.isError).toBe(false)

    // 正文变化 → 旧来源失效
    const opsR = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`, headers: tokenHeader(token),
      payload: { baseVersion: await outlineVersion(doc.docId), ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'y' }, content: [{ type: 'text', text: 'changed' }] }] }] },
    })
    expect(opsR.statusCode).toBe(200)
    const stale = await callJson('add_slides', { docId: doc.docId, slides: [{ id: 's2', elements: [] }], sourceApprovalId: begin.body.approvalId })
    expect(stale.isError).toBe(true)

    // 无大纲旧项目：无来源也直通
    const legacy = await createDoc(ctx, alice.key, { title: 'legacy' })
    const free = await callJson('add_slides', { docId: legacy.docId, slides: [{ id: 's', elements: [] }] })
    expect(free.isError).toBe(false)
  })

  it('get_outline_asset：归属+引用校验 + 图片内容块；他人资产拒绝', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-asset' })
    // 上传资产并引用进大纲
    const up = await ctx.app.inject({
      method: 'POST', url: '/api/assets', headers: auth(alice.key),
      payload: { data: PNG_DATA_URL },
    })
    expect(up.statusCode).toBe(200)
    const asset = up.json()
    await createOutline(ctx, alice.key, doc.docId)
    const imgOps = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`, headers: auth(alice.key),
      payload: { baseVersion: await outlineVersion(doc.docId), ops: [{ op: 'insertBlocks', blocks: [{ type: 'image', attrs: { blockId: 'img1', src: asset.url, alt: '', caption: 'c', usage: 'include', usageDescription: 'd' } }] }] },
    })
    expect(imgOps.statusCode).toBe(200)
    const got = await client.callTool({ name: 'get_outline_asset', arguments: { docId: doc.docId, assetId: asset.id } })
    const block = (got.content as { type: string }[])[0]
    expect(block.type).toBe('image')
    const denied = await callJson('get_outline_asset', { docId: doc.docId, assetId: 'foreign-asset-id' })
    expect(denied.isError).toBe(true)
    void bob
  })
})
