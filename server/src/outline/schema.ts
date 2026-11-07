// 大纲 REST 请求体与正文约束的 zod 校验。
// 正文结构本身由共享 PM schema（src/utils/outline/schema.ts）把关，
// 这里负责请求形状、预算上限、链接协议与资产所有权/引用检查。

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Node as PMNode } from 'prosemirror-model'

import type { OutlineNodeJson, OutlineOp } from '../../../src/types/outline'
import { IMAGE_USAGES, OUTLINE_LIMITS, outlineSchema } from '../../../src/utils/outline/schema'
import { assetIdFromSrc } from '../../../src/utils/outline/serialize'
import type { Db } from '../db'
import { AppError, type ValidationIssue } from '../errors'

const L = OUTLINE_LIMITS
const blockId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '非法 blockId')
const requestId = z.string().min(1).max(128)
const baseVersion = z.number().int().min(0)
const nodeJson = z.looseObject({ type: z.string().min(1).max(32) })

const anchorSpec = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('document') }),
  z.looseObject({ kind: z.literal('block'), blockId }),
  z.looseObject({ kind: z.literal('image'), blockId }),
  z.looseObject({
    kind: z.literal('textRange'),
    fragments: z.array(z.looseObject({
      blockId,
      from: z.number().int().min(0),
      to: z.number().int().min(0),
    })).min(1).max(20),
  }),
])

const opSchema = z.discriminatedUnion('op', [
  z.looseObject({
    op: z.literal('insertBlocks'),
    before: blockId.optional(),
    after: blockId.optional(),
    blocks: z.array(nodeJson).min(1).max(L.maxBlocksPerOp),
  }),
  z.looseObject({ op: z.literal('replaceBlock'), blockId, block: nodeJson }),
  z.looseObject({
    op: z.literal('updateBlockAttrs'),
    blockId,
    attrs: z.record(z.string().max(32), z.unknown()),
  }),
  z.looseObject({
    op: z.literal('deleteBlocks'),
    blockIds: z.array(blockId).min(1).max(L.maxBlocksPerOp),
  }),
  z.looseObject({
    op: z.literal('moveBlock'),
    blockId,
    before: blockId.optional(),
    after: blockId.optional(),
  }),
  z.looseObject({
    op: z.literal('addComment'),
    anchor: anchorSpec,
    content: z.string().min(1).max(L.maxCommentChars),
  }),
  z.looseObject({
    op: z.literal('replyComment'),
    threadId: z.string().min(1).max(64),
    content: z.string().min(1).max(L.maxCommentChars),
  }),
  z.looseObject({
    op: z.literal('setThreadStatus'),
    threadId: z.string().min(1).max(64),
    status: z.enum(['open', 'resolved']),
  }),
])

export const outlineInitSchema = z.looseObject({
  requestId: requestId.optional(),
  content: z.looseObject({ type: z.literal('doc') }).optional(),
})

export const outlinePatchSchema = z.looseObject({
  baseVersion,
  requestId: requestId.optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(L.maxStepsPerRequest),
})

export const outlineOpsSchema = z.looseObject({
  baseVersion,
  requestId: requestId.optional(),
  ops: z.array(opSchema).min(1).max(L.maxOpsPerRequest),
})

export const outlineFeedbackSchema = z.looseObject({
  baseVersion: baseVersion.optional(),
  requestId: requestId.optional(),
  note: z.string().max(L.maxNoteChars).optional(),
})

export const outlineCompleteSchema = z.looseObject({
  requestId: requestId.optional(),
  note: z.string().max(L.maxNoteChars).optional(),
})

export const outlineApprovalSchema = z.looseObject({
  baseVersion,
  requestId: requestId.optional(),
  // 存在未解决批注时必须显式为 true 才能继续确认
  acknowledgeOpenThreads: z.boolean().optional(),
})

// 一次性确认凭证申请：绑定 approve/revoke 动作
export const outlineConfirmTicketSchema = z.looseObject({
  action: z.enum(['approve', 'revoke']),
})

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.map(seg => typeof seg === 'number' ? `[${seg}]` : String(seg)).join('.') || '(root)',
    message: issue.message,
  }))
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw AppError.validation(`${what}校验失败`, issuesOf(result.error))
  return result.data
}

export function requestHash(kind: string, payload: unknown): string {
  return createHash('sha256').update(kind).update('').update(JSON.stringify(payload ?? null)).digest('hex')
}

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function checkLinkHref(href: unknown, issues: ValidationIssue[], path: string): void {
  if (typeof href !== 'string' || !href || href.length > L.maxLinkChars) {
    issues.push({ path, message: '链接地址非法或过长' })
    return
  }
  // 去掉所有空白与控制字符再判定协议（java\\tscript: 等混淆写法一并拦截）
  // eslint-disable-next-line no-control-regex
  const trimmed = href.replace(/[\s\u0000-\u001f\u007f]+/g, '')
  let proto: string | undefined
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  if (m) proto = m[1].toLowerCase() + ':'
  else if (trimmed.startsWith('//')) proto = 'http:'
  else proto = 'relative'
  if (proto !== 'relative' && !ALLOWED_LINK_PROTOCOLS.has(proto)) {
    issues.push({ path, message: `链接协议不允许: ${proto}` })
  }
}

// 正文约束检查：预算、链接协议、图片地址与资产所有权。
// data: 图片已在写入流水线中转存；此处只接受 /assets/ 与 http(s)
export function validateOutlineDoc(db: Db, doc: PMNode, ownerId: string): void {
  const issues: ValidationIssue[] = []
  let blocks = 0
  let textChars = 0
  let images = 0

  doc.check()

  doc.descendants((node, pos) => {
    if (node.attrs.blockId) {
      blocks++
      if (doc.resolve(pos).depth + 1 > L.maxDepth) {
        issues.push({ path: 'content', message: `嵌套深度超过 ${L.maxDepth}` })
      }
    }
    if (node.isText) {
      textChars += node.text?.length ?? 0
      for (const mark of node.marks) {
        if (mark.type.name === 'link') checkLinkHref(mark.attrs.href, issues, 'content/link')
      }
    }
    if (node.type.name === 'image') {
      images++
      const a = node.attrs
      if (typeof a.src !== 'string' || !a.src || a.src.length > L.maxImageSrcChars) {
        issues.push({ path: 'content/image', message: '图片 src 非法' })
      }
      else if (a.src.startsWith('/assets/')) {
        const assetId = assetIdFromSrc(a.src)
        const row = assetId
          ? db.prepare('SELECT owner_id FROM assets WHERE id = ?').get(assetId) as { owner_id: string } | undefined
          : undefined
        if (!row) issues.push({ path: 'content/image', message: `图片资产不存在: ${a.src}` })
        else if (row.owner_id !== ownerId) {
          issues.push({ path: 'content/image', message: '图片资产不属于当前文档所有者' })
        }
      }
      else if (!/^https?:\/\//i.test(a.src)) {
        issues.push({ path: 'content/image', message: '图片地址仅支持 /assets/ 与 http(s)' })
      }
      if (typeof a.caption !== 'string' || a.caption.length > L.maxCaptionChars
        || typeof a.alt !== 'string' || a.alt.length > L.maxAltChars
        || typeof a.usageDescription !== 'string' || a.usageDescription.length > L.maxUsageDescChars) {
        issues.push({ path: 'content/image', message: '图片说明/用途描述过长' })
      }
      if (!IMAGE_USAGES.includes(a.usage)) {
        issues.push({ path: 'content/image', message: 'usage 必须是 reference|include' })
      }
    }
    return true
  })

  if (blocks > L.maxBlocks) issues.push({ path: 'content', message: `区块数超过 ${L.maxBlocks}` })
  if (textChars > L.maxTextChars) issues.push({ path: 'content', message: `文本长度超过 ${L.maxTextChars}` })
  if (images > 200) issues.push({ path: 'content', message: '图片数量超过 200' })

  if (issues.length) throw AppError.validation('大纲内容校验失败', issues.slice(0, 20))
}


// JSON 层面严格检查：节点/mark 类型必须在共享 schema 中，
// attrs 键不允许超出 spec（PM 反序列化会静默丢弃未知属性，
// 这里在入库前显式拒绝，避免注入型属性悄悄通过）
export function validateJsonAttrs(node: OutlineNodeJson): void {
  if (!Object.hasOwn(outlineSchema.nodes, node.type)) {
    throw AppError.validation(`未知节点类型: ${node.type}`)
  }
  const spec = outlineSchema.nodes[node.type].spec.attrs ?? {}
  for (const key of Object.keys(node.attrs ?? {})) {
    if (!(key in spec)) {
      throw AppError.validation(`节点 ${node.type} 不允许属性 ${key}`)
    }
  }
  for (const mark of node.marks ?? []) {
    if (!Object.hasOwn(outlineSchema.marks, mark.type)) {
      throw AppError.validation(`未知 mark 类型: ${mark.type}`)
    }
    const markSpec = outlineSchema.marks[mark.type].spec.attrs ?? {}
    for (const key of Object.keys(mark.attrs ?? {})) {
      if (!(key in markSpec)) {
        throw AppError.validation(`mark ${mark.type} 不允许属性 ${key}`)
      }
    }
  }
  for (const child of node.content ?? []) validateJsonAttrs(child)
}

export type { OutlineOp }
export type OutlineOpsBody = z.infer<typeof outlineOpsSchema>
export type OutlinePatchBody = z.infer<typeof outlinePatchSchema>
export type OutlineFeedbackBody = z.infer<typeof outlineFeedbackSchema>
export type OutlineApprovalBody = z.infer<typeof outlineApprovalSchema>
export type OutlineConfirmTicketBody = z.infer<typeof outlineConfirmTicketSchema>
export type OutlineCompleteBody = z.infer<typeof outlineCompleteSchema>
export type OutlineInitBody = z.infer<typeof outlineInitSchema>
