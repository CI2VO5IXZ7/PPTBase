// 选区所在区块与「滚动到区块」的选区。纯模型，供编辑器与离线测试共用。
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection, TextSelection, type Selection } from 'prosemirror-state'
import { blockIndex } from './anchors.ts'

export function blockAtSelection(doc: PMNode, sel: Selection): { blockId: string | null, topLevel: boolean } {
  // 节点选区直接认当前节点。图片的 from 与前一块的结束位置重合，不能按文档顺序去抢。
  if (sel instanceof NodeSelection) {
    const id = sel.node.attrs?.blockId
    if (typeof id === 'string' && id) {
      return { blockId: id, topLevel: sel.$from.depth === 0 }
    }
  }
  // 光标从所在位置向外找最近的带 blockId 的祖先，不取最外层列表。
  const $from = sel.$from
  for (let depth = $from.depth; depth >= 1; depth--) {
    const id = $from.node(depth).attrs?.blockId
    if (typeof id === 'string' && id) {
      return { blockId: id, topLevel: depth === 1 }
    }
  }
  return { blockId: null, topLevel: false }
}

// 远端替换会丢掉选区。按稳定 blockId 放回原区块；原先是节点选区时继续用节点选区。
export function selectionKeepingBlock(doc: PMNode, blockId: string, preferNode: boolean): Selection | null {
  const ref = blockIndex(doc).get(blockId)
  if (!ref) return null
  if (preferNode && NodeSelection.isSelectable(ref.node)) return NodeSelection.create(doc, ref.pos)
  return selectionForBlock(doc, blockId)
}

export function selectionForBlock(doc: PMNode, blockId: string): Selection | null {
  const ref = blockIndex(doc).get(blockId)
  if (!ref) return null
  const node = ref.node
  // 原子/叶子（图片、分隔线）没有可放置光标的 inline 内容。
  if (node.isAtom || node.isLeaf) return NodeSelection.create(doc, ref.pos)
  if (node.isTextblock) return TextSelection.create(doc, ref.pos + 1)
  const $inside = doc.resolve(ref.pos + 1)
  return TextSelection.between($inside, $inside, 1)
}
