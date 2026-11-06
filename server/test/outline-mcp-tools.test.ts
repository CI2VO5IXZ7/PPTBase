// 大纲 MCP 工具契约测试（离线）：直接构造 buildMcpServer 并调用注册的 handler，
// 不经过任何监听端口。仅验证注册名、schema 字段与 handler 行为，
// 不声称证明真实 HTTP 传输（见 outline-mcp.test.ts，需单独批准运行）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildMcpServer } from '../src/mcp/tools'
import { createDocService } from '../src/docs/service'
import { createOutlineService } from '../src/outline/service'
import type { RenderQueue } from '../src/render/queue'
import { createDoc, createOutline, createUser, editTokenOf, makeApp, tokenHeader, type TestContext } from './helpers'

const OUTLINE_TOOLS = [
  'create_outline', 'get_outline', 'edit_outline', 'get_outline_feedback',
  'complete_outline_feedback', 'begin_presentation_from_outline', 'get_outline_asset',
]

interface RegisteredTool {
  inputSchema?: { shape?: Record<string, unknown> }
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{ content: { type: string, text?: string }[], isError?: boolean }>
}

let ctx: TestContext
let alice: { userId: string, key: string }
let tools: Record<string, RegisteredTool>

beforeAll(async () => {
  ctx = await makeApp({ RATE_LIMIT_PER_MIN: '100000' })
  alice = createUser(ctx, 'alice')
  const outline = createOutlineService({ db: ctx.db, config: ctx.config })
  const service = createDocService({
    db: ctx.db, config: ctx.config,
    outlineBytes: outline.storageBytes, outlineGate: outline.assertProductionSource,
  })
  const server = buildMcpServer({
    db: ctx.db, config: ctx.config, service, outline,
    queue: {} as RenderQueue, ownerId: alice.userId, keyId: 'test-key',
  })
  tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools
})

afterAll(async () => {
  await ctx.app.close()
})

const callTool = (name: string, args: Record<string, unknown>) => tools[name].handler(args, {})

describe('大纲 MCP 工具注册（离线）', () => {
  it('恰好注册七个工具，名称精确', () => {
    for (const n of OUTLINE_TOOLS) expect(tools[n], n).toBeTruthy()
  })

  it('所有写页面工具含 sourceApprovalId 字段', () => {
    for (const n of ['add_slides', 'update_slide', 'delete_slides', 'move_slide', 'add_elements', 'update_elements', 'delete_elements', 'batch_edit', 'set_theme']) {
      const shape = tools[n]?.inputSchema?.shape ?? {}
      expect(Object.keys(shape), n).toContain('sourceApprovalId')
    }
  })

  it('create_outline 返回大纲编辑/只读链接', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-tools' })
    const res = await callTool('create_outline', { docId: doc.docId })
    const body = JSON.parse(res.content[0].text!)
    expect(body.version).toBe(1)
    expect(body.outlineEditUrl).toContain(`doc=${doc.docId}&tab=outline`)
    expect(body.outlineEditUrl).toContain('#t=')
    expect(body.outlineViewUrl).toContain('mode=view')
  })

  it('get_outline 返回完整 JSON、可读分页与推导的素材清单', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-get' })
    await createOutline(ctx, alice.key, doc.docId)
    const res = await callTool('get_outline', { docId: doc.docId })
    const body = JSON.parse(res.content[0].text!)
    expect(body.content.type).toBe('doc')
    expect(body.readable.hasMore).toBe(false)
    expect(body.assets).toBeInstanceOf(Array)
    expect(body.meta.version).toBe(1)
  })

  it('edit_outline 走 ops 校验并推进版本；缺 sourceApprovalId 时写页面被拒', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-edit' })
    await createOutline(ctx, alice.key, doc.docId)
    const edited = await callTool('edit_outline', {
      docId: doc.docId, baseVersion: 1,
      ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'm1' }, content: [{ type: 'text', text: 'hi' }] }] }],
    })
    expect(edited.isError).toBeFalsy()
    const blocked = await callTool('add_slides', {
      docId: doc.docId, slides: [{ id: 's1', elements: [] }],
    })
    expect(blocked.isError).toBe(true)
    expect(JSON.parse(blocked.content[0].text!).message).toContain('确认来源')
  })

  it('begin 后写页面带 approvalId 通过；feedback/complete 不影响 A/B 快照', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-flow' })
    await createOutline(ctx, alice.key, doc.docId)
    const token = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token), payload: { baseVersion: 1, acknowledgeOpenThreads: true },
    })
    const begin = await callTool('begin_presentation_from_outline', { docId: doc.docId })
    const b = JSON.parse(begin.content[0].text!)
    expect(b.approvalId).toBeTruthy()
    expect(b.stale).toBe(false)
    const write = await callTool('add_slides', {
      docId: doc.docId, slides: [{ id: 's1', elements: [] }], sourceApprovalId: b.approvalId,
    })
    expect(write.isError).toBeFalsy()

    // 反馈轮次独立：complete A 不清除 B
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`,
      headers: tokenHeader(token), payload: { requestId: 'f1' },
    })
    const list = await callTool('get_outline_feedback', { docId: doc.docId })
    const subs = JSON.parse(list.content[0].text!).submissions
    const done = await callTool('complete_outline_feedback', { docId: doc.docId, submissionId: subs[0].id })
    expect(done.isError).toBeFalsy()
  })

  it('get_outline_asset 拒绝未引用/外链/他人资产', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp-asset' })
    await createOutline(ctx, alice.key, doc.docId)
    const res = await callTool('get_outline_asset', { docId: doc.docId, assetId: 'not-referenced' })
    expect(res.isError).toBe(true)
  })
})
