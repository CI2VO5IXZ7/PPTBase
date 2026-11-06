// 大纲 REST 客户端：沿用 document.ts 的 X-Doc-Token 凭证与错误类型
import { docRequest, type DocRequestError } from './document'
import type { OutlineApproval, OutlineSubmission, OutlineThread } from '@/types/outline'

export interface OutlineState {
  docId: string
  role: 'owner' | 'edit' | 'view'
  version: number
  contentVersion: number
  content: Record<string, unknown>
  threads: OutlineThread[]
  status: {
    pendingSubmissions: number
    approval: { id: string, version: number, contentVersion: number, valid: boolean } | null
    generation: { approvalId: string, contentVersion: number, pptVersion: number, at: number, stale: boolean } | null
  }
  updatedAt: number
  editUrl?: string
  viewUrl?: string
  outlineEditUrl?: string
  outlineViewUrl?: string
}

export interface OutlineWriteResult {
  version: number
  contentVersion: number
  unchanged?: boolean
  normalized?: boolean
  deduplicated?: boolean
}

export const getOutline = (id: string) => docRequest<OutlineState>(`/api/docs/${id}/outline`)

export const patchOutlineSteps = (id: string, baseVersion: number, requestId: string, steps: Record<string, unknown>[]) =>
  docRequest<OutlineWriteResult>(`/api/docs/${id}/outline`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion, requestId, steps }),
  })

export const postOutlineOps = (id: string, baseVersion: number, requestId: string | undefined, ops: Record<string, unknown>[]) =>
  docRequest<OutlineWriteResult>(`/api/docs/${id}/outline/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion, requestId, ops }),
  })

export const submitOutlineFeedback = (id: string, body: { baseVersion?: number, requestId?: string, note?: string }) =>
  docRequest<{ submission: OutlineSubmission, deduplicated?: boolean }>(`/api/docs/${id}/outline/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const approveOutline = (id: string, body: { baseVersion: number, requestId?: string, acknowledgeOpenThreads?: boolean }) =>
  docRequest<{ approval: OutlineApproval, deduplicated?: boolean }>(`/api/docs/${id}/outline/approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const revokeOutlineApproval = (id: string) =>
  docRequest<{ ok: boolean }>(`/api/docs/${id}/outline/approval`, { method: 'DELETE' })

export const listOutlineFeedback = (id: string, query = '') =>
  docRequest<{ submissions: OutlineSubmission[], hasMore: boolean, nextCursor?: number }>(`/api/docs/${id}/outline/feedback${query}`)

export type { DocRequestError }
