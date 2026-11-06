// 大纲服务：当前状态读写、CAS 版本控制、幂等、修订、不可变提交/确认快照、
// 制作来源记录、配额/保留、级联删除由 DB 外键承担。
// 所有写路径共用同一流水线：校验 → 应用 transforms → blockId 归一化 →
// data: 图片转存 → 约束/所有权检查 → 锚点映射 → 原子事务 → 提交后 SSE。

import { gunzipSync, gzipSync } from 'node:zlib'
import { nanoid } from 'nanoid'
import type { Node as PMNode } from 'prosemirror-model'
import { Step, Transform } from 'prosemirror-transform'

import type {
  OutlineAnchor,
  OutlineApproval,
  OutlineNodeJson,
  OutlineOp,
  OutlineSubmission,
  OutlineThread,
} from '../../../src/types/outline'
import { createAnchor, mapThreads } from '../../../src/utils/outline/anchors'
import {
  defaultOutlineDocJson,
  normalizeBlockIdsJson,
  OUTLINE_LIMITS,
  outlineSchema,
} from '../../../src/utils/outline/schema'
import { assetManifest, changeSummary } from '../../../src/utils/outline/serialize'
import { dataUrlToAsset } from '../assets/store'
import type { DocAccess } from '../auth'
import type { AppConfig } from '../config'
import type {
  Db,
  DocumentRow,
  OutlineApprovalRow,
  OutlineRevisionRow,
  OutlineRow,
  OutlineSubmissionRow,
  UserRow,
} from '../db'
import { AppError } from '../errors'
import { publishOutline } from '../events'
import { isDataImageUrl } from '../schema/sanitize'
import { applyContentOps, isContentOp } from './ops'
import { requestHash, validateJsonAttrs, validateOutlineDoc, type OutlineApprovalBody, type OutlineCompleteBody, type OutlineFeedbackBody, type OutlineInitBody, type OutlineOpsBody, type OutlinePatchBody } from './schema'

const SNAPSHOT_KEEP = 100

export interface OutlineServiceDeps {
  db: Db
  config: AppConfig
}

export function createOutlineService({ db, config }: OutlineServiceDeps) {
  function mustGetDoc(docId: string): DocumentRow {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as DocumentRow | undefined
    if (!row) throw AppError.notFound()
    return row
  }

  function mustGetOutline(docId: string): OutlineRow {
    const row = db.prepare('SELECT * FROM outlines WHERE doc_id = ?').get(docId) as OutlineRow | undefined
    if (!row) throw AppError.notFound('大纲不存在')
    return row
  }

  function ownerQuota(ownerId: string): { docs: number, docBytes: number } {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId) as UserRow | undefined
    return {
      docs: user?.quota_docs ?? config.defaultQuotaDocs,
      docBytes: user?.quota_doc_bytes ?? config.defaultQuotaDocBytes,
    }
  }

  function parseContent(json: string): PMNode {
    try {
      return outlineSchema.nodeFromJSON(JSON.parse(json))
    }
    catch {
      throw new Error('大纲正文损坏')
    }
  }

  function parseThreads(json: string): OutlineThread[] {
    return JSON.parse(json) as OutlineThread[]
  }

  // 写入流水线：data: 图片转存 → blockId 归一化 → 重新解析 → 约束/所有权校验
  function finalizeJson(json: { type: string, [k: string]: unknown }, ownerId: string): { doc: PMNode, normalized: boolean } {
    let normalized = convertDataImages(json, ownerId)
    validateJsonAttrs(json as OutlineNodeJson)
    if (normalizeBlockIdsJson(json as never, () => nanoid(10))) normalized = true
    let doc: PMNode
    try {
      doc = outlineSchema.nodeFromJSON(json)
    }
    catch (err) {
      throw AppError.validation(`大纲结构非法: ${(err as Error).message}`)
    }
    try {
      validateOutlineDoc(db, doc, ownerId)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      throw AppError.validation(`大纲内容非法: ${(err as Error).message}`)
    }
    return { doc, normalized }
  }

  // data:image/* 的 image src 统一转存为站内资产（与 PPT 管线一致）
  function convertDataImages(json: unknown, ownerId: string): boolean {
    let changed = false
    const visit = (node: OutlineNodeJson): void => {
      if (node.type === 'image' && node.attrs && typeof node.attrs.src === 'string' && isDataImageUrl(node.attrs.src)) {
        const saved = dataUrlToAsset(db, config, ownerId, node.attrs.src)
        if (saved) {
          node.attrs.src = saved.url
          changed = true
        }
      }
      if (Array.isArray(node.content)) for (const child of node.content) visit(child)
    }
    visit(json as OutlineNodeJson)
    return changed
  }

  // 快照：正文＋线程＋素材清单的不可变 gzip 副本
  function makeSnapshot(contentJson: string, threadsJson: string): Buffer {
    const doc = parseContent(contentJson)
    return gzipSync(JSON.stringify({
      content: JSON.parse(contentJson),
      threads: JSON.parse(threadsJson),
      assets: assetManifest(doc),
    }))
  }

  function readSnapshot(row: { snapshot: Buffer }): { content: unknown, threads: OutlineThread[], assets: unknown } {
    return JSON.parse(gunzipSync(row.snapshot).toString()) as never
  }

  // 大纲占用的受控存储：当前正文/线程 + 全部保留快照（供 PPT 写路径合计预算调用）
  function storageBytes(docId: string): number {
    const row = db.prepare('SELECT size FROM outlines WHERE doc_id = ?').get(docId) as { size: number } | undefined
    const rev = db.prepare('SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS n FROM outline_revisions WHERE doc_id = ?').get(docId) as { n: number }
    const sub = db.prepare('SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS n FROM outline_submissions WHERE doc_id = ?').get(docId) as { n: number }
    const app = db.prepare('SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS n FROM outline_approvals WHERE doc_id = ?').get(docId) as { n: number }
    return (row?.size ?? 0) + rev.n + sub.n + app.n
  }

  function checkBudget(ownerId: string, docId: string, newSize: number, newSnapshotBytes: number): void {
    const docRow = mustGetDoc(docId)
    const quota = ownerQuota(ownerId)
    // 当前 PPT + 新大纲状态 + 既有保留快照 + 本次新快照
    const existing = storageBytes(docId)
    const current = db.prepare('SELECT size FROM outlines WHERE doc_id = ?').get(docId) as { size: number } | undefined
    const total = docRow.size + (existing - (current?.size ?? 0)) + newSize + newSnapshotBytes
    if (total > quota.docBytes) {
      throw AppError.docTooLarge(`文档与大纲合计超过大小限制（${Math.round(quota.docBytes / 1024 / 1024)}MB）`)
    }
  }

  // requestId 幂等：同键同负载直接返回首次结果；同键不同负载报冲突
  function dedupeRevision(docId: string, requestId: string | undefined, hash: string): OutlineRevisionRow | undefined {
    if (!requestId) return undefined
    const rev = db.prepare('SELECT * FROM outline_revisions WHERE doc_id = ? AND request_id = ?').get(docId, requestId) as OutlineRevisionRow | undefined
    if (!rev) return undefined
    if (rev.request_hash !== hash) {
      throw AppError.conflict('相同的 requestId 已用于不同内容的请求', { requestId })
    }
    return rev
  }

  function requireVersion(row: OutlineRow, baseVersion: number): void {
    if (baseVersion !== row.version) {
      throw AppError.conflict(
        `baseVersion=${baseVersion} 与当前大纲版本 ${row.version} 不一致，请先拉取最新大纲`,
        { currentVersion: row.version, currentContentVersion: row.content_version },
      )
    }
  }

  interface CommitInput {
    docId: string
    access: DocAccess
    contentJson: string
    threadsJson: string
    contentChanged: boolean
    summary: string[]
    requestId?: string
    requestHash?: string
    // 事务内附加写入（提交/确认/制作来源等）
    extra?: () => void
  }

  // 原子写：大纲行（带 version 乐观锁）＋修订＋快照保留＋附加写入；提交后才发事件
  function commitOutline(input: CommitInput): { version: number, contentVersion: number } {
    const row = mustGetOutline(input.docId)
    const version = row.version + 1
    const contentVersion = row.content_version + (input.contentChanged ? 1 : 0)
    const size = Buffer.byteLength(input.contentJson) + Buffer.byteLength(input.threadsJson)
    const snapshot = gzipSync(JSON.stringify({
      content: JSON.parse(input.contentJson),
      threads: JSON.parse(input.threadsJson),
    }))
    checkBudget(mustGetDoc(input.docId).owner_id, input.docId, size, snapshot.length)
    const now = Date.now()

    const write = db.transaction(() => {
      const res = db.prepare(
        `UPDATE outlines SET content = ?, threads = ?, version = ?, content_version = ?, size = ?, updated_at = ?
         WHERE doc_id = ? AND version = ?`
      ).run(input.contentJson, input.threadsJson, version, contentVersion, size, now, input.docId, row.version)
      if (!res.changes) {
        throw AppError.conflict('大纲版本已被其他写入更新，请重试', { currentVersion: row.version })
      }
      db.prepare(
        `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(input.docId, version, contentVersion, input.access.author, input.access.keyId ?? null,
        JSON.stringify(input.summary), snapshot, input.requestId ?? null, input.requestHash ?? null, now)
      input.extra?.()
      // 保留策略：最近 SNAPSHOT_KEEP 个版本之外的普通修订清理快照；
      // 被提交/确认引用的版本不可被普通清理误删
      db.prepare(
        `UPDATE outline_revisions SET snapshot = NULL
         WHERE doc_id = ? AND version <= ? AND snapshot IS NOT NULL
           AND version NOT IN (SELECT version FROM outline_submissions WHERE doc_id = ?)
           AND version NOT IN (SELECT version FROM outline_approvals WHERE doc_id = ?)`
      ).run(input.docId, version - SNAPSHOT_KEEP, input.docId, input.docId)
    })
    write()

    publishOutline(input.docId, {
      version,
      contentVersion,
      author: input.access.author,
      summary: input.summary,
    })
    return { version, contentVersion }
  }

  function applyTransform(
    row: OutlineRow,
    build: (doc: PMNode) => { tr: Transform, modifiedIds?: Set<string> },
  ): { newDoc: PMNode, contentJson: string, threads: OutlineThread[], threadsJson: string, contentChanged: boolean, threadsChanged: boolean, normalized: boolean, modifiedIds: Set<string> } {
    const doc = parseContent(row.content)
    const { tr, modifiedIds } = build(doc)
    const json = tr.doc.toJSON() as { type: string, [k: string]: unknown }
    const { doc: newDoc, normalized } = finalizeJson(json, mustGetDoc(row.doc_id).owner_id)
    const threads = parseThreads(row.threads)
    mapThreads(threads, tr.mapping, newDoc)
    const contentJson = JSON.stringify(newDoc.toJSON())
    const threadsJson = JSON.stringify(threads)
    return {
      newDoc,
      contentJson,
      threads,
      threadsJson,
      // attrs 是空原型对象，isDeepStrictEqual 不可用于此；
      // 两侧都经同一 toJSON 管线，直接比规范化 JSON 字符串
      contentChanged: contentJson !== row.content,
      threadsChanged: threadsJson !== row.threads,
      normalized,
      modifiedIds: modifiedIds ?? new Set(),
    }
  }

  function applyThreadOps(threads: OutlineThread[], ops: OutlineOp[], doc: PMNode, access: DocAccess, contentVersion: number, modifiedIds: Set<string>): string[] {
    const summary: string[] = []
    const find = (threadId: string, i: number): OutlineThread => {
      const thread = threads.find(t => t.id === threadId)
      if (!thread) throw AppError.validation(`ops[${i}]: 找不到批注 threadId=${threadId}`)
      return thread
    }
    ops.forEach((op, i) => {
      if (isContentOp(op)) return
      if (op.op === 'addComment') {
        if (threads.length >= OUTLINE_LIMITS.maxThreads) {
          throw AppError.validation(`批注数量超过上限 ${OUTLINE_LIMITS.maxThreads}`)
        }
        // 同批次中目标区块已被改写/删除时锚点语义歧义，拒绝混合提交
        const anchorIds = op.anchor.kind === 'document' ? []
          : op.anchor.kind === 'textRange' ? op.anchor.fragments.map(f => f.blockId)
            : [op.anchor.blockId]
        const hit = anchorIds.find(id => modifiedIds.has(id))
        if (hit) {
          throw AppError.validation(`ops[${i}]: 锚点区块 ${hit} 在本批次中已被修改，请分开提交批注`)
        }
        let anchor: OutlineAnchor
        try {
          anchor = createAnchor(doc, op.anchor, contentVersion)
        }
        catch (err) {
          throw AppError.validation(`ops[${i}]: ${(err as Error).message}`)
        }
        threads.push({
          id: nanoid(10),
          status: 'open',
          detached: false,
          anchor,
          messages: [{ id: nanoid(10), author: access.author, content: op.content, createdAt: Date.now() }],
          createdAt: Date.now(),
        })
        summary.push('新增批注')
      }
      else if (op.op === 'replyComment') {
        const thread = find(op.threadId, i)
        if (thread.messages.length >= OUTLINE_LIMITS.maxMessagesPerThread) {
          throw AppError.validation(`ops[${i}]: 批注回复数量超过上限`)
        }
        thread.messages.push({ id: nanoid(10), author: access.author, content: op.content, createdAt: Date.now() })
        if (thread.status === 'resolved') {
          // 新回复不自动重开：状态只由显式操作改变
        }
        summary.push('回复批注')
      }
      else if (op.op === 'setThreadStatus') {
        const thread = find(op.threadId, i)
        if (thread.status !== op.status) {
          thread.status = op.status
          thread.resolvedAt = op.status === 'resolved' ? Date.now() : undefined
          summary.push(op.status === 'resolved' ? '标记批注已解决' : '重新打开批注')
        }
      }
    })
    return summary
  }

  function outlineState(docId: string) {
    const row = mustGetOutline(docId)
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM outline_submissions WHERE doc_id = ? AND status = 'pending'`
    ).get(docId) as { n: number }
    const approval = row.active_approval_id
      ? db.prepare('SELECT * FROM outline_approvals WHERE id = ?').get(row.active_approval_id) as OutlineApprovalRow | undefined
      : undefined
    return { row, pending: pending.n, approval }
  }

  return {
    // 初始化：已存在返回 existing:true（幂等可重试），不覆盖
    init(access: DocAccess, docId: string, body: OutlineInitBody) {
      mustGetDoc(docId)
      const hash = body.requestId ? requestHash('init', { content: body.content ?? null }) : null
      const existing = db.prepare('SELECT doc_id FROM outlines WHERE doc_id = ?').get(docId)
      if (existing) {
        // requestId 已用过：相同负载返回既有结果，不同负载报冲突（以修订表 request_hash 为准）
        if (body.requestId) {
          const rev = db.prepare('SELECT request_hash FROM outline_revisions WHERE doc_id = ? AND request_id = ?')
            .get(docId, body.requestId) as { request_hash: string | null } | undefined
          if (rev && rev.request_hash !== hash) {
            throw AppError.conflict('相同的 requestId 已用于不同内容的请求', { requestId: body.requestId })
          }
        }
        return { existing: true, ...get(access, docId) }
      }

      const docRow = mustGetDoc(docId)
      const raw = (body.content ?? defaultOutlineDocJson()) as { type: string, [k: string]: unknown }
      const { doc } = finalizeJson(raw, docRow.owner_id)
      const contentJson = JSON.stringify(doc.toJSON())
      const threadsJson = '[]'
      const size = Buffer.byteLength(contentJson)
      const snapshot = gzipSync(JSON.stringify({ content: JSON.parse(contentJson), threads: [] }))
      const quota = ownerQuota(docRow.owner_id)
      if (docRow.size + size + snapshot.length > quota.docBytes) {
        throw AppError.docTooLarge('文档与大纲合计超过大小限制')
      }
      const now = Date.now()
      const write = db.transaction(() => {
        db.prepare(
          `INSERT INTO outlines (doc_id, content, threads, version, content_version, size, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1, ?, ?, ?)`
        ).run(docId, contentJson, threadsJson, size, now, now)
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`
        ).run(docId, access.author, access.keyId ?? null, JSON.stringify(['初始化大纲']), snapshot, body.requestId ?? null, hash, now)
      })
      try {
        write()
      }
      catch (err) {
        // 并发/重试撞唯一键：返回已有大纲而不是 500
        if (body.requestId && String((err as Error).message).includes('UNIQUE')) {
          return { existing: true, ...get(access, docId) }
        }
        throw err
      }
      publishOutline(docId, { version: 1, contentVersion: 1, author: access.author, summary: ['初始化大纲'] })
      return { existing: false, ...get(access, docId) }
    },

    // 网页 steps 写入：baseVersion 必须等于当前 version
    applySteps(access: DocAccess, docId: string, body: OutlinePatchBody) {
      const row = mustGetOutline(docId)
      const hash = requestHash('steps', { baseVersion: body.baseVersion, steps: body.steps })
      const deduped = dedupeRevision(docId, body.requestId, hash)
      if (deduped) {
        return { version: deduped.version, contentVersion: deduped.content_version, unchanged: true, deduplicated: true }
      }
      requireVersion(row, body.baseVersion)

      const result = applyTransform(row, doc => {
        const tr = new Transform(doc)
        for (const [i, raw] of body.steps.entries()) {
          let step: Step
          try {
            step = Step.fromJSON(outlineSchema, raw)
          }
          catch (err) {
            throw AppError.validation(`steps[${i}] 反序列化失败: ${(err as Error).message}`)
          }
          try {
            tr.step(step)
          }
          catch (err) {
            throw AppError.validation(`steps[${i}] 无法应用（位置或结构不匹配）: ${(err as Error).message}`)
          }
        }
        return { tr }
      })

      if (!result.contentChanged && !result.threadsChanged) {
        return { version: row.version, contentVersion: row.content_version, unchanged: true, deduplicated: false }
      }
      const summary = result.contentChanged ? changeSummary(parseContent(row.content), result.newDoc) : ['批注锚点更新']
      const committed = commitOutline({
        docId, access,
        contentJson: result.contentJson,
        threadsJson: result.threadsJson,
        contentChanged: result.contentChanged,
        summary,
        requestId: body.requestId,
        requestHash: hash,
      })
      return { ...committed, unchanged: false, normalized: result.normalized, deduplicated: false }
    },

    // 结构化区块/线程操作：同样 CAS＋幂等，编译为 transforms
    applyOps(access: DocAccess, docId: string, body: OutlineOpsBody) {
      const row = mustGetOutline(docId)
      const hash = requestHash('ops', { baseVersion: body.baseVersion, ops: body.ops })
      const deduped = dedupeRevision(docId, body.requestId, hash)
      if (deduped) {
        return { version: deduped.version, contentVersion: deduped.content_version, unchanged: true, deduplicated: true }
      }
      requireVersion(row, body.baseVersion)

      const result = applyTransform(row, doc => applyContentOps(doc, body.ops))
      const nextContentVersion = row.content_version + (result.contentChanged ? 1 : 0)
      const opSummary = applyThreadOps(result.threads, body.ops, result.newDoc, access, nextContentVersion, result.modifiedIds)
      const threadsJson = JSON.stringify(result.threads)
      const threadsChanged = threadsJson !== row.threads

      if (!result.contentChanged && !threadsChanged) {
        return { version: row.version, contentVersion: row.content_version, unchanged: true, deduplicated: false }
      }
      const summary = [
        ...(result.contentChanged ? changeSummary(parseContent(row.content), result.newDoc) : []),
        ...new Set(opSummary),
      ]
      const committed = commitOutline({
        docId, access,
        contentJson: result.contentJson,
        threadsJson,
        contentChanged: result.contentChanged,
        summary: summary.length ? summary : ['大纲操作'],
        requestId: body.requestId,
        requestHash: hash,
      })
      return { ...committed, unchanged: false, normalized: result.normalized, deduplicated: false }
    },

    // 提交反馈：原子固定当前正文＋线程快照；重复请求返回同一提交
    submitFeedback(access: DocAccess, docId: string, body: OutlineFeedbackBody) {
      const row = mustGetOutline(docId)
      const hash = requestHash('feedback', { note: body.note ?? null })
      if (body.requestId) {
        const existing = db.prepare('SELECT * FROM outline_submissions WHERE doc_id = ? AND request_id = ?').get(docId, body.requestId) as OutlineSubmissionRow | undefined
        if (existing) {
          if (existing.request_hash !== hash) {
            throw AppError.conflict('相同的 requestId 已用于不同内容的请求', { requestId: body.requestId })
          }
          return { submission: toSubmission(existing), deduplicated: true }
        }
      }
      if (body.baseVersion !== undefined && body.baseVersion !== row.version) {
        throw AppError.conflict('大纲有更新，请先同步到最新版本再提交反馈', { currentVersion: row.version })
      }

      const doc = mustGetDoc(docId)
      const snapshot = makeSnapshot(row.content, row.threads)
      // 提交同时写 subtype 快照与修订快照，预算计两份
      checkBudget(doc.owner_id, docId, row.size, snapshot.length * 2)
      const id = nanoid(12)
      const now = Date.now()
      const version = row.version + 1

      let round = 0
      const write = db.transaction(() => {
        round = (db.prepare('SELECT COALESCE(MAX(round), 0) + 1 AS r FROM outline_submissions WHERE doc_id = ?').get(docId) as { r: number }).r
        // 新一轮提交替代仍为待处理的旧轮次（历史快照保留可读）
        db.prepare(`UPDATE outline_submissions SET status = 'superseded' WHERE doc_id = ? AND status = 'pending'`).run(docId)
        db.prepare(
          `INSERT INTO outline_submissions (id, doc_id, round, version, content_version, snapshot, status, note, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        ).run(id, docId, round, row.version, row.content_version, snapshot, body.note ?? null, body.requestId ?? null, hash, now)
        const res = db.prepare('UPDATE outlines SET version = ?, updated_at = ? WHERE doc_id = ? AND version = ?').run(version, now, docId, row.version)
        if (!res.changes) throw AppError.conflict('大纲版本已被其他写入更新，请重试')
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(docId, version, row.content_version, access.author, access.keyId ?? null,
          JSON.stringify([`提交第 ${round} 轮反馈`]), snapshot, null, null, now)
      })
      write()

      publishOutline(docId, { version, contentVersion: row.content_version, author: access.author, summary: [`提交第 ${round} 轮反馈`] })
      const created = db.prepare('SELECT * FROM outline_submissions WHERE id = ?').get(id) as OutlineSubmissionRow
      return { submission: toSubmission(created), deduplicated: false }
    },

    listFeedback(docId: string, query: { status?: string, cursor?: number, limit?: number }) {
      mustGetOutline(docId)
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50)
      const params: unknown[] = [docId]
      let sql = `SELECT * FROM outline_submissions WHERE doc_id = ?`
      if (query.status) {
        sql += ` AND status = ?`
        params.push(query.status)
      }
      if (query.cursor !== undefined) {
        sql += ` AND round < ?`
        params.push(query.cursor)
      }
      sql += ` ORDER BY round DESC LIMIT ?`
      params.push(limit + 1)
      const rows = db.prepare(sql).all(...params) as OutlineSubmissionRow[]
      const hasMore = rows.length > limit
      const page = rows.slice(0, limit)
      return {
        submissions: page.map(toSubmission),
        hasMore,
        nextCursor: hasMore ? page[page.length - 1].round : undefined,
      }
    },

    getFeedback(docId: string, submissionId: string) {
      mustGetOutline(docId)
      const row = db.prepare('SELECT * FROM outline_submissions WHERE doc_id = ? AND id = ?').get(docId, submissionId) as OutlineSubmissionRow | undefined
      if (!row) throw AppError.notFound('提交不存在')
      return { submission: toSubmission(row), snapshot: readSnapshot(row) }
    },

    // Agent 明确报告本轮处理完成；不自动解决线程、不清除更新轮次
    completeFeedback(access: DocAccess, docId: string, submissionId: string, body: OutlineCompleteBody) {
      const row = mustGetOutline(docId)
      const sub = db.prepare('SELECT * FROM outline_submissions WHERE doc_id = ? AND id = ?').get(docId, submissionId) as OutlineSubmissionRow | undefined
      if (!sub) throw AppError.notFound('提交不存在')
      if (body.requestId) {
        const hash = requestHash('complete', { submissionId, note: body.note ?? null })
        if (dedupeRevision(docId, body.requestId, hash)) {
          return { submission: toSubmission(sub), deduplicated: true }
        }
      }
      if (sub.status === 'handled') return { submission: toSubmission(sub), deduplicated: true }
      if (sub.status === 'superseded') {
        throw AppError.conflict('该轮反馈已被更新的提交替代，请处理最新一轮', { status: sub.status })
      }

      const version = row.version + 1
      const now = Date.now()
      const result = JSON.stringify({ note: body.note ?? null, keyId: access.keyId ?? null, completedAt: now })
      const write = db.transaction(() => {
        db.prepare(`UPDATE outline_submissions SET status = 'handled', result = ?, handled_at = ? WHERE id = ?`).run(result, now, submissionId)
        const res = db.prepare('UPDATE outlines SET version = ?, updated_at = ? WHERE doc_id = ? AND version = ?').run(version, now, docId, row.version)
        if (!res.changes) throw AppError.conflict('大纲版本已被其他写入更新，请重试')
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        ).run(docId, version, row.content_version, access.author, access.keyId ?? null,
          JSON.stringify([`处理第 ${sub.round} 轮反馈`]), body.requestId ?? null,
          body.requestId ? requestHash('complete', { submissionId, note: body.note ?? null }) : null, now)
      })
      write()

      publishOutline(docId, { version, contentVersion: row.content_version, author: access.author, summary: [`处理第 ${sub.round} 轮反馈`] })
      const updated = db.prepare('SELECT * FROM outline_submissions WHERE id = ?').get(submissionId) as OutlineSubmissionRow
      return { submission: toSubmission(updated), deduplicated: false }
    },

    // 用户确认当前已保存内容（编辑令牌角色）；未解决批注需显式确认
    approve(access: DocAccess, docId: string, body: OutlineApprovalBody) {
      const row = mustGetOutline(docId)
      const hash = requestHash('approval', { baseVersion: body.baseVersion, ack: !!body.acknowledgeOpenThreads })
      if (body.requestId) {
        const existing = db.prepare('SELECT * FROM outline_approvals WHERE doc_id = ? AND request_id = ?').get(docId, body.requestId) as OutlineApprovalRow | undefined
        if (existing) {
          if (existing.request_hash !== hash) {
            throw AppError.conflict('相同的 requestId 已用于不同内容的请求', { requestId: body.requestId })
          }
          return { approval: toApproval(existing), deduplicated: true }
        }
      }
      if (body.baseVersion !== row.version) {
        throw AppError.conflict('大纲有未保存或更新的内容，请先同步到最新版本再确认', { currentVersion: row.version })
      }

      const threads = parseThreads(row.threads)
      const openThreads = threads.filter(t => t.status === 'open').length
      if (openThreads > 0 && !body.acknowledgeOpenThreads) {
        throw AppError.conflict(`还有 ${openThreads} 条未解决批注；如确认仍要进入制作，请显式选择`, { openThreads })
      }

      const doc = mustGetDoc(docId)
      const snapshot = makeSnapshot(row.content, row.threads)
      // 确认同时写 subtype 快照与修订快照，预算计两份
      checkBudget(doc.owner_id, docId, row.size, snapshot.length * 2)
      const id = nanoid(12)
      const now = Date.now()
      const version = row.version + 1

      const write = db.transaction(() => {
        db.prepare(`UPDATE outline_approvals SET status = 'superseded' WHERE doc_id = ? AND status = 'active'`).run(docId)
        db.prepare(
          `INSERT INTO outline_approvals (id, doc_id, version, content_version, snapshot, status, open_threads, acknowledged_open_threads, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        ).run(id, docId, row.version, row.content_version, snapshot, openThreads,
          openThreads > 0 ? 1 : 0, body.requestId ?? null, hash, now)
        const res = db.prepare(
          'UPDATE outlines SET version = ?, updated_at = ?, active_approval_id = ? WHERE doc_id = ? AND version = ?'
        ).run(version, now, id, docId, row.version)
        if (!res.changes) throw AppError.conflict('大纲版本已被其他写入更新，请重试')
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
        ).run(docId, version, row.content_version, access.author, access.keyId ?? null,
          JSON.stringify([`确认大纲（contentVersion=${row.content_version}，未解决批注 ${openThreads}）`]), snapshot, now)
      })
      write()

      publishOutline(docId, { version, contentVersion: row.content_version, author: access.author, summary: ['确认大纲'] })
      const created = db.prepare('SELECT * FROM outline_approvals WHERE id = ?').get(id) as OutlineApprovalRow
      return { approval: toApproval(created), deduplicated: false }
    },

    // 用户撤销当前确认：保留历史，同时停止依赖它的制作来源
    revokeApproval(access: DocAccess, docId: string) {
      const row = mustGetOutline(docId)
      if (!row.active_approval_id) throw AppError.conflict('当前没有有效的确认可撤销')
      const approval = db.prepare('SELECT * FROM outline_approvals WHERE id = ?').get(row.active_approval_id) as OutlineApprovalRow | undefined
      if (!approval || approval.status !== 'active') throw AppError.conflict('当前没有有效的确认可撤销')

      const version = row.version + 1
      const now = Date.now()
      const write = db.transaction(() => {
        db.prepare(`UPDATE outline_approvals SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, approval.id)
        const res = db.prepare(
          `UPDATE outlines SET version = ?, updated_at = ?, active_approval_id = NULL,
             gen_approval_id = NULL, gen_content_version = NULL, gen_ppt_version = NULL, gen_at = NULL
           WHERE doc_id = ? AND version = ?`
        ).run(version, now, docId, row.version)
        if (!res.changes) throw AppError.conflict('大纲版本已被其他写入更新，请重试')
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
        ).run(docId, version, row.content_version, access.author, access.keyId ?? null,
          JSON.stringify(['撤销大纲确认']), now)
      })
      write()

      publishOutline(docId, { version, contentVersion: row.content_version, author: access.author, summary: ['撤销大纲确认'] })
      return { ok: true }
    },

    // Agent 依据有效确认开始一次制作：校验内容版本未偏离，记录来源
    beginGeneration(access: DocAccess, docId: string, requestId?: string) {
      const row = mustGetOutline(docId)
      const hash = requestId ? requestHash('generation', {}) : null
      const deduped = dedupeRevision(docId, requestId, hash ?? '')
      if (deduped && row.gen_approval_id) {
        return generationState(row)
      }
      if (!row.active_approval_id) {
        throw AppError.conflict('尚无有效的大纲确认，请等待用户在网页确认大纲', { code: 'no_approval' })
      }
      const approval = db.prepare('SELECT * FROM outline_approvals WHERE id = ?').get(row.active_approval_id) as OutlineApprovalRow | undefined
      if (!approval || approval.status !== 'active') {
        throw AppError.conflict('大纲确认已失效，请等待用户重新确认', { code: 'approval_inactive' })
      }
      if (approval.content_version !== row.content_version) {
        throw AppError.conflict('确认后大纲内容已变化，旧确认不再作为制作依据', {
          code: 'content_changed',
          approvalContentVersion: approval.content_version,
          currentContentVersion: row.content_version,
        })
      }
      // 同一确认＋同一内容版本重复开始：幂等返回当前来源
      if (row.gen_approval_id === approval.id && row.gen_content_version === row.content_version) {
        return generationState(row)
      }

      const doc = mustGetDoc(docId)
      const version = row.version + 1
      const now = Date.now()
      const write = db.transaction(() => {
        const res = db.prepare(
          `UPDATE outlines SET version = ?, updated_at = ?, gen_approval_id = ?, gen_content_version = ?, gen_ppt_version = ?, gen_at = ?
           WHERE doc_id = ? AND version = ?`
        ).run(version, now, approval.id, row.content_version, doc.version, now, docId, row.version)
        if (!res.changes) throw AppError.conflict('大纲版本已被其他写入更新，请重试')
        db.prepare(
          `INSERT INTO outline_revisions (doc_id, version, content_version, author, key_id, summary, snapshot, request_id, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        ).run(docId, version, row.content_version, access.author, access.keyId ?? null,
          JSON.stringify([`开始制作（approvalId=${approval.id}，contentVersion=${row.content_version}，PPT v${doc.version}）`]),
          requestId ?? null, hash, now)
      })
      write()

      publishOutline(docId, { version, contentVersion: row.content_version, author: access.author, summary: ['开始制作'] })
      return generationState(mustGetOutline(docId))
    },

    get,
    storageBytes,

    // 大纲状态（列表元数据用）
    status(docId: string) {
      const row = db.prepare('SELECT * FROM outlines WHERE doc_id = ?').get(docId) as OutlineRow | undefined
      if (!row) return null
      const pending = db.prepare(`SELECT COUNT(*) AS n FROM outline_submissions WHERE doc_id = ? AND status = 'pending'`).get(docId) as { n: number }
      const approval = row.active_approval_id
        ? db.prepare('SELECT content_version, status FROM outline_approvals WHERE id = ?').get(row.active_approval_id) as { content_version: number, status: string } | undefined
        : undefined
      return {
        version: row.version,
        contentVersion: row.content_version,
        pendingSubmissions: pending.n,
        approvalActive: approval?.status === 'active',
        approvalValid: approval?.status === 'active' && approval.content_version === row.content_version,
      }
    },

    // 阶段 D 门禁预留：校验 Agent 页面写入的确认来源。
    // 无大纲返回 { required: false }；有大纲则必须有有效制作来源
    assertProductionSource(docId: string, sourceApprovalId: string | undefined): { required: boolean } {
      const row = db.prepare('SELECT * FROM outlines WHERE doc_id = ?').get(docId) as OutlineRow | undefined
      if (!row) return { required: false }
      if (!sourceApprovalId || sourceApprovalId !== row.gen_approval_id || row.gen_content_version !== row.content_version) {
        throw AppError.conflict('大纲项目的页面制作需要有效的确认来源（sourceApprovalId），请先 begin 制作', {
          code: 'production_source_required',
          currentContentVersion: row.content_version,
        })
      }
      return { required: true }
    },
  }

  function generationState(row: OutlineRow) {
    return {
      approvalId: row.gen_approval_id,
      contentVersion: row.gen_content_version,
      pptVersion: row.gen_ppt_version,
      at: row.gen_at,
      version: row.version,
      stale: row.gen_content_version !== row.content_version,
    }
  }

  function get(access: DocAccess, docId: string) {
    const { row, pending, approval } = outlineState(docId)
    return {
      docId,
      role: access.role,
      version: row.version,
      contentVersion: row.content_version,
      content: JSON.parse(row.content),
      threads: parseThreads(row.threads),
      status: {
        pendingSubmissions: pending,
        approval: approval
          ? {
            id: approval.id,
            version: approval.version,
            contentVersion: approval.content_version,
            valid: approval.status === 'active' && approval.content_version === row.content_version,
          }
          : null,
        generation: row.gen_approval_id
          ? {
            approvalId: row.gen_approval_id,
            contentVersion: row.gen_content_version,
            pptVersion: row.gen_ppt_version,
            at: row.gen_at,
            stale: row.gen_content_version !== row.content_version,
          }
          : null,
      },
      updatedAt: row.updated_at,
    }
  }
}

function toSubmission(row: OutlineSubmissionRow): OutlineSubmission {
  return {
    id: row.id,
    docId: row.doc_id,
    round: row.round,
    version: row.version,
    contentVersion: row.content_version,
    status: row.status,
    note: row.note ?? undefined,
    result: row.result ? JSON.parse(row.result) as OutlineSubmission['result'] : undefined,
    createdAt: row.created_at,
    handledAt: row.handled_at ?? undefined,
  }
}

function toApproval(row: OutlineApprovalRow): OutlineApproval {
  return {
    id: row.id,
    docId: row.doc_id,
    version: row.version,
    contentVersion: row.content_version,
    status: row.status,
    openThreads: row.open_threads,
    acknowledgedOpenThreads: !!row.acknowledged_open_threads,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
  }
}

export type OutlineService = ReturnType<typeof createOutlineService>
