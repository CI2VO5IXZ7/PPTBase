// 选区所在区块与「滚动到区块」的选区。纯模型，供编辑器与离线测试共用。
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection, TextSelection, type Selection } from 'prosemirror-state'
import { blockIndex } from './anchors.ts'

export function blockAtSelection(doc: PMNode, sel: Selection): { blockId: string | null, topLevel: boolean } {
  // 图片/分隔线的 NodeSelection.from 与前一节点的结束位置重合。
  // 先认节点选区本身，避免被文档顺序里更早的前一块抢走。
  if (sel instanceof NodeSelection) {
    const id = sel.node.attrs?.blockId
    if (typeof id === 'string' && id) {
      return { blockId: id, topLevel: sel.$from.depth === 0 }
    }
  }
  const from = sel.from
  for (const ref of blockIndex(doc).values()) {
    // 右开区间：边界位置属于后面的节点。
    // 嵌套光标仍先命中最外层带 blockId 的区块——顶层上移/下移移动的就是这个容器（v1）。
    if (from >= ref.pos && from < ref.pos + ref.node.nodeSize) {
      return {
        blockId: ref.blockId,
        topLevel: doc.resolve(ref.pos).depth === 0,
      }
    }
  }
  return { blockId: null, topLevel: false }
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
