// 从大纲 JSON（ProseMirror doc.toJSON）构建只读导航树；不触达 DOM、不改 schema。

export interface NavItem {
  blockId: string
  label: string
  depth: number
  type: string
  children: NavItem[]
}

type JsonNode = {
  type?: string
  attrs?: { blockId?: string, level?: number }
  content?: JsonNode[]
  text?: string
}

function nodeLabel(node: JsonNode): string {
  const id = node.attrs?.blockId ?? ''
  const texts: string[] = []
  const walk = (n: JsonNode) => {
    if (n.text) texts.push(n.text)
    n.content?.forEach(walk)
  }
  walk(node)
  const t = texts.join('').trim()
  switch (node.type) {
    case 'heading':
      return t || `标题 ${node.attrs?.level ?? ''}`.trim() || id
    case 'image':
      return t || `图片 ${id}`
    case 'horizontal_rule':
      return '分隔线'
    default:
      return t ? (t.length > 36 ? `${t.slice(0, 36)}…` : t) : id || node.type || '区块'
  }
}

function walkBlocks(nodes: JsonNode[] | undefined, depth: number, out: NavItem[]): void {
  if (!nodes) return
  for (const node of nodes) {
    if (!node.attrs?.blockId) {
      if (node.content) walkBlocks(node.content, depth, out)
      continue
    }
    const item: NavItem = {
      blockId: String(node.attrs.blockId),
      label: nodeLabel(node),
      depth,
      type: node.type ?? 'unknown',
      children: [],
    }
  // 列表项内嵌套子块仅作子节点展示，不用于 move（v1）
    if (node.type === 'list_item' && node.content) {
      for (const child of node.content) {
        if (child.type === 'bullet_list' || child.type === 'ordered_list') {
          walkBlocks(child.content, depth + 1, item.children)
        }
      }
    }
    out.push(item)
    if (node.type !== 'list_item' && node.content) {
      const nested: NavItem[] = []
      walkBlocks(node.content, depth + 1, nested)
      item.children.push(...nested)
    }
  }
}

/** 文档顶层导航（doc.content 顺序） */
export function navigatorTree(doc: Record<string, unknown> | null | undefined): NavItem[] {
  if (!doc || doc.type !== 'doc') return []
  const roots: NavItem[] = []
  walkBlocks((doc as JsonNode).content, 0, roots)
  return roots
}

/** 仅 doc 直接子节点 blockId（moveBlock v1） */
export function topLevelBlockIds(doc: Record<string, unknown> | null | undefined): string[] {
  if (!doc || doc.type !== 'doc') return []
  const ids: string[] = []
  for (const node of ((doc as JsonNode).content ?? [])) {
    if (node.attrs?.blockId) ids.push(String(node.attrs.blockId))
  }
  return ids
}
