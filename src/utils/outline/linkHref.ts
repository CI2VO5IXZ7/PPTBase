// 链接协议不区分大小写。只判断前缀，不改后面的主机和路径大小写。

function startsWithProtocol(value: string, protocol: string): boolean {
  return value.slice(0, protocol.length).toLowerCase() === protocol
}

export function normalizeHttpsHref(raw: string): { ok: true, href: string } | { ok: false, error: string } {
  const trimmed = raw.trim()
  if (startsWithProtocol(trimmed, 'http://')) return { ok: false, error: '请使用 https:// 链接' }
  const href = startsWithProtocol(trimmed, 'https://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(href)
    if (url.protocol.toLowerCase() !== 'https:') return { ok: false, error: '请使用 https:// 链接' }
  }
  catch {
    return { ok: false, error: '链接格式无效' }
  }
  return { ok: true, href }
}
