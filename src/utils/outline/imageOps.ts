// 图片属性更新的事务构造（纯函数；组件与离线测试共用）
import type { EditorState, Transaction } from 'prosemirror-state'

export function imageAttrsTr(state: EditorState, pos: number, attrs: { caption: string, usage: string, usageDescription: string }): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image') return null
  return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
}
