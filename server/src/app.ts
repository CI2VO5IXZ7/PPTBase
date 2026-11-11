import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'

import { seedAdminPassword } from './adminAuth'
import { rateLimitKey } from './auth'
import type { AppConfig } from './config'
import { openDb, type Db } from './db'
import { createDocService } from './docs/service'
import { createOutlineService } from './outline/service'
import { AppError } from './errors'
import { mcpRoutes } from './mcp/server'
import { closeBrowser } from './render/browser'
import { RenderQueue } from './render/queue'
import { adminRoutes } from './routes/admin'
import { assetsRoutes } from './routes/assets'
import { docsRoutes } from './routes/docs'
import { exportsRoutes } from './routes/exports'
import { outlineRoutes } from './routes/outline'

export async function buildApp(config: AppConfig, db?: Db, opts?: { logger?: boolean }): Promise<FastifyInstance> {
  // 测试时可直接传入已打开的 db；否则按 DATA_DIR 打开并随 app 关闭
  const ownDb = db ?? openDb(config.dataDir)
  const outlineService = createOutlineService({ db: ownDb, config })
  const service = createDocService({ db: ownDb, config, outlineBytes: outlineService.storageBytes, outlineGate: outlineService.assertProductionSource })
  const renderQueue = new RenderQueue(config.exportConcurrency)

  const app = Fastify({
    logger: opts?.logger ?? true,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: config.trustProxy,
  })

  // 首次启动播种管理员密码：库里已有密码时不再覆盖（轮换密码用 pptist-admin passwd）
  if (config.adminInitialPassword && seedAdminPassword(ownDb, config.adminInitialPassword)) {
    app.log.info('管理员密码已按 ADMIN_INITIAL_PASSWORD 初始化；该变量仅在无密码时生效')
  }
  app.addHook('onClose', (instance, done) => {
    if (!db) ownDb.close()
    void closeBrowser().then(() => done())
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.issues !== undefined ? { issues: error.issues } : {}),
      })
      return
    }
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) request.log.error(error)
    const code = statusCode === 429
      ? 'rate_limited'
      : statusCode === 400 ? 'validation'
        : statusCode >= 500 ? 'internal_error' : 'bad_request'
    reply.status(statusCode).send({
      error: code,
      message: statusCode >= 500 ? '服务器内部错误' : error.message,
    })
  })

  await app.register(rateLimit, {
    max: config.rateLimitPerMin,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  })

  // 管理台相关响应不缓存；admin 页面再叠加 CSP/禁 frame 等安全头。
  // 先百分号解码，再折叠 . / ..。/./admin.html、/%2e/admin.html、/static/../admin.html
  // 都会落到管理页；只比原始 URL 会漏掉 CSP / X-Frame-Options。
  app.addHook('onSend', (req, reply, _payload, done) => {
    const path = normalizeRequestPath(req.raw.url)
    const isAdminApi = path.startsWith('/api/admin/')
    const isAdminPage = path === '/admin' || path === '/admin/' || path === '/admin.html'
    if (!isAdminApi && !isAdminPage) {
      done()
      return
    }
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'same-origin')
    if (isAdminPage) {
      reply.header('x-frame-options', 'DENY')
      reply.header('content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    }
    done()
  })

  app.get('/api/health', () => ({ ok: true }))

  await app.register(adminRoutes({ db: ownDb, config }))
  await app.register(docsRoutes({ db: ownDb, config, service, outline: outlineService }))
  await app.register(outlineRoutes({ db: ownDb, config, service: outlineService, docService: service }))
  await app.register(assetsRoutes({ db: ownDb, config }))
  await app.register(exportsRoutes({ db: ownDb, config, queue: renderQueue }))
  await app.register(mcpRoutes({ db: ownDb, config, service, outline: outlineService, queue: renderQueue }))

  // 生产模式：托管前端构建产物。只认包含 index.html 的目录，
  // 开发模式（server 目录下 ./dist 是 esbuild 产物，没有 index.html）自动跳过
  if (existsSync(join(config.staticDir, 'index.html'))) {
    const hasAdminPage = existsSync(join(config.staticDir, 'admin.html'))
    await app.register(fastifyStatic, { root: config.staticDir })

    // SPA fallback：GET 且不属于 API / MCP / 资产 / 导出路径时回退 index.html；
    // 这些保留路径走不到这里时（无匹配路由）仍返回 JSON 404
    app.setNotFoundHandler((req, reply) => {
      const path = normalizeRequestPath(req.raw.url)
      // 折叠后的路径不再含 `..`，但原始解码路径里的 `..` 仍要拒绝，避免回退把穿越请求当成站内页面。
      const decoded = decodeRequestPath(req.raw.url)
      const traverses = decoded.split('/').includes('..') || path.split('/').includes('..')
      const reserved = path === '/api' || path.startsWith('/api/')
        || path === '/mcp' || path.startsWith('/mcp/')
        || path.startsWith('/assets/') || path.startsWith('/exports/')
        || path === '/static' || path.startsWith('/static/')
      if (req.method === 'GET' && !reserved && !traverses) {
        // 管理台独立入口页（vite 多页构建产物 admin.html）；产物缺失时回退主页面
        if (hasAdminPage) {
          // /admin/ 归一化到 /admin：相对资源 ./static/… 在 /admin/ 下会错指到 /admin/static/…
          if (path === '/admin/') return reply.redirect('/admin', 302)
          if (path === '/admin') return reply.sendFile('admin.html')
          // /admin/* 既不是页面也不是资源：不回退 SPA，避免把错误 URL 当 bundle
          if (path.startsWith('/admin/')) {
            return reply.status(404).send({ error: 'not_found', message: '资源不存在' })
          }
        }
        return reply.sendFile('index.html')
      }
      reply.status(404).send({ error: 'not_found', message: '资源不存在' })
    })
  }

  return app
}

function decodeRequestPath(rawUrl: string | undefined): string {
  const raw = (rawUrl ?? '/').split('?')[0] || '/'
  let path = raw
  try {
    path = decodeURIComponent(raw)
  }
  catch {
    path = raw
  }
  if (!path.startsWith('/')) path = `/${path}`
  return path
}

/** 查询串剥离、百分号解码，再折叠 `.` / `..`。解码失败时保留原路径再折叠。
 * 绝对路径上的 `..` 在根处夹住，结果仍在站点根内，不会指向静态目录的父路径。
 */
export function normalizeRequestPath(rawUrl: string | undefined): string {
  const path = decodeRequestPath(rawUrl)
  const normalized = posix.normalize(path)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}
