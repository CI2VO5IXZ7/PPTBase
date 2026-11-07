// 选区 → 批注锚点规格（与 server 端 createAnchor 同一语义，可离线测）。
// 关键契约：textRange fragments 的 from/to 是「相对文本块内容起点」的偏移，
// 只落在 isTextblock 节点上；块容器（list_item/blockquote/doc）不产生 textRange 片段。
import type { Node as PMNode } from 'prosemirror-model'
import type { Selection } from 'prosemirror-state'
import type { OutlineAnchorSpec } from '../../types/outline'

export function selectionToAnchorSpec(doc: PMNode, sel: Selection): OutlineAnchorSpec {
  // 图片等原子节点选区 → image 锚点
  const node = (sel as { node?: PMNode }).node
  if (node && node.type.name === 'image' && node.attrs.blockId) {
    return { kind: 'image', blockId: node.attrs.blockId }
  }
  if (sel.empty) {
    // 折叠光标：所在最近带 blockId 的块 → block 锚点；顶层无则文档级
    const $from = sel.$from
    for (let d = $from.depth; d >= 1; d--) {
      const n = $from.node(d)
      if (n.attrs.blockId) return { kind: 'block', blockId: n.attrs.blockId }
    }
    return { kind: 'document' }
  }
  // 非空选区：逐文本块收集块相对偏移片段（跨块 = 多 fragment）
  const fragments: { blockId: string, from: number, to: number }[] = []
  doc.nodesBetween(sel.from, sel.to, (n, pos) => {
    if (!n.isTextblock || !n.attrs.blockId) return true
    const contentStart = pos + 1
    const contentSize = n.nodeSize - 2
    const from = Math.max(0, sel.from - contentStart)
    const to = Math.min(contentSize, sel.to - contentStart)
    if (to > from) fragments.push({ blockId: n.attrs.blockId, from, to })
    return true // 继续深入（嵌套 textblock 各自成片）
  })
  if (fragments.length) return { kind: 'textRange', fragments }
  return { kind: 'document' }
}
