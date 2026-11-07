import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../src/app'
import { createApiKey, signDocToken } from '../src/auth'
import { loadConfig, type AppConfig } from '../src/config'
import { openDb, type Db } from '../src/db'

export interface TestContext {
  app: FastifyInstance
  db: Db
  config: AppConfig
  dir: string
}

// 每个测试文件一个独立 DATA_DIR
export async function makeApp(env: Record<string, string> = {}): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'pptist-test-'))
  const config = loadConfig({ DATA_DIR: dir, PUBLIC_BASE_URL: 'http://test.local', ...env } as NodeJS.ProcessEnv)
  const db = openDb(dir)
  const app = await buildApp(config, db, { logger: false })
  return { app, db, config, dir }
}

export function createUser(ctx: TestContext, name: string): { userId: string, keyId: string, key: string } {
  const userId = nanoid(12)
  ctx.db.prepare('INSERT INTO users (id, name, status, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, name, 'active', Date.now())
  const { id, key } = createApiKey(ctx.db, userId)
  return { userId, keyId: id, key }
}

export function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` }
}

export async function createDoc(ctx: TestContext, key: string, body: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/docs',
    headers: auth(key),
    payload: body,
  })
  if (res.statusCode !== 200) throw new Error(`createDoc 失败: ${res.statusCode} ${res.body}`)
  return res.json() as { docId: string, version: number, editUrl: string, viewUrl: string }
}

export function tokenFromUrl(url: string): string {
  return new URL(url).hash.slice(3) // '#t=...'
}

export function editTokenOf(ctx: TestContext, docId: string): string {
  const row = ctx.db.prepare('SELECT link_version FROM documents WHERE id = ?').get(docId) as { link_version: number }
  return signDocToken(ctx.config.secret, docId, row.link_version, 'edit')
}

export function viewTokenOf(ctx: TestContext, docId: string): string {
  const row = ctx.db.prepare('SELECT link_version FROM documents WHERE id = ?').get(docId) as { link_version: number }
  return signDocToken(ctx.config.secret, docId, row.link_version, 'view')
}

export function tokenHeader(token: string): { 'x-doc-token': string } {
  return { 'x-doc-token': token }
}

export function textElement(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'text',
    id,
    left: 10,
    top: 10,
    width: 200,
    height: 50,
    rotate: 0,
    content: `<p>${text}</p>`,
    defaultFontName: '',
    defaultColor: '#000',
    ...extra,
  }
}

export function slide(id: string, elements: unknown[] = []) {
  return { id, elements }
}

// 1x1 PNG
export const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export async function createOutline(ctx: TestContext, key: string, docId: string, body: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/docs/${docId}/outline`,
    headers: auth(key),
    payload: body,
  })
  return res
}

// 真人确认路径：网页端先持编辑令牌 + 同源 Origin 申请网页确认会话，
// 再凭会话（X-Confirm-Session）申请一次性确认凭证，最后携带
// X-Confirm-Token 调 approve/revoke（编辑令牌本体不能确认也不能领票）
export async function confirmSession(ctx: TestContext, docId: string, token: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/docs/${docId}/outline/approval/session`,
    headers: { ...tokenHeader(token), origin: ctx.config.publicBaseUrl },
  })
  if (res.statusCode !== 200) throw new Error(`confirmSession 失败: ${res.statusCode} ${res.body}`)
  return (res.json() as { confirmSession: string }).confirmSession
}

export async function confirmTicket(ctx: TestContext, docId: string, token: string, action: 'approve' | 'revoke' = 'approve', session?: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/docs/${docId}/outline/approval/ticket`,
    headers: { ...tokenHeader(token), 'x-confirm-session': session ?? await confirmSession(ctx, docId, token) },
    payload: { action },
  })
  if (res.statusCode !== 200) throw new Error(`confirmTicket 失败: ${res.statusCode} ${res.body}`)
  return (res.json() as { confirmToken: string }).confirmToken
}

export async function approveAsUser(ctx: TestContext, docId: string, token: string, payload: Record<string, unknown>, ticket?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/docs/${docId}/outline/approval`,
    headers: { ...tokenHeader(token), 'x-confirm-token': ticket ?? await confirmTicket(ctx, docId, token, 'approve') },
    payload,
  })
}

export async function revokeAsUser(ctx: TestContext, docId: string, token: string, ticket?: string) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/docs/${docId}/outline/approval`,
    headers: { ...tokenHeader(token), 'x-confirm-token': ticket ?? await confirmTicket(ctx, docId, token, 'revoke') },
  })
}

// 大纲正文 JSON 构造工具（blockId 可在测试中显式指定，服务端也会归一化补齐）
export function para(id: string, text: string) {
  return {
    type: 'paragraph',
    attrs: { blockId: id },
    content: text ? [{ type: 'text', text }] : [],
  }
}

export function heading(id: string, level: number, text: string) {
  return {
    type: 'heading',
    attrs: { blockId: id, level },
    content: text ? [{ type: 'text', text }] : [],
  }
}

export function imageBlock(id: string, src: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'image',
    attrs: { blockId: id, src, alt: '', caption: '', usage: 'reference', usageDescription: '', ...extra },
  }
}

export function outlineDocJson(...blocks: unknown[]) {
  return { type: 'doc', content: blocks }
}
