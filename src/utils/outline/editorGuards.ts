// 大纲页几处「提交前是否仍安全」的纯判定。不碰网络、不改布局。

export function textsEqual(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false
  return a.every((text, i) => text === b[i])
}

// 批注弹层打开时记下的正文修订。修订变了就不能只凭片段文本相同就沿用旧偏移。
export function commentRevisionCurrent(opened: number | null, current: number | null): boolean {
  return opened != null && current != null && opened === current
}

// 二次确认只能批准第一次确认时用户看到的版本。
export function reviewedVersionCurrent(reviewed: number | null, current: number): boolean {
  return reviewed != null && reviewed === current
}

// 复制完成后，正文或 steps 与按下复制时不一致就不能解锁刷新。
export function sameDraftBody(
  copied: { content: unknown, steps: unknown } | null,
  current: { content: unknown, steps: unknown } | null,
): boolean {
  if (!copied || !current) return false
  return JSON.stringify(copied.content) === JSON.stringify(current.content)
    && JSON.stringify(copied.steps) === JSON.stringify(current.steps)
}

// 链接弹层打开时记下的选区。正文版本变了就不用旧坐标，避免标到另一段文字或静默丢弃。
export function unchangedLinkRange(
  pending: { from: number, to: number, docRev: number } | null,
  docRev: number,
): { from: number, to: number } | null {
  if (!pending || pending.from >= pending.to || pending.docRev !== docRev) return null
  return { from: pending.from, to: pending.to }
}

// 冲突横幅：草稿还在时必须先复制或下载；草稿已经不在（显式丢弃或从未生成）才允许刷新。
export function conflictRefreshAllowed(draftPreserved: boolean, hasDraft: boolean): boolean {
  return draftPreserved || !hasDraft
}

export interface DraftBody {
  content: unknown
  steps: unknown
}

// 备份解锁时留下的正文+steps。比较前先断开引用，避免之后 push steps 把快照一并改掉。
export function cloneDraftBody(body: DraftBody | null): DraftBody | null {
  if (!body) return null
  return JSON.parse(JSON.stringify({ content: body.content, steps: body.steps })) as DraftBody
}

export const CONFLICT_REBACKUP_MESSAGE = '草稿已变化，请重新复制或下载后再刷新'

// 冲突态下的本地正文事务才作废已备份标志。选区变化和远端替换不是 localDocChange。
export function noteLocalConflictEdit(input: {
  status: string
  preserved: boolean
  snapshot: DraftBody | null
  localDocChange: boolean
}): { preserved: boolean, snapshot: DraftBody | null, message: string | null } {
  if (!input.localDocChange || input.status !== 'conflict' || !input.preserved) {
    return { preserved: input.preserved, snapshot: input.snapshot, message: null }
  }
  return { preserved: false, snapshot: null, message: CONFLICT_REBACKUP_MESSAGE }
}

// flush 之后再决定能不能刷新。标志还在但正文/steps 与备份快照不一致时必须拒绝。
export function conflictRefreshDecision(input: {
  draftPreserved: boolean
  hasDraft: boolean
  snapshot: DraftBody | null
  current: DraftBody | null
}): { allowed: boolean, clearPreserve: boolean, message: string | null } {
  if (!conflictRefreshAllowed(input.draftPreserved, input.hasDraft)) {
    return { allowed: false, clearPreserve: false, message: null }
  }
  if (!input.hasDraft) return { allowed: true, clearPreserve: false, message: null }
  if (!sameDraftBody(input.snapshot, input.current)) {
    return { allowed: false, clearPreserve: true, message: CONFLICT_REBACKUP_MESSAGE }
  }
  return { allowed: true, clearPreserve: false, message: null }
}

// drain 之后再看当前状态。调用前的 dirty/saving 不能继续当成离开理由。
export function navigationNeedsLeave(drained: boolean, hasUnsaved: boolean, saveStatus: string): boolean {
  if (!drained || hasUnsaved) return true
  return saveStatus === 'offline' || saveStatus === 'dirty' || saveStatus === 'conflict'
}
