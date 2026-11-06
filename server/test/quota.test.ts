import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auth, createDoc, createUser, editTokenOf, makeApp, textElement, tokenHeader, type TestContext } from './helpers'

let ctx: TestContext
let alice: { userId: string, key: string }

beforeAll(async () => {
  ctx = await makeApp({ DEFAULT_QUOTA_DOCS: '2' })
  alice = createUser(ctx, 'alice')
})

afterAll(async () => {
  await ctx.app.close()
})

describe('配额', () => {
  it('超过文档数上限返回 403 quota_exceeded', async () => {
    await createDoc(ctx, alice.key, { title: 'd1' })
    await createDoc(ctx, alice.key, { title: 'd2' })
    const res = await ctx.app.inject({ method: 'POST', url: '/api/docs', headers: auth(alice.key), payload: { title: 'd3' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('quota_exceeded')
  })

  it('文档超过大小限制返回 413 doc_too_large', async () => {
    // 先放开文档数配额，再把单文档配额压到 4KB
    ctx.db.prepare('UPDATE users SET quota_docs = ?, quota_doc_bytes = ? WHERE id = ?').run(100, 4096, alice.userId)
    const doc = await createDoc(ctx, alice.key, { title: 'small' })

    const big = 'x'.repeat(6000)
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key),
      payload: {
        ops: [{ op: 'addSlides', slides: [{ id: 's_big', elements: [textElement('e_big', big)] }] }],
      },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('doc_too_large')
  })
})

describe('大纲配额', () => {
  it('大纲计入文档与快照合计预算，超限拒绝且不留下半条记录', async () => {
    ctx.db.prepare('UPDATE users SET quota_docs = ?, quota_doc_bytes = ? WHERE id = ?').run(100, 6000, alice.userId)
    const doc = await createDoc(ctx, alice.key, { title: 'outline-quota' })
    const create = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline`, headers: auth(alice.key), payload: {},
    })
    expect(create.statusCode).toBe(200)

    const big = 'y'.repeat(8000)
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: auth(alice.key),
      payload: { baseVersion: 1, ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'big' }, content: [{ type: 'text', text: big }] }] }] },
    })
    expect(res.statusCode).toBe(413)
    // 不留半提交
    const row = ctx.db.prepare('SELECT version FROM outlines WHERE doc_id = ?').get(doc.docId) as { version: number }
    expect(row.version).toBe(1)
    const revs = ctx.db.prepare('SELECT COUNT(*) AS n FROM outline_revisions WHERE doc_id = ? AND version > 1').get(doc.docId) as { n: number }
    expect(revs.n).toBe(0)

    // PPT 写入同样受合计预算限制（有大纲 → 先拿到制作来源再过门禁）
    const token = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`,
      headers: tokenHeader(token),
      payload: { baseVersion: 1, acknowledgeOpenThreads: true },
    })
    const gen = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`,
      headers: auth(alice.key), payload: {},
    })
    const ppt = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/ops`,
      headers: auth(alice.key),
      payload: { ops: [{ op: 'addSlides', slides: [{ id: 's_big', elements: [textElement('e_big', big)] }] }], sourceApprovalId: gen.json().approvalId },
    })
    expect(ppt.statusCode).toBe(413)
    ctx.db.prepare('UPDATE users SET quota_doc_bytes = NULL WHERE id = ?').run(alice.userId)
  })
})
