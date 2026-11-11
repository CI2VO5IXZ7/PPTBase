// 草稿下载的 object URL。click() 返回时浏览器可能还没读完，不能在同一轮同步里 revoke。

export const DRAFT_BLOB_REVOKE_DELAY_MS = 1000

export interface BlobRevokeTimer {
  id: ReturnType<typeof setTimeout>
  url: string
}

export function scheduleBlobRevoke(
  url: string,
  pending: BlobRevokeTimer[],
  revoke: (url: string) => void,
  delayMs = DRAFT_BLOB_REVOKE_DELAY_MS,
): void {
  const entry: BlobRevokeTimer = { url, id: 0 as unknown as ReturnType<typeof setTimeout> }
  entry.id = setTimeout(() => {
    const index = pending.indexOf(entry)
    if (index >= 0) pending.splice(index, 1)
    revoke(url)
  }, delayMs)
  pending.push(entry)
}

/** 清掉尚未执行的定时器，并立刻收回对应地址，避免卸载后泄漏。 */
export function revokePendingBlobs(pending: BlobRevokeTimer[], revoke: (url: string) => void): void {
  const leftover = pending.splice(0, pending.length)
  for (const entry of leftover) {
    clearTimeout(entry.id)
    revoke(entry.url)
  }
}
