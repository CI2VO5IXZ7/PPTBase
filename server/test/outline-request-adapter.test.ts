// DocRequestError 透传结构化 issues（元数据重试/未解决批注覆盖依赖这些字段）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocRequestError, docRequest } from '../../src/services/document'

afterEach(() => vi.unstubAllGlobals())

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('docRequest 错误适配', () => {
  it('409 保留 issues：currentVersion/currentContentVersion/openThreads', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes(409, {
      error: 'conflict', message: '版本冲突',
      issues: { currentVersion: 5, currentContentVersion: 4, openThreads: 2 },
    }))))
    const err = await docRequest('/api/docs/x').then(
      () => {
        throw new Error('unreachable')
      },
      (e: unknown) => e,
    ) as DocRequestError
    expect(err).toBeInstanceOf(DocRequestError)
    expect(err.status).toBe(409)
    expect(err.currentVersion).toBe(5)
    expect(err.issues?.currentContentVersion).toBe(4)
    expect(err.issues?.openThreads).toBe(2)
  })

  it('非 JSON/空错误体不丢状态码与兜底消息', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('oops', { status: 500 }))))
    const err = await docRequest('/api/docs/x').then(
      () => {
        throw new Error('unreachable')
      },
      (e: unknown) => e,
    ) as DocRequestError
    expect(err.status).toBe(500)
    expect(err.issues).toBeUndefined()
    expect(err.message).toContain('500')
  })

  it('成功响应返回解析后的 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes(200, { ok: true }))))
    const body = await docRequest<{ ok: boolean }>('/api/docs/x')
    expect(body.ok).toBe(true)
  })
})
