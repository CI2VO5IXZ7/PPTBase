// 线程锚点 → DecorationSet（生产与测试共用同一实现）。
// textRange 用 fromOffset/toOffset（块相对偏移）经 blockId 定位映射回当前文档坐标；
// 绝对 from/to 仅代表服务端映射时刻，本地编辑后不再可信。
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, type EditorState, type PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorProps } from 'prosemirror-view'
import type { OutlineThread } from '../../types/outline'

export function buildThreadDecorations(doc: PMNode, threads: OutlineThread[]): DecorationSet {
  const decos: Decoration[] = []
  const byId = new Map<string, number>()
  doc.descendants((node, pos) => {
    if (node.attrs.blockId) byId.set(node.attrs.blockId, pos); return true
  })
  for (const t of threads) {
    if (t.detached) continue
    const cls = t.status === 'resolved' ? 'thread-hl resolved' : 'thread-hl'
    const a = t.anchor
    if ((a.kind === 'block' || a.kind === 'image') && a.blockId) {
      const start = a.pos !== undefined && doc.nodeAt(a.pos)?.attrs.blockId === a.blockId ? a.pos : byId.get(a.blockId)
      if (start === undefined) continue
      const node = doc.nodeAt(start)
      if (node) decos.push(Decoration.node(start, start + node.nodeSize, { class: cls, 'data-thread-id': t.id }))
    }
    else if (a.kind === 'textRange') {
      for (const f of a.fragments ?? []) {
        if (f.detached) continue
        const bStart = byId.get(f.blockId)
        if (bStart === undefined) continue // 块已被删除：跳过，待服务端映射后标 detached
        const node = doc.nodeAt(bStart)
        const contentSize = node ? node.nodeSize - 2 : 0
        const from = bStart + 1 + f.fromOffset
        const to = bStart + 1 + f.toOffset
        if (to > from && to <= bStart + 1 + contentSize) decos.push(Decoration.inline(from, to, { class: cls, 'data-thread-id': t.id }))
      }
    }
  }
  return DecorationSet.create(doc, decos)
}

// 线程内容签名：仅锚点/状态/脱离等影响装饰的字段参与比较
const threadsSig = (threads: OutlineThread[]) => threads.map(t => {
  const a = t.anchor
  const frags = (a.fragments ?? []).map(f => `${f.blockId}:${f.fromOffset}:${f.toOffset}:${f.detached ?? 0}`).join(',')
  return `${t.id}|${t.status}|${t.detached}|${a.kind}|${a.blockId ?? ''}|${a.pos ?? ''}|${frags}`
}).join('#')

// 生产装饰插件：插件状态持有 DecorationSet，本地事务经 set.map(tr.mapping) 平移；
// 仅当服务端线程快照（签名）变化时整组重建——不会双重映射。
export function createThreadDecoPlugin(
  key: PluginKey,
  getThreads: () => OutlineThread[],
  extraProps?: EditorProps,
): Plugin {
  let lastSig: string | null = null
  return new Plugin({
    key,
    state: {
      init: (_config, state: EditorState) => {
        lastSig = threadsSig(getThreads())
        return buildThreadDecorations(state.doc, getThreads())
      },
      apply: (tr, set, _old, newState) => {
        const sig = threadsSig(getThreads())
        if (sig !== lastSig) {
          lastSig = sig
          return buildThreadDecorations(newState.doc, getThreads())
        }
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
      },
    },
    props: {
      decorations: state => key.getState(state) as DecorationSet,
      ...(extraProps ?? {}),
    },
  })
}
