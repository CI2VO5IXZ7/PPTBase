import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'

import type { AppConfig } from './config'

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 12 * 1024 * 1024,
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) request.log.error(error)
    const code = statusCode === 429
      ? 'rate_limited'
      : statusCode >= 500 ? 'internal_error' : 'bad_request'
    reply.status(statusCode).send({
      error: code,
      message: statusCode >= 500 ? '服务器内部错误' : error.message,
    })
  })

  await app.register(rateLimit, {
    max: config.rateLimitPerMin,
    timeWindow: '1 minute',
  })

  app.get('/api/health', () => ({ ok: true }))

  // M1 起在此挂载路由模块：docs / assets / exports / mcp

  return app
}
