// E2E 隔离夹具：每用例独立临时 DATA_DIR（DB+assets），内存随机端口起真实应用。
// 不碰任何真实账号/数据/Key；用例结束仅清理本用例创建的临时目录。
import { test as base, expect, type Page } from 'playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../src/app'
import { createApiKey, signDocToken } from '../src/auth'
import { loadConfig, type AppConfig } from '../src/config'
import { openDb, type Db } from '../src/db'

export interface E2EServer {
  app: FastifyInstance
  db: Db
  config: AppConfig
  dir: string
  baseUrl: string
  apiKey: string
  userId: string
  createDoc(title?: string): Promise<{ docId: string }>
  tokens(docId: string): { edit: string, view: string }
  docUrl(docId: string, tab?: 'outline' | 'ppt', mode?: 'view' | 'edit', token?: string): string
  close(): Promise<void>
}

async function startServer(): Promise<E2EServer> {
  const dir = mkdtempSync(join(tmpdir(), 'pptbase-e2e-'))
  const config = loadConfig({
    DATA_DIR: dir,
    STATIC_DIR: join(__dirname, '../../dist'), // 前置 npm run build 产出的前端
    PUBLIC_BASE_URL: 'http://localhost',
    RATE_LIMIT_PER_MIN: '100000',
  } as NodeJS.ProcessEnv)
  const db = openDb(dir)
  const app = await buildApp(config, db, { logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const userId = nanoid(12)
  db.prepare('INSERT INTO users (id, name, status, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'e2e-user', 'active', Date.now())
  const { key } = createApiKey(db, userId, 'e2e')

  const server: E2EServer = {
    app, db, config, dir, baseUrl, apiKey: key, userId,
    async createDoc(title = 'e2e-doc') {
      const res = await app.inject({
        method: 'POST', url: '/api/docs',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        payload: { title, slides: [] },
      })
      if (res.statusCode !== 200) throw new Error(`createDoc ${res.statusCode}: ${res.body}`)
      return res.json() as { docId: string }
    },
    tokens(docId: string) {
      const row = db.prepare('SELECT link_version FROM documents WHERE id = ?').get(docId) as { link_version: number }
      return {
        edit: signDocToken(config.secret, docId, row.link_version, 'edit'),
        view: signDocToken(config.secret, docId, row.link_version, 'view'),
      }
    },
    docUrl(docId: string, tab = 'ppt', mode?: 'view' | 'edit', token?: string) {
      const t = token ?? server.tokens(docId)[mode === 'view' ? 'view' : 'edit']
      const tabQ = tab === 'outline' ? '&tab=outline' : ''
      const modeQ = mode === 'view' ? '&mode=view' : ''
      return `${baseUrl}/?doc=${docId}${tabQ}${modeQ}#t=${t}`
    },
    async close() {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return server
}

export const test = base.extend<{ server: E2EServer, outlinePage: (docId: string, mode?: 'view' | 'edit') => Promise<Page> }>({
  server: async (_fixtures, use) => {
    const s = await startServer()
    await use(s)
    await s.close()
  },
  // 打开大纲页签（默认编辑令牌）；mode='view' 走只读
  outlinePage: async ({ page, server }, use) => {
    await use(async (docId: string, mode: 'view' | 'edit' = 'edit') => {
      await page.goto(server.docUrl(docId, 'outline', mode))
      await page.waitForSelector('.outline-editor .ProseMirror', { timeout: 15_000 })
      return page
    })
  },
})

// 同一 MCP Client 复用会话完成整个工作流（真实 SDK 传输，非逐调用裸 POST）
export async function connectMcp(server: E2EServer, key = server.apiKey): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${server.baseUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${key}` } } },
  ))
  return client
}

export { expect }
export type { Page }
