import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auth, createUser, makeApp, PNG_DATA_URL, type TestContext } from './helpers'

// §八 M5：生产模式下服务端用 @fastify/static 托管前端构建产物（vite assetsDir=static），
// SPA fallback 只回退非 API 路径；/assets /exports /mcp /api 仍走各自路由
let ctx: TestContext
let staticDir = ''

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'pptist-static-'))
  writeFileSync(join(staticDir, '..', 'outside-leak.txt'), 'SECRET_OUTSIDE_STATIC_ROOT')
  mkdirSync(join(staticDir, 'static'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body>pptist-index</body></html>')
  writeFileSync(join(staticDir, 'admin.html'), '<!doctype html><html><body>pptist-admin <script src="./static/admin-x.js"></script></body></html>')
  writeFileSync(join(staticDir, 'static', 'index-abc123.js'), 'console.log("bundle")')
  writeFileSync(join(staticDir, 'static', 'admin-x.js'), 'console.log("admin-bundle")')
  ctx = await makeApp({ STATIC_DIR: staticDir })
})

afterAll(async () => {
  await ctx.app.close()
  try {
    rmSync(join(staticDir, '..', 'outside-leak.txt'), { force: true })
    rmSync(staticDir, { recursive: true, force: true })
  }
  catch { /* ignore */ }
})

describe('静态前端托管', () => {
  it('GET / 返回 index.html', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('pptist-index')
  })

  it('GET /static/... 返回打包资源', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/static/index-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('console.log("bundle")')
  })

  it('SPA fallback：GET 未匹配的深层前端路由返回 index.html', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/some/deep/route' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('pptist-index')
  })

  it('保留路径不回退：/api /mcp /assets /exports 仍走原逻辑', async () => {
    const api = await ctx.app.inject({ method: 'GET', url: '/api/nothing' })
    expect(api.statusCode).toBe(404)
    expect(api.json()).toMatchObject({ error: 'not_found' })

    const mcp = await ctx.app.inject({ method: 'GET', url: '/mcp' })
    expect(mcp.statusCode).toBe(405)

    const mcpPost = await ctx.app.inject({ method: 'POST', url: '/mcp' })
    expect(mcpPost.statusCode).toBe(401)

    const asset = await ctx.app.inject({ method: 'GET', url: '/assets/nonexistent.png' })
    expect(asset.statusCode).toBe(404)
    expect(asset.json()).toMatchObject({ error: 'not_found' })

    const exportFile = await ctx.app.inject({ method: 'GET', url: '/exports/nonexistent.zip' })
    expect(exportFile.statusCode).toBe(404)
    expect(exportFile.json()).toMatchObject({ error: 'not_found' })
  })

  it('GET /assets/:file 资产路由与静态托管共存', async () => {
    const alice = createUser(ctx, 'alice')
    const upload = await ctx.app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: auth(alice.key),
      payload: { data: PNG_DATA_URL },
    })
    expect(upload.statusCode).toBe(200)
    const { url } = upload.json() as { url: string }

    const res = await ctx.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
  })

  it('非 GET 请求未匹配时返回 JSON 404 而不是 index.html', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/some/deep/route' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  it('GET /admin 返回 admin.html（相对 ./static 资源可解析）', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('pptist-admin')
    // admin.html 内相对引用解析为 /static/... 而非 /admin/static/...
    const asset = await ctx.app.inject({ method: 'GET', url: '/static/admin-x.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.body).toBe('console.log("admin-bundle")')
  })

  it('GET /admin/ 302 归一化到 /admin，浏览器最终拿到页面与资源', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/admin')
    const final = await ctx.app.inject({ method: 'GET', url: res.headers.location as string })
    expect(final.statusCode).toBe(200)
    expect(final.body).toContain('pptist-admin')
  })

  it('GET /admin/* 非页面不回退 SPA：/admin/static/x → 404 JSON', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/static/fake.js' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('路径穿越：明文 .. 不得读出 static root 外文件', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/static/../outside-leak.txt' })
    expect(res.body).not.toBe('SECRET_OUTSIDE_STATIC_ROOT')
    expect(res.body).not.toContain('SECRET_OUTSIDE_STATIC_ROOT')
  })

  it('路径穿越：编码 %2E%2E 不得读出 static root 外文件', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/static/%2E%2E/outside-leak.txt',
    })
    expect(res.body).not.toContain('SECRET_OUTSIDE_STATIC_ROOT')
    if (res.statusCode === 200) {
      expect(res.body).not.toBe('console.log("bundle")')
    }
    else {
      expect([403, 404]).toContain(res.statusCode)
    }
  })

  it('非规范斜杠：//static/... 不得因双斜杠越权读盘', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '//static/index-abc123.js' })
    expect(res.body).not.toContain('SECRET_OUTSIDE_STATIC_ROOT')
    if (res.statusCode === 200) expect(res.body).toBe('console.log("bundle")')
    else expect([403, 404]).toContain(res.statusCode)
  })

  it('目录列表：GET /static/ 不得返回 HTML 目录索引', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/static/' })
    expect(res.body).not.toMatch(/<a href=/i)
    expect(res.body).not.toMatch(/Directory listing/i)
  })
})

describe('无前端产物时（开发模式）', () => {
  it('GET / 返回 404，不启用静态托管', async () => {
    const bare = await makeApp()
    const res = await bare.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBeTruthy()
    await bare.app.close()
  })
})
