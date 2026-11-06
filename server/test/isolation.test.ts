import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auth, createDoc, createUser, editTokenOf, makeApp, textElement, tokenHeader, viewTokenOf, type TestContext } from './helpers'

let ctx: TestContext
let alice: { userId: string, key: string }
let bob: { userId: string, key: string }
let doc: { docId: string, version: number, editUrl: string, viewUrl: string }

beforeAll(async () => {
  ctx = await makeApp()
  alice = createUser(ctx, 'alice')
  bob = createUser(ctx, 'bob')
  doc = await createDoc(ctx, alice.key, { slides: [{ id: 's1', elements: [textElement('e1', 'hello')] }] })
})

afterAll(async () => {
  await ctx.app.close()
})

describe('多用户隔离', () => {
  it('用户 B 的 Key 访问用户 A 的文档一律 404', async () => {
    for (const req of [
      { method: 'GET', url: `/api/docs/${doc.docId}` },
      { method: 'PUT', url: `/api/docs/${doc.docId}`, payload: { baseVersion: 1, doc: {} } },
      { method: 'POST', url: `/api/docs/${doc.docId}/ops`, payload: { ops: [{ op: 'setTitle', title: 'x' }] } },
      { method: 'DELETE', url: `/api/docs/${doc.docId}` },
      { method: 'GET', url: `/api/docs/${doc.docId}/revisions` },
    ] as const) {
      const res = await ctx.app.inject({ ...req, headers: auth(bob.key) })
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404)
    }
  })

  it('本人 Key 可以访问', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: auth(alice.key) })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('owner')
    expect(res.json().editUrl).toBeTruthy()
    expect(res.json().viewUrl).toBeTruthy()
  })

  it('只读令牌可以 GET 但不能 PUT / ops', async () => {
    const viewToken = viewTokenOf(ctx, doc.docId)
    const get = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(viewToken) })
    expect(get.statusCode).toBe(200)
    expect(get.json().role).toBe('view')
    expect(get.json().editUrl).toBeUndefined()

    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(viewToken),
      payload: { baseVersion: doc.version, doc: { title: 'x', slides: [] } },
    })
    expect(put.statusCode).toBe(403)

    const ops = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${doc.docId}/ops`,
      headers: tokenHeader(viewToken),
      payload: { ops: [{ op: 'setTitle', title: 'x' }] },
    })
    expect(ops.statusCode).toBe(404)
  })

  it('编辑令牌可以 GET 和 PUT', async () => {
    const editToken = editTokenOf(ctx, doc.docId)
    const get = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(editToken) })
    expect(get.statusCode).toBe(200)
    expect(get.json().role).toBe('edit')
    expect(get.json().viewUrl).toBeTruthy()

    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/docs/${doc.docId}`,
      headers: tokenHeader(editToken),
      payload: { baseVersion: get.json().version, doc: { title: '来自网页', theme: get.json().theme, viewportSize: 1000, viewportRatio: 0.5625, slides: get.json().slides } },
    })
    expect(put.statusCode).toBe(200)
  })

  it('重新生成链接后旧令牌立即失效', async () => {
    const oldToken = editTokenOf(ctx, doc.docId)
    const rotate = await ctx.app.inject({ method: 'POST', url: `/api/docs/${doc.docId}/links/rotate`, headers: auth(alice.key) })
    expect(rotate.statusCode).toBe(200)
    expect(rotate.json().editUrl).toBeTruthy()

    const stale = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(oldToken) })
    expect(stale.statusCode).toBe(401)

    const fresh = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(editTokenOf(ctx, doc.docId)) })
    expect(fresh.statusCode).toBe(200)
  })

  it('停用用户的 Key 返回 401，启用后恢复', async () => {
    ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', alice.userId)
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    expect(denied.statusCode).toBe(401)
    const deniedToken = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(editTokenOf(ctx, doc.docId)) })
    expect(deniedToken.statusCode).toBe(401)

    ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', alice.userId)
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    expect(ok.statusCode).toBe(200)
  })

  it('吊销的 Key 返回 401', async () => {
    const res = ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ?').run(Date.now(), bob.userId)
    expect(res.changes).toBeGreaterThan(0)
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(bob.key) })
    expect(denied.statusCode).toBe(401)
  })

  it('无凭证返回 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/docs' })
    expect(res.statusCode).toBe(401)
  })
})

describe('大纲访问隔离', () => {
  it('他人 Key 访问大纲 REST 一律 404', async () => {
    // bob 的 Key 在前面的用例中已被吊销，另建用户验证越权
    const charlie = createUser(ctx, 'charlie')
    const create = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline`, headers: auth(alice.key), payload: {},
    })
    expect(create.statusCode).toBe(200)
    for (const req of [
      { method: 'GET', url: `/api/docs/${doc.docId}/outline` },
      { method: 'PATCH', url: `/api/docs/${doc.docId}/outline`, payload: { baseVersion: 1, steps: [] } },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`, payload: { baseVersion: 1, ops: [{ op: 'setThreadStatus', threadId: 'x', status: 'open' }] } },
      { method: 'GET', url: `/api/docs/${doc.docId}/outline/feedback` },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`, payload: {} },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`, payload: { baseVersion: 1 } },
      { method: 'DELETE', url: `/api/docs/${doc.docId}/outline/approval` },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/generation`, payload: {} },
    ] as const) {
      const res = await ctx.app.inject({ ...req, headers: auth(charlie.key) })
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404)
    }
  })

  it('view 令牌可读但所有写路径拒绝；edit 令牌可写', async () => {
    const view = viewTokenOf(ctx, doc.docId)
    const get = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}/outline`, headers: tokenHeader(view) })
    expect(get.statusCode).toBe(200)
    expect(get.json().role).toBe('view')
    expect(get.json().outlineEditUrl).toBeUndefined()

    for (const req of [
      { method: 'PATCH', url: `/api/docs/${doc.docId}/outline`, payload: { baseVersion: 1, steps: [{ stepType: 'replace', from: 0, to: 0 }] } },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`, payload: { baseVersion: 1, ops: [{ op: 'deleteBlocks', blockIds: ['x'] }] } },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/feedback`, payload: {} },
      { method: 'POST', url: `/api/docs/${doc.docId}/outline/approval`, payload: { baseVersion: 1 } },
    ] as const) {
      const res = await ctx.app.inject({ ...req, headers: tokenHeader(view) })
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403)
    }

    const edit = editTokenOf(ctx, doc.docId)
    const write = await ctx.app.inject({
      method: 'POST', url: `/api/docs/${doc.docId}/outline/ops`,
      headers: tokenHeader(edit),
      payload: { baseVersion: 1, ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: 'hi' }] },
    })
    expect(write.statusCode).toBe(200)
  })

  it('轮换链接后大纲令牌同样失效；停用用户拒绝', async () => {
    const stale = editTokenOf(ctx, doc.docId)
    await ctx.app.inject({ method: 'POST', url: `/api/docs/${doc.docId}/links/rotate`, headers: auth(alice.key) })
    const denied = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}/outline`, headers: tokenHeader(stale) })
    expect(denied.statusCode).toBe(401)

    ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', alice.userId)
    const disabled = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}/outline`, headers: tokenHeader(editTokenOf(ctx, doc.docId)) })
    expect(disabled.statusCode).toBe(401)
    ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', alice.userId)
  })
})
