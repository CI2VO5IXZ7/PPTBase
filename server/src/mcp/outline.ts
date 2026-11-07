// 大纲工具：与 PPT 工具同一个 /mcp 端点、同一 Key、同一工具集合。
// 服务层逻辑在 outline/service.ts，这里只做参数适配与结果包装。

import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { outlineLinks, type DocAccess } from '../auth'
import type { AppConfig } from '../config'
import type { AssetRow, Db, DocumentRow } from '../db'
import { AppError } from '../errors'
import { outlineOpsSchema, parseBody, type OutlineOpsBody } from '../outline/schema'
import type { OutlineService } from '../outline/service'
import { assetManifest, readableText } from '../../../src/utils/outline/serialize'
import { outlineSchema } from '../../../src/utils/outline/schema'

interface OutlineMcpCtx {
  db: Db
  config: AppConfig
  outline: OutlineService
  ownerId: string
  keyId: string
}

interface TextResult {
  [key: string]: unknown
  content: ({ type: 'text', text: string } | { type: 'image', data: string, mimeType: string })[]
  isError?: boolean
}

const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_READABLE_LINES = 200

export function registerOutlineTools(server: McpServer, ctx: OutlineMcpCtx): void {
  const { db, config, outline, ownerId, keyId } = ctx

  const ok = (data: unknown): TextResult => {
    // 已构造好的 MCP 结果（如 image 内容块）原样返回，不得再包成 text
    if (data && typeof data === 'object' && Array.isArray((data as { content?: unknown[] }).content)) {
      return data as TextResult
    }
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
  }
  const call = <A>(fn: (args: A) => unknown | Promise<unknown>) =>
    async (args: A): Promise<TextResult> => {
      try {
        return ok(await fn(args))
      }
      catch (err) {
        const body: Record<string, unknown> = err instanceof AppError
          ? { error: err.code, message: err.message, ...(err.issues !== undefined ? { issues: err.issues } : {}) }
          : { error: 'internal_error', message: `服务器内部错误: ${(err as Error).message}` }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true }
      }
    }

  function ownDoc(docId: string): { row: DocumentRow, access: DocAccess } {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as DocumentRow | undefined
    if (!row || row.owner_id !== ownerId) throw AppError.notFound('文档不存在或不属于当前账号')
    return { row, access: { ownerId, role: 'owner', author: 'agent', keyId, linkVersion: row.link_version } }
  }

  const docIdField = z.string().min(1).describe('文档 id')
  const sourceField = z.looseObject({
    type: z.enum(['current', 'submission', 'approval']).default('current'),
    id: z.string().optional().describe('submission/approval 的 id，current 不需要'),
  }).optional().describe('读取哪个固定快照；默认读取当前大纲')

  // 读取指定快照（current/submission/approval），返回 {content,threads,assets,version...}
  function readSource(docId: string, access: DocAccess, source?: { type?: string, id?: string }) {
    const type = source?.type ?? 'current'
    if (type === 'submission') {
      if (!source?.id) throw AppError.validation('读取提交快照需要 submission id')
      const { submission, snapshot } = outline.getFeedback(docId, source.id)
      return { kind: 'submission' as const, meta: submission, snapshot }
    }
    if (type === 'approval') {
      const row = source?.id
        ? db.prepare('SELECT * FROM outline_approvals WHERE doc_id = ? AND id = ?').get(docId, source.id) as { snapshot: Buffer, id: string, content_version: number, status: string, created_at: number } | undefined
        : db.prepare(`SELECT a.* FROM outline_approvals a JOIN outlines o ON o.active_approval_id = a.id WHERE o.doc_id = ?`).get(docId) as { snapshot: Buffer, id: string, content_version: number, status: string, created_at: number } | undefined
      if (!row) throw AppError.notFound('确认稿不存在')
      return {
        kind: 'approval' as const,
        meta: { id: row.id, contentVersion: row.content_version, status: row.status, createdAt: row.created_at },
        snapshot: JSON.parse((gunzipSync(row.snapshot)).toString()),
      }
    }
    const state = outline.get(access, docId)
    return {
      kind: 'current' as const,
      meta: { version: state.version, contentVersion: state.contentVersion, status: state.status },
      snapshot: { content: state.content, threads: state.threads },
    }
  }

  function readableBlocks(content: unknown, cursor?: number, limit?: number) {
    const doc = outlineSchema.nodeFromJSON(content)
    const lines = readableText(doc).split('\n')
    const from = Math.max(0, cursor ?? 0)
    const max = Math.min(Math.max(limit ?? 80, 1), MAX_READABLE_LINES)
    const page = lines.slice(from, from + max)
    return {
      lines: page,
      totalLines: lines.length,
      hasMore: from + max < lines.length,
      ...(from + max < lines.length ? { nextCursor: from + max } : {}),
    }
  }

  server.registerTool('create_outline', {
    description: '为已有文档初始化制作前大纲（每个文档一份）。返回大纲编辑/只读链接发给用户；已存在返回 existing:true 不覆盖。',
    inputSchema: {
      docId: docIdField,
      requestId: z.string().min(1).max(128).optional().describe('幂等键'),
      content: z.looseObject({ type: z.literal('doc') }).optional().describe('初始正文（受限 PM JSON），不传创建空段落'),
    },
  }, call(({ docId, requestId, content }: { docId: string, requestId?: string, content?: { type: 'doc' } }) => {
    const { access, row } = ownDoc(docId)
    const result = outline.init(access, docId, { requestId, content })
    const links = outlineLinks(config, row)
    return {
      docId, existing: result.existing, version: result.version, contentVersion: result.contentVersion,
      outlineEditUrl: links.outlineEditUrl, outlineViewUrl: links.outlineViewUrl,
    }
  }))

  server.registerTool('get_outline', {
    description: '读取大纲：默认当前版本；source={type:"submission"|"approval",id} 读取不可变提交/确认快照。返回完整 PM JSON、带区块 ID 的可读文本（分页）、线程、素材清单与状态。',
    inputSchema: {
      docId: docIdField,
      source: sourceField,
      cursor: z.number().int().min(0).optional().describe('可读文本行偏移'),
      limit: z.number().int().min(1).max(200).optional().describe('可读文本行数，默认 80'),
    },
  }, call(({ docId, source, cursor, limit }: { docId: string, source?: { type?: 'current' | 'submission' | 'approval', id?: string }, cursor?: number, limit?: number }) => {
    const { access } = ownDoc(docId)
    const { kind, meta, snapshot } = readSource(docId, access, source as never)
    const content = (snapshot as { content: unknown }).content
    const doc = outlineSchema.nodeFromJSON(content)
    return {
      docId, source: kind, meta,
      content,
      threads: (snapshot as { threads: unknown }).threads,
      // 素材清单始终按所读快照正文实时推导，不依赖快照是否冗余存储
      assets: assetManifest(doc),
      readable: readableBlocks(content, cursor, limit),
    }
  }))

  server.registerTool('edit_outline', {
    description: '按稳定 blockId 对大纲做区块/批注操作：insertBlocks(before/after)、replaceBlock、updateBlockAttrs、deleteBlocks、moveBlock、addComment、replyComment、setThreadStatus。baseVersion 必填（当前 version）。',
    inputSchema: {
      docId: docIdField,
      ops: z.array(z.looseObject({ op: z.string() })).min(1).describe('大纲操作数组'),
      baseVersion: z.number().int().min(0).describe('读取到的当前 version'),
      requestId: z.string().min(1).max(128).optional().describe('幂等键'),
    },
  }, call(({ docId, ops, baseVersion, requestId }: { docId: string, ops: unknown[], baseVersion: number, requestId?: string }) =>
    outline.applyOps(ownDoc(docId).access, docId,
      parseBody(outlineOpsSchema, { ops, baseVersion, requestId }, '大纲操作请求') as OutlineOpsBody)))

  server.registerTool('get_outline_feedback', {
    description: '查询用户提交的反馈轮次：不传 submissionId 返回列表（status/cursor 分页），传了返回该轮不可变快照（正文+批注+素材）。提交后草稿可继续变化，快照不变。',
    inputSchema: {
      docId: docIdField,
      submissionId: z.string().optional(),
      status: z.enum(['pending', 'handled', 'superseded']).optional(),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, call(({ docId, submissionId, status, cursor, limit }: { docId: string, submissionId?: string, status?: 'pending' | 'handled' | 'superseded', cursor?: number, limit?: number }) => {
    const { access } = ownDoc(docId)
    if (submissionId) {
      const { submission, snapshot } = outline.getFeedback(docId, submissionId)
      return { submission, snapshot, currentVersion: outline.get(access, docId).version }
    }
    return { ...outline.listFeedback(docId, { status, cursor, limit }), currentVersion: outline.get(access, docId).version }
  }))

  server.registerTool('complete_outline_feedback', {
    description: '标记指定反馈轮次处理完成（不改变其他轮次，不自动解决批注，不等于用户确认）。',
    inputSchema: {
      docId: docIdField,
      submissionId: z.string(),
      note: z.string().max(2000).optional().describe('处理结果说明'),
      requestId: z.string().min(1).max(128).optional(),
    },
  }, call(({ docId, submissionId, note, requestId }: { docId: string, submissionId: string, note?: string, requestId?: string }) =>
    outline.completeFeedback(ownDoc(docId).access, docId, submissionId, { note, requestId })))

  server.registerTool('begin_presentation_from_outline', {
    description: '依据用户的有效大纲确认开始一次制作：校验确认仍有效且正文未偏离，返回 approvalId/contentVersion/当前 PPT version 作为后续写页面工具的 sourceApprovalId 来源。',
    inputSchema: { docId: docIdField, requestId: z.string().min(1).max(128).optional() },
  }, call(({ docId, requestId }: { docId: string, requestId?: string }) =>
    outline.beginGeneration(ownDoc(docId).access, docId, requestId)))

  server.registerTool('get_outline_asset', {
    description: '读取大纲引用的图片内容（返回 image 内容块）。仅限属于当前账号且被当前/提交/确认快照引用的 /assets/ 资产；外链与未引用资产拒绝。',
    inputSchema: {
      docId: docIdField,
      assetId: z.string().describe('图片资产 id（素材清单中的 assetId）'),
      source: sourceField,
    },
  }, call(({ docId, assetId, source }: { docId: string, assetId: string, source?: { type?: 'current' | 'submission' | 'approval', id?: string } }) => {
    const { access } = ownDoc(docId)
    const { snapshot } = readSource(docId, access, source as never)
    const doc = outlineSchema.nodeFromJSON((snapshot as { content: unknown }).content)
    // 精确资产身份：所读版本必须存在 /assets/{assetId}.{ext} 的图片引用（禁止子串匹配与任意路径）
    const referenced = assetManifest(doc).some(a => a.assetId === assetId)
    if (!referenced) {
      throw AppError.forbidden('该图片未被当前读取的大纲版本引用')
    }
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined
    if (!row || row.owner_id !== ownerId) throw AppError.forbidden('图片资产不存在或不属于当前账号')
    if (row.size > MAX_ASSET_BYTES) throw AppError.docTooLarge(`图片过大（>${MAX_ASSET_BYTES} 字节），请分段处理`)
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[row.mime]
    if (!ext) throw AppError.forbidden('资产类型不是受支持的图片')
    const file = join(config.dataDir, 'assets', `${row.id}.${ext}`)
    if (!existsSync(file)) throw AppError.notFound('图片文件不存在')
    const buf = readFileSync(file)
    if (buf.length > MAX_ASSET_BYTES) throw AppError.docTooLarge('图片文件超限')
    const meta = assetManifest(doc).find(a => a.assetId === assetId) ?? {}
    return {
      content: [
        { type: 'image' as const, data: buf.toString('base64'), mimeType: row.mime },
        { type: 'text' as const, text: JSON.stringify({ assetId, mime: row.mime, size: row.size, ...meta }, null, 2) },
      ],
    }
  }))
}
