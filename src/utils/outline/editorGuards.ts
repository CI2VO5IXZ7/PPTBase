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

// 冲突且本地草稿已经不在（显式丢弃，或这次冲突没有形成草稿）：禁止再改正文。
// 仍有草稿时返回 false，冲突期间续编和备份失效规则保持原样。
export function conflictInputLocked(saveStatus: string, hasLocalDraft: boolean): boolean {
  return saveStatus === 'conflict' && !hasLocalDraft
}

export interface OpsConflictHit {
  remoteVersion: number | null
  remoteContentVersion: number | null
  message: string
}

// 正文 ops 的 CAS 409。确认大纲时的 openThreads 409 不是正文冲突，不得走这套恢复。
export function outlineOpsContentConflict(err: unknown): OpsConflictHit | null {
  if (!err || typeof err !== 'object') return null
  const e = err as {
    status?: number
    message?: string
    currentVersion?: number
    currentContentVersion?: number
    issues?: Record<string, unknown>
  }
  if (e.status !== 409) return null
  const issues = e.issues
  if (issues && issues.openThreads) return null
  const fromIssues = (key: 'currentVersion' | 'currentContentVersion'): number | null => {
    const value = issues?.[key]
    return typeof value === 'number' ? value : null
  }
  const remoteVersion = fromIssues('currentVersion') ?? (typeof e.currentVersion === 'number' ? e.currentVersion : null)
  const remoteContentVersion = fromIssues('currentContentVersion')
    ?? (typeof e.currentContentVersion === 'number' ? e.currentContentVersion : null)
  const message = typeof e.message === 'string' && e.message ? e.message : '版本冲突'
  return { remoteVersion, remoteContentVersion, message }
}

// 409 体里已经有正文版本时，只用这一对，不再改读后来的拉取结果。
// 缺少 contentVersion 时才采用同一次只读拉取的成对版本；拉不到也不要把状态当成已保存。
export function resolveOpsConflictVersions(
  reported: { remoteVersion: number | null, remoteContentVersion: number | null },
  peeked: { version: number, contentVersion: number } | null,
): { remoteVersion: number | null, remoteContentVersion: number | null } {
  if (reported.remoteContentVersion != null) {
    return { remoteVersion: reported.remoteVersion, remoteContentVersion: reported.remoteContentVersion }
  }
  if (!peeked) return { remoteVersion: reported.remoteVersion, remoteContentVersion: null }
  if (reported.remoteVersion != null && peeked.version < reported.remoteVersion) {
    return { remoteVersion: reported.remoteVersion, remoteContentVersion: null }
  }
  return { remoteVersion: peeked.version, remoteContentVersion: peeked.contentVersion }
}
