// 大纲页几处「提交前是否仍安全」的纯判定。不碰网络、不改布局。

export function textsEqual(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false
  return a.every((text, i) => text === b[i])
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

// drain 之后再看当前状态。调用前的 dirty/saving 不能继续当成离开理由。
export function navigationNeedsLeave(drained: boolean, hasUnsaved: boolean, saveStatus: string): boolean {
  if (!drained || hasUnsaved) return true
  return saveStatus === 'offline' || saveStatus === 'dirty' || saveStatus === 'conflict'
}
