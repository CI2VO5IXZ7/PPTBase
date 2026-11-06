import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ADMIN_COOKIE, setAdminPassword } from '../src/adminAuth'
import type { Db } from '../src/db'
import { auth, createDoc, createUser, makeApp, tokenFromUrl, tokenHeader, type TestContext } from './helpers'

const PASSWORD = 'test-admin-password-1'

interface AdminSession {
  cookie: string
  csrf: string
}

async function adminLogin(ctx: TestContext, password = PASSWORD): Promise<AdminSession> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  const cookieLine = Array.isArray(setCookie) ? setCookie[0] : setCookie!
  const cookie = cookieLine.split(';')[0]
  const { csrfToken } = res.json() as { csrfToken: string }
  return { cookie, csrf: csrfToken }
}

function adminHeaders(s: AdminSession, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf, ...extra }
}

function authed(ctx: TestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, s: AdminSession, payload?: Record<string, unknown>, extra?: Record<string, string>) {
  return ctx.app.inject({ method, url, headers: adminHeaders(s, extra), payload })
}

describe('管理台认证', () => {
  describe('未配置管理员密码', () => {
    let ctx: TestContext
    beforeAll(async () => {
      ctx = await makeApp()
    })
    afterAll(async () => {
      await ctx.app.close()
    })

    it('登录返回 503 且提示配置方式', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'whatever-1234' } })
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('unavailable')
    })

    it('受保护接口一律 401', async () => {
      for (const url of ['/api/admin/session', '/api/admin/overview', '/api/admin/users']) {
        const res = await ctx.app.inject({ method: 'GET', url })
        expect(res.statusCode).toBe(401)
      }
    })
  })

  describe('正常会话', () => {
    let ctx: TestContext
    let session: AdminSession
    beforeAll(async () => {
      ctx = await makeApp({ ADMIN_INITIAL_PASSWORD: PASSWORD })
      session = await adminLogin(ctx)
    })
    afterAll(async () => {
      await ctx.app.close()
    })

    it('登录成功：HttpOnly/SameSite=Strict Cookie + CSRF 令牌', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } })
      expect(res.statusCode).toBe(200)
      const cookie = res.headers['set-cookie'] as string
      expect(cookie).toContain(`${ADMIN_COOKIE}=`)
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Strict')
      expect(cookie).toContain('Path=/api/admin')
      expect(res.json().csrfToken).toBeTruthy()
    })

    it('错误密码统一 401，不区分具体原因', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'wrong-password-1' } })
      expect(res.statusCode).toBe(401)
      expect(res.json().message).toBe('密码错误')
    })

    it('会话保持：带 Cookie 访问 session 返回 CSRF 令牌', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: session.cookie } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ authenticated: true, csrfToken: session.csrf })
    })

    it('普通 MCP 用户 Key 不能访问管理 API', async () => {
      const alice = createUser(ctx, 'mcp-user')
      const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: auth(alice.key) })
      expect(res.statusCode).toBe(401)
    })

    it('伪造 / 过期会话 Cookie 拒绝', async () => {
      const fake = await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/session',
        headers: { cookie: `${ADMIN_COOKIE}=${'a'.repeat(43)}` },
      })
      expect(fake.statusCode).toBe(401)

      // 过期只作用于本条会话，不影响共享的 session
      const throwaway = await adminLogin(ctx)
      const db: Db = ctx.db
      db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE csrf_token = ?')
        .run(Date.now() - 1000, throwaway.csrf)
      const expired = await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/session',
        headers: { cookie: throwaway.cookie },
      })
      expect(expired.statusCode).toBe(401)
    })

    it('写操作缺 CSRF 令牌 / 跨站 Origin 拒绝', async () => {
      const noCsrf = await ctx.app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { cookie: session.cookie },
        payload: { name: 'csrf-test' },
      })
      expect(noCsrf.statusCode).toBe(403)

      const badCsrf = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'csrf-test' }, { 'x-csrf-token': 'bogus' })
      expect(badCsrf.statusCode).toBe(403)

      const evilOrigin = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'csrf-test' }, { origin: 'https://evil.example' })
      expect(evilOrigin.statusCode).toBe(403)
    })

    it('同源 Origin 写操作放行', async () => {
      const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'csrf-ok' }, { origin: 'http://test.local' })
      expect(res.statusCode).toBe(200)
    })

    it('登出后 Cookie 立即失效，Set-Cookie 清空', async () => {
      const s = await adminLogin(ctx)
      const out = await authed(ctx, 'POST', '/api/admin/logout', s)
      expect(out.statusCode).toBe(200)
      expect(out.headers['set-cookie']).toContain('Max-Age=0')

      const after = await ctx.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: s.cookie } })
      expect(after.statusCode).toBe(401)
    })

    it('登录限速：超过阈值返回 429', async () => {
      const limited = await makeApp({ ADMIN_INITIAL_PASSWORD: PASSWORD, ADMIN_LOGIN_RATE_PER_MIN: '3' })
      try {
        for (let i = 0; i < 3; i++) {
          const r = await limited.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'nope-nope-nope' } })
          expect(r.statusCode).toBe(401)
        }
        const r4 = await limited.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } })
        expect(r4.statusCode).toBe(429)
      }
      finally {
        await limited.app.close()
      }
    })

    it('管理 API 响应带 no-store', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: session.cookie } })
      expect(res.headers['cache-control']).toBe('no-store')
    })
  })
})

describe('管理台用户与 Key', () => {
  let ctx: TestContext
  let session: AdminSession
  beforeAll(async () => {
    ctx = await makeApp({ ADMIN_INITIAL_PASSWORD: PASSWORD })
    session = await adminLogin(ctx)
  })
  afterAll(async () => {
    await ctx.app.close()
  })

  it('创建用户 → 列表可见 → 重名 409（天然幂等）', async () => {
    const created = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'alice', note: '主账号' })
    expect(created.statusCode).toBe(200)
    const { user } = created.json() as { user: { id: string, name: string, status: string } }
    expect(user.name).toBe('alice')
    expect(user.status).toBe('active')

    const dup = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'alice' })
    expect(dup.statusCode).toBe(409)

    const list = await authed(ctx, 'GET', '/api/admin/users', session)
    const names = (list.json() as { users: { name: string }[] }).users.map(u => u.name)
    expect(names).toContain('alice')
  })

  it('非法用户名 / 超长字段拒绝', async () => {
    for (const name of ['-bad', 'a'.repeat(65), 'has space!', '']) {
      const res = await authed(ctx, 'POST', '/api/admin/users', session, { name })
      expect(res.statusCode).toBe(400)
    }
    const longNote = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'okname', note: 'x'.repeat(201) })
    expect(longNote.statusCode).toBe(400)
  })

  it('创建 Key：明文只出现一次，列表只露前缀，不落 hash', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'keyuser' })
    const { user } = res.json() as { user: { id: string } }

    const created = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { label: 'Grok Bot', requestId: 'req-1' })
    expect(created.statusCode).toBe(200)
    const body = created.json() as { id: string, key: string, prefix: string }
    expect(body.key).toMatch(/^pk_[A-Za-z0-9_-]{32}$/)
    expect(body.prefix).toBe(body.key.slice(0, 10))

    const list = await authed(ctx, 'GET', `/api/admin/users/${user.id}/keys`, session)
    const rows = (list.json() as { keys: Record<string, unknown>[] }).keys
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: body.id, label: 'Grok Bot', prefix: body.prefix, revokedAt: null })
    // 序列化结果里不得出现明文 key / hash 字段
    expect(list.body).not.toContain(body.key)
    expect(JSON.stringify(rows[0])).not.toContain('hash')
    expect(JSON.stringify(rows[0])).not.toContain(body.key)
  })

  it('requestId 幂等：重复提交不产生第二把 Key', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'idem-user' })
    const { user } = res.json() as { user: { id: string } }

    const first = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { requestId: 'same-req' })
    const again = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { requestId: 'same-req' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ id: first.json().id, duplicated: true })
    expect(again.json()).not.toHaveProperty('key')

    const list = await authed(ctx, 'GET', `/api/admin/users/${user.id}/keys`, session)
    expect((list.json() as { keys: unknown[] }).keys).toHaveLength(1)
  })

  it('requestId 被其他用户占用时 409，绝不跨用户幂等返回', async () => {
    const a = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'rid-owner' })
    const b = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'rid-other' })
    const owner = (a.json() as { user: { id: string } }).user
    const other = (b.json() as { user: { id: string } }).user
    await authed(ctx, 'POST', `/api/admin/users/${owner.id}/keys`, session, { requestId: 'shared-rid' })

    const res = await authed(ctx, 'POST', `/api/admin/users/${other.id}/keys`, session, { requestId: 'shared-rid' })
    expect(res.statusCode).toBe(409)
    const keys = await authed(ctx, 'GET', `/api/admin/users/${other.id}/keys`, session)
    expect((keys.json() as { keys: unknown[] }).keys).toHaveLength(0)
  })

  it('新用户创建后出现在第一页（created_at DESC）', async () => {
    const insert = ctx.db.prepare('INSERT INTO users (id, name, status, created_at) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 25; i++) insert.run(`old-u-${i}`, `old-${i}`, 'active', 1)
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'fresh-newbie' })
    const { user } = res.json() as { user: { id: string } }

    const page1 = (await authed(ctx, 'GET', '/api/admin/users?pageSize=20&page=1', session)).json() as { users: { id: string }[] }
    expect(page1.users).toHaveLength(20)
    expect(page1.users.some(u => u.id === user.id)).toBe(true)
  })

  it('完整闭环：Key 可用 → 吊销失效 → 停用用户全部失效（含文档链接）→ 启用恢复', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'cycle-user' })
    const { user } = res.json() as { user: { id: string } }
    const keyRes = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { label: 'agent-a' })
    const { key } = keyRes.json() as { id: string, key: string }
    const keyId = keyRes.json().id

    // 新 Key 可调 MCP 侧接口
    const doc = await createDoc(ctx, key)
    const docsRes = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key) })
    expect(docsRes.statusCode).toBe(200)

    // 文档链接（用户侧令牌）可用
    const viewToken = tokenFromUrl(doc.viewUrl)
    const viaLink = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(viewToken) })
    expect(viaLink.statusCode).toBe(200)

    // 吊销 Key：该 Key 立即失效
    const revoke = await authed(ctx, 'POST', `/api/admin/keys/${keyId}/revoke`, session)
    expect(revoke.statusCode).toBe(200)
    expect((await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key) })).statusCode).toBe(401)
    // 幂等：再吊销一次返回 alreadyRevoked
    const again = await authed(ctx, 'POST', `/api/admin/keys/${keyId}/revoke`, session)
    expect(again.json()).toMatchObject({ ok: true, alreadyRevoked: true })

    // 第二把 Key 仍有效 —— 吊销不影响其它 Key
    const key2Res = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { label: 'agent-b' })
    const { key: key2 } = key2Res.json() as { key: string }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key2) })).statusCode).toBe(200)

    // 停用用户：全部 Key + 文档链接失效
    await authed(ctx, 'POST', `/api/admin/users/${user.id}/status`, session, { status: 'disabled' })
    expect((await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key2) })).statusCode).toBe(401)
    const linkAfterDisable = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(viewToken) })
    expect(linkAfterDisable.statusCode).toBe(401)

    // 启用恢复：未吊销的 Key 恢复，已吊销的仍失效
    await authed(ctx, 'POST', `/api/admin/users/${user.id}/status`, session, { status: 'active' })
    expect((await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key2) })).statusCode).toBe(200)
    expect((await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(key) })).statusCode).toBe(401)
    const linkBack = await ctx.app.inject({ method: 'GET', url: `/api/docs/${doc.docId}`, headers: tokenHeader(viewToken) })
    expect(linkBack.statusCode).toBe(200)
  })

  it('配额编辑落库并立即生效', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'quota-user' })
    const { user } = res.json() as { user: { id: string } }

    const patch = await authed(ctx, 'PATCH', `/api/admin/users/${user.id}`, session, { quotaDocs: 3, quotaDocMb: 2, quotaExportsPerDay: 5 })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().user.quota).toEqual({ docs: 3, docMb: 2, exportsPerDay: 5 })
    expect(patch.json().user.quotaCustom).toEqual({ docs: 3, docMb: 2, exportsPerDay: 5 })

    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as { quota_docs: number, quota_doc_bytes: number, quota_exports_per_day: number }
    expect(row).toMatchObject({ quota_docs: 3, quota_doc_bytes: 2 * 1024 * 1024, quota_exports_per_day: 5 })

    // null = 恢复继承默认
    const inherit = await authed(ctx, 'PATCH', `/api/admin/users/${user.id}`, session, { quotaDocs: null })
    expect(inherit.json().user.quota.docs).toBe(100)
    expect(inherit.json().user.quotaCustom.docs).toBeNull()

    // 非法值拒绝
    for (const bad of [{ quotaDocs: -1 }, { quotaDocs: 1.5 }, { quotaDocMb: '10' }, {}]) {
      const r = await authed(ctx, 'PATCH', `/api/admin/users/${user.id}`, session, bad)
      expect(r.statusCode).toBe(400)
    }
  })

  it('概览统计是真实数据', async () => {
    const res = await authed(ctx, 'GET', '/api/admin/overview', session)
    const ov = res.json() as { users: { total: number, active: number }, keys: { total: number, active: number }, docs: number }
    const dbUsers = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    const dbKeys = ctx.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL').get() as { n: number }
    const dbDocs = ctx.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
    expect(ov.users.total).toBe(dbUsers.n)
    expect(ov.keys.active).toBe(dbKeys.n)
    expect(ov.docs).toBe(dbDocs.n)
  })

  it('停用用户不能新建 Key；不存在资源 404', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'disabled-user' })
    const { user } = res.json() as { user: { id: string } }
    await authed(ctx, 'POST', `/api/admin/users/${user.id}/status`, session, { status: 'disabled' })
    const keyRes = await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, {})
    expect(keyRes.statusCode).toBe(409)

    expect((await authed(ctx, 'GET', '/api/admin/users/nope/keys', session)).statusCode).toBe(404)
    expect((await authed(ctx, 'POST', '/api/admin/keys/nope/revoke', session)).statusCode).toBe(404)
  })
})

describe('管理台补充行为', () => {
  let ctx: TestContext
  let session: AdminSession
  beforeAll(async () => {
    ctx = await makeApp({ ADMIN_INITIAL_PASSWORD: PASSWORD })
    session = await adminLogin(ctx)
  })
  afterAll(async () => {
    await ctx.app.close()
  })

  it('滑动续期：剩余不足一半时同步重发 Cookie Max-Age（同一 token，CSRF 不变）', async () => {
    const ttl = ctx.config.adminSessionTtlMs
    ctx.db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE csrf_token = ?')
      .run(Date.now() + ttl * 0.4, session.csrf)
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/session',
      headers: { cookie: session.cookie },
    })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie'] as string
    // 同一 token 重新下发，属性与初始 Cookie 一致
    expect(setCookie).toContain(session.cookie)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
    expect(maxAge).toBeGreaterThan(ttl / 1000 * 0.9)
    // CSRF 令牌不变
    expect(res.json().csrfToken).toBe(session.csrf)
  })

  it('密码轮换撤销全部管理员会话，业务 Key 不受影响', async () => {
    const alice = createUser(ctx, 'rotate-biz')
    const other = await adminLogin(ctx)

    setAdminPassword(ctx.db, 'rotated-admin-pass-2')

    // 旧会话立即失效
    const stale = await ctx.app.inject({
      method: 'GET', url: '/api/admin/session', headers: { cookie: other.cookie },
    })
    expect(stale.statusCode).toBe(401)
    // 业务 api_keys 未被误伤：仍能正常鉴权
    const docs = await ctx.app.inject({ method: 'GET', url: '/api/docs', headers: auth(alice.key) })
    expect(docs.statusCode).toBe(200)
    // 新密码可登录，旧密码失败
    const oldTry = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } })
    expect(oldTry.statusCode).toBe(401)
    const newTry = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'rotated-admin-pass-2' } })
    expect(newTry.statusCode).toBe(200)
    // 恢复密码供后续用例
    setAdminPassword(ctx.db, PASSWORD)
    session = await adminLogin(ctx)
  })

  it('概览有效 Key 排除停用用户；activeKeys 与可用状态一致', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'count-user' })
    const { user } = res.json() as { user: { id: string } }
    await authed(ctx, 'POST', `/api/admin/users/${user.id}/keys`, session, { label: 'a' })

    let ov = (await authed(ctx, 'GET', '/api/admin/overview', session)).json() as { keys: { active: number } }
    const before = ov.keys.active

    await authed(ctx, 'POST', `/api/admin/users/${user.id}/status`, session, { status: 'disabled' })
    ov = (await authed(ctx, 'GET', '/api/admin/overview', session)).json() as { keys: { active: number } }
    expect(ov.keys.active).toBe(before - 1)

    const list = (await authed(ctx, 'GET', '/api/admin/users?q=count-user', session)).json() as { users: { activeKeys: number, totalKeys: number }[] }
    expect(list.users[0].activeKeys).toBe(0)
    expect(list.users[0].totalKeys).toBe(1)

    // 恢复后计数一致回升
    await authed(ctx, 'POST', `/api/admin/users/${user.id}/status`, session, { status: 'active' })
    ov = (await authed(ctx, 'GET', '/api/admin/overview', session)).json() as { keys: { active: number } }
    expect(ov.keys.active).toBe(before)
    const list2 = (await authed(ctx, 'GET', '/api/admin/users?q=count-user', session)).json() as { users: { activeKeys: number }[] }
    expect(list2.users[0].activeKeys).toBe(1)
  })

  it('分页返回 metadata，>500 用户完整可翻页', async () => {
    const insert = ctx.db.prepare('INSERT INTO users (id, name, status, created_at) VALUES (?, ?, ?, ?)')
    const seed = ctx.db.transaction(() => {
      for (let i = 0; i < 505; i++) {
        insert.run(`bulk-${i}`, `bulk-${String(i).padStart(4, '0')}`, 'active', 1)
      }
    })
    seed()

    const page1 = (await authed(ctx, 'GET', '/api/admin/users?pageSize=20&page=1', session)).json() as { users: unknown[], total: number, page: number, pageSize: number }
    expect(page1.users).toHaveLength(20)
    expect(page1.total).toBeGreaterThanOrEqual(505)
    expect(page1.page).toBe(1)
    expect(page1.pageSize).toBe(20)

    const last = (await authed(ctx, 'GET', '/api/admin/users?pageSize=200&page=3', session)).json() as { users: unknown[], total: number }
    expect(last.users.length).toBeGreaterThan(0)
    expect(last.users.length).toBeLessThanOrEqual(200)

    const filtered = (await authed(ctx, 'GET', '/api/admin/users?q=bulk-&pageSize=200&page=3', session)).json() as { users: unknown[], total: number }
    expect(filtered.total).toBe(505)
    expect(filtered.users).toHaveLength(105)

    const bad = await authed(ctx, 'GET', '/api/admin/users?page=0', session)
    expect(bad.statusCode).toBe(400)
  })

  it('配额 PATCH 只落提供字段，未提供字段保持原状', async () => {
    const res = await authed(ctx, 'POST', '/api/admin/users', session, { name: 'quota-partial' })
    const { user } = res.json() as { user: { id: string } }
    await authed(ctx, 'PATCH', `/api/admin/users/${user.id}`, session, { quotaDocMb: 25 })

    // 只 PATCH docs：docMb 自定义保留，exports 仍为继承
    const r = await authed(ctx, 'PATCH', `/api/admin/users/${user.id}`, session, { quotaDocs: 3 })
    expect(r.statusCode).toBe(200)
    expect(r.json().user.quotaCustom).toEqual({ docs: 3, docMb: 25, exportsPerDay: null })
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as { quota_doc_bytes: number | null, quota_exports_per_day: number | null }
    expect(row.quota_doc_bytes).toBe(25 * 1024 * 1024)
    expect(row.quota_exports_per_day).toBeNull()
  })
})
