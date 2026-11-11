// 图片属性更新的事务构造（纯函数；组件与离线测试共用）。
// 只按 blockId 找当前图片。旧 pos 可能已经落到另一张图上，不能拿来写属性。
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'

import { blockIndex } from './anchors.ts'

export interface ImageAttrPatch {
  caption: string
  usage: string
  usageDescription: string
}

// 当前文档里这个 blockId 仍是 image 时返回节点起点；找不到或已不是图片则为 null。
export function imageBlockPos(doc: PMNode, blockId: string): number | null {
  if (!blockId) return null
  const ref = blockIndex(doc).get(blockId)
  if (!ref || ref.node.type.name !== 'image') return null
  return ref.pos
}

export function imageAttrsTr(state: EditorState, blockId: string, attrs: ImageAttrPatch): Transaction | null {
  const pos = imageBlockPos(state.doc, blockId)
  if (pos == null) return null
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image' || node.attrs.blockId !== blockId) return null
  return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
}

// 属性面板还开着时，把记下的 pos 改到该 blockId 的当前位置。图片已不在文档里则 null（面板关闭）。
export function remapImageSel<T extends { pos: number, blockId: string }>(doc: PMNode, sel: T): T | null {
  const pos = imageBlockPos(doc, sel.blockId)
  if (pos == null) return null
  if (pos === sel.pos) return sel
  return { ...sel, pos }
}
