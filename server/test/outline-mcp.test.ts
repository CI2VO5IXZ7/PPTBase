// 大纲 MCP 工具真实传输测试：SDK Client + StreamableHTTPClientTransport → POST /mcp。
// ⚠️ 需要监听端口 —— 当前运行边界禁止启动监听 socket，整文件 describe.skip 跳过，
//     待独立批准后移除 skip 执行。工具注册与 schema 由 typecheck/build 静态保证。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auth, createDoc, createUser, makeApp, type TestContext } from './helpers'

describe.skip('大纲 MCP（真实 HTTP，需单独批准运行）', () => {
  let ctx: TestContext
  let alice: { userId: string, key: string }
  let client: Client
  let baseUrl: string

  beforeAll(async () => {
    ctx = await makeApp()
    alice = createUser(ctx, 'alice')
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

  it('工具目录包含七个大纲工具且名称精确', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const n of [
      'create_outline', 'get_outline', 'edit_outline', 'get_outline_feedback',
      'complete_outline_feedback', 'begin_presentation_from_outline', 'get_outline_asset',
    ]) expect(names).toContain(n)
  })

  it('create/get/edit 走通最小流程', async () => {
    const doc = await createDoc(ctx, alice.key, { title: 'mcp' })
    const created = await client.callTool({ name: 'create_outline', arguments: { docId: doc.docId } })
    const state = JSON.parse((created.content as { text: string }[])[0].text)
    expect(state.version).toBe(1)

    const read = await client.callTool({ name: 'get_outline', arguments: { docId: doc.docId } })
    const outline = JSON.parse((read.content as { text: string }[])[0].text)
    expect(outline.content.type).toBe('doc')
    expect(outline.readable.lines).toBeInstanceOf(Array)

    const edited = await client.callTool({
      name: 'edit_outline',
      arguments: {
        docId: doc.docId,
        baseVersion: outline.meta.version,
        ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'hello' }] }] }],
      },
    })
    expect(JSON.parse((edited.content as { text: string }[])[0].text).version).toBeGreaterThan(1)
  })
})
