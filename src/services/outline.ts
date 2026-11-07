// 大纲 REST 客户端：沿用 document.ts 的 X-Doc-Token 凭证与错误类型
import { docRequest, DocRequestError } from './document'
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

// 确认/撤销需服务端下发的一次性凭证（绑定动作、限时、用完即废）；
// 编辑令牌本体不能确认，每次点击先取票再提交。
// 领票另需「网页确认会话」：服务端仅向同源页面签发（浏览器同源 POST
// 自动带 Origin，前端无需也不能手动设置）。会话只在内存缓存，不落
// localStorage/URL/日志；到期前复用，过期或领票 403 后重领并重试一次。
let confirmSession: { docId: string, token: string, expiresAt: number } | null = null

const confirmSessionFor = async (id: string, refresh = false) => {
  if (refresh || !confirmSession || confirmSession.docId !== id || confirmSession.expiresAt <= Date.now()) {
    const res = await docRequest<{ confirmSession: string, expiresAt: number }>(
      `/api/docs/${id}/outline/approval/session`, { method: 'POST' })
    confirmSession = { docId: id, token: res.confirmSession, expiresAt: res.expiresAt }
  }
  return confirmSession.token
}

const createApprovalTicket = async (id: string, action: 'approve' | 'revoke') => {
  const mint = (session: string) =>
    docRequest<{ confirmToken: string, expiresAt: number }>(`/api/docs/${id}/outline/approval/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Confirm-Session': session },
      body: JSON.stringify({ action }),
    })
  try {
    return await mint(await confirmSessionFor(id))
  }
  catch (err) {
    // 会话失效/过期被拒：重领一次再试；仍失败或非会话问题向上抛
    if (!(err instanceof DocRequestError) || err.status !== 403) throw err
    confirmSession = null
    return mint(await confirmSessionFor(id, true))
  }
}

export const approveOutline = async (id: string, body: { baseVersion: number, requestId?: string, acknowledgeOpenThreads?: boolean }) => {
  const { confirmToken } = await createApprovalTicket(id, 'approve')
  return docRequest<{ approval: OutlineApproval, deduplicated?: boolean }>(`/api/docs/${id}/outline/approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Confirm-Token': confirmToken },
    body: JSON.stringify(body),
  })
}

export const revokeOutlineApproval = async (id: string) => {
  const { confirmToken } = await createApprovalTicket(id, 'revoke')
  return docRequest<{ ok: boolean }>(`/api/docs/${id}/outline/approval`, {
    method: 'DELETE',
    headers: { 'X-Confirm-Token': confirmToken },
  })
}

export const listOutlineFeedback = (id: string, query = '') =>
  docRequest<{ submissions: OutlineSubmission[], hasMore: boolean, nextCursor?: number }>(`/api/docs/${id}/outline/feedback${query}`)

export type { DocRequestError }
