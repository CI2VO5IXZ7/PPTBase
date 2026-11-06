<template>
  <div class="outline-editor-wrap">
    <div v-if="!readonly" class="outline-toolbar">
      <button class="pick-btn" @click="pickImages">插入图片</button>
    </div>
    <div ref="editorRef" class="outline-editor" />
  </div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Plugin, PluginKey, type Transaction } from 'prosemirror-state'

import { undo, redo, history } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { nanoid } from 'nanoid'
import { uploadAsset } from '@/services/document'
import { useDocumentStore } from '@/store/document'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { outlineViewSchema } from '@/utils/outline/viewSchema'
import type { OutlineAnchorSpec, OutlineThread } from '@/types/outline'

const props = defineProps<{ readonly: boolean, threads: OutlineThread[], content?: Record<string, unknown> | null }>()
const documentStore = useDocumentStore()
const emit = defineEmits<{
  steps: [steps: Record<string, unknown>[]]
  'comment-range': [anchor: OutlineAnchorSpec]
}>()

const editorRef = ref<HTMLElement>()
let view: EditorView | null = null
let pendingSteps: Record<string, unknown>[] = []

function pickImages() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp'
  input.multiple = true
  input.onchange = () => void insertImages(Array.from(input.files ?? []))
  input.click()
}

async function insertImages(files: File[]) {
  if (!view) return
  for (const file of files) {
    const asset = await uploadAsset(documentStore.docId, file).catch(() => null)
    if (!asset) return
    const tr = view.state.tr.replaceSelectionWith(
      outlineViewSchema.nodes.image.create({ blockId: `b_${nanoid(10)}`, src: asset.url, alt: file.name, caption: '', usage: 'illustration', usageDescription: '' })
    ).scrollIntoView()
    view.dispatch(tr)
  }
}
let flushTimer: ReturnType<typeof setTimeout> | null = null

const blockIdKey = new PluginKey('outlineBlockIds')
const threadMarkKey = new PluginKey('outlineThreads')

// 新写入的区块自动分配稳定 blockId；已有 id 保留（协作锚点依赖）
function ensureBlockIds(state: EditorState, tr: Transaction) {
  const seen = new Set<string>()
  tr.doc.descendants(node => {
    if (node.attrs.blockId) seen.add(node.attrs.blockId)
    return true
  })
  let changed = false
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'doc' || node.type.name === 'text' || !node.isBlock) return true
    const bid = node.attrs.blockId
    if (!bid || seen.has(bid) && !node.attrs.blockId) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: `b_${nanoid(10)}` })
      changed = true
    }
    return true
  })
  return changed
}

// 文本范围锚点 → 跨区块 Decoration 高亮（block 锚点 → 节点样式）
function threadDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = []
  const doc = state.doc
  const byText = new Map<string, number>() // blockId -> 起点
  doc.descendants((node, pos) => {
    if (node.attrs.blockId) byText.set(node.attrs.blockId, pos)
    return true
  })
  for (const t of props.threads) {
    if (t.detached) continue
    const a = t.anchor
    const cls = t.status === 'resolved' ? 'thread-hl resolved' : 'thread-hl'
    if ((a.kind === 'block' || a.kind === 'image') && a.blockId) {
      // 优先用每次写入后刷新的 pos；退化时按 blockId 找
      const start = a.pos !== undefined && doc.nodeAt(a.pos)?.attrs.blockId === a.blockId ? a.pos : byText.get(a.blockId)
      if (start === undefined) continue
      const node = doc.nodeAt(start)
      if (node) decos.push(Decoration.node(start, start + node.nodeSize, { class: cls }))
    }
    else if (a.kind === 'textRange') {
      // fragments 的 from/to 已是当前文档位置（服务端每次写入刷新），天然支持跨区块
      for (const f of a.fragments ?? []) {
        if (f.detached) continue
        if (f.to > f.from && f.to <= doc.content.size) {
          decos.push(Decoration.inline(f.from, f.to, { class: cls }))
        }
      }
    }
  }
  return DecorationSet.create(doc, decos)
}

onMounted(() => {
  const state = EditorState.create({
    schema: outlineViewSchema,
    doc: props.content ? outlineViewSchema.nodeFromJSON(props.content) : undefined,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo, 'Mod-b': toggleMark(outlineViewSchema.marks.strong), 'Mod-i': toggleMark(outlineViewSchema.marks.em) }),
      keymap(baseKeymap),
      new Plugin({
        key: blockIdKey,
        appendTransaction(transactions, _old, newState) {
          if (transactions.every(t => !t.docChanged)) return
          const tr = newState.tr
          return ensureBlockIds(newState, tr) ? tr : null
        },
      }),
      new Plugin({
        key: threadMarkKey,
        props: {
          decorations: state => threadDecorations(state),
          handleDOMEvents: {
            compositionstart: () => false,
            // 图片粘贴/拖拽 → 上传到 /api/docs/:id/assets 后插 image 节点
            paste: (_v, event) => {
              const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
              if (!files.length || props.readonly) return false
              event.preventDefault()
              void insertImages(files)
              return true
            },
            drop: (_v, event) => {
              const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
              if (!files.length || props.readonly) return false
              event.preventDefault()
              void insertImages(files)
              return true
            },
          },
        },
      }),
    ],
  })
  view = new EditorView(editorRef.value!, {
    state,
    editable: () => !props.readonly,
    dispatchTransaction(tr) {
      const newState = view!.state.apply(tr)
      view!.updateState(newState)
      if (tr.docChanged) {
        for (const step of tr.steps) pendingSteps.push(step.toJSON() as Record<string, unknown>)
        if (pendingSteps.length > 400) pendingSteps = pendingSteps.slice(-400)
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = setTimeout(() => {
          const batch = pendingSteps.splice(0)
          if (batch.length) emit('steps', batch)
        }, 300)
      }
    },
  })
})

watch(() => props.content, content => {
  if (!view || !content) return
  const state = EditorState.create({
    schema: outlineViewSchema,
    doc: outlineViewSchema.nodeFromJSON(content),
    plugins: view.state.plugins,
  })
  view.updateState(state)
})

watch(() => props.readonly, () => view?.updateState(view.state))

onBeforeUnmount(() => {
  if (flushTimer) clearTimeout(flushTimer)
  const batch = pendingSteps.splice(0)
  if (batch.length) emit('steps', batch)
  view?.destroy()
  view = null
})

defineExpose({ replaceDoc(c: Record<string, unknown>) {
  if (!view) return
  view.updateState(EditorState.create({ schema: outlineViewSchema, doc: outlineViewSchema.nodeFromJSON(c), plugins: view.state.plugins }))
} })
</script>

<style lang="scss">
.outline-editor-wrap { flex: 1; overflow-y: auto; }
.outline-toolbar { padding: 8px 24px 0; max-width: 760px; margin: 0 auto; }
.pick-btn { font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px; background: #fff; cursor: pointer; }
.outline-editor {
  max-width: 760px; margin: 0 auto; padding: 32px 24px;
  .ProseMirror { outline: none; min-height: 60vh; line-height: 1.7; }
  h1 { font-size: 28px; margin: 20px 0 10px; }
  h2 { font-size: 22px; margin: 18px 0 8px; }
  h3 { font-size: 17px; margin: 14px 0 6px; }
  p { margin: 6px 0; }
  blockquote { border-left: 3px solid #d4d4d4; margin: 8px 0; padding: 2px 0 2px 14px; color: #555; }
  figure.outline-image { margin: 12px 0; img { max-width: 100%; } figcaption { font-size: 13px; color: #777; } }
  hr { border: none; border-top: 1px solid #d4d4d4; margin: 16px 0; }
  .thread-hl { background: #fef08a; &.resolved { background: #dcfce7; } }
}
</style>
