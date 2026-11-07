// 稳定 blockId 插件（生产与测试共用）：appendTransaction 补缺/去重，
// 同时把追加事务的 steps 导出给同步队列——否则客户端 blockId 与服务端重放分叉。
import { nanoid } from 'nanoid'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state'
import type { Step } from 'prosemirror-transform'

// 新增/缺省/重复 blockId 一律重新生成（协作锚点依赖唯一性）；追加 setNodeMarkup 进 tr
export function ensureBlockIds(doc: PMNode, tr: Transaction): boolean {
  const seen = new Set<string>()
  const fixes: { pos: number, attrs: Record<string, unknown> }[] = []
  doc.descendants((node, pos) => {
    if (!node.isBlock || node.type.name === 'doc') return true
    const bid = String(node.attrs.blockId ?? '')
    if (!bid || seen.has(bid)) fixes.push({ pos, attrs: { ...node.attrs, blockId: `b_${nanoid(10)}` } })
    else seen.add(bid)
    return true
  })
  for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, f.attrs)
  return fixes.length > 0
}

// onSteps：追加事务的 step（blockId 修正）交给调用方并入同步队列
export function createBlockIdPlugin(key: Plugin['key'], onSteps?: (steps: Step[]) => void): Plugin {
  return new Plugin({
    key,
    appendTransaction(transactions, _old: EditorState, newState: EditorState) {
      if (transactions.every(t => !t.docChanged)) return null
      const tr = newState.tr
      if (!ensureBlockIds(newState.doc, tr)) return null
      onSteps?.(tr.steps)
      return tr
    },
  })
}
