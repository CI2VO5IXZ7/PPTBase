<template>
  <div class="outline-editor-wrap">
    <div v-if="!readonly" class="outline-toolbar">
      <template v-for="b in toolbar" :key="b.label">
        <button :class="{ active: b.active?.() }" :title="b.title" @click="b.run">{{ b.label }}</button>
      </template>
      <button :disabled="!canMoveUp" title="顶层区块上移" @click="emitMove('up')">上移</button>
      <button :disabled="!canMoveDown" title="顶层区块下移" @click="emitMove('down')">下移</button>
      <button class="comment-btn" :disabled="!canComment" title="对当前选区/区块加批注" @click="commentSelection">批注</button>
      <button class="pick-btn" :disabled="uploading" @click="pickImages">{{ uploading ? '上传中…' : '插入图片' }}</button>
    </div>
    <div v-for="u in uploads" :key="u.id" :class="['upload-item', u.status]">
      {{ u.name }} — {{ u.status === 'uploading' ? '上传中…' : u.status === 'error' ? `失败：${u.error}` : '完成' }}
      <button v-if="u.status === 'error'" @click="retryUpload(u)">重试</button>
      <button v-if="u.status === 'error'" @click="removeUpload(u)">移除</button>
    </div>
    <div v-if="imageSel" class="image-attrs">
      <label>说明<input v-model="imageSel.caption" placeholder="图注" @change="applyImageAttrs" /></label>
      <label>用途
        <select v-model="imageSel.usage" @change="applyImageAttrs">
          <option value="reference">参考</option>
          <option value="include">放入页面</option>
        </select>
      </label>
      <label>给 Agent 的说明<input v-model="imageSel.usageDescription" placeholder="图片内容/用法说明" @change="applyImageAttrs" /></label>
      <button @click="imageSel = null">完成</button>
    </div>
    <div ref="editorRef" class="outline-editor" />
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useOutlineStore } from '@/store/outline'
import { EditorState, NodeSelection, PluginKey, type Command } from 'prosemirror-state'
import type { Step } from 'prosemirror-transform'
import { EditorView } from 'prosemirror-view'
import { createThreadDecoPlugin } from '@/utils/outline/threadDeco'
import { createBlockIdPlugin } from '@/utils/outline/blockIds'
import { imageAttrsTr, remapImageSel } from '@/utils/outline/imageOps'
import {
  applyUploadedImage,
  canDispatchImage,
  canMoveOutlineBlock,
  flushHeldImages,
  uploadStatusAfterInsert,
  type ImageHold,
  type UploadedImage,
} from '@/utils/outline/imageInsert'
import { undo, redo, history } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands'
import { splitListItem, liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list'
import { nanoid } from 'nanoid'
import { outlineViewSchema } from '@/utils/outline/viewSchema'
import type { OutlineAnchorSpec, OutlineThread } from '@/types/outline'
import { textRangeFragmentTexts } from '@/utils/outline/anchors'
import { selectionToAnchorSpec } from '@/utils/outline/anchorSpec'
import { unchangedLinkRange } from '@/utils/outline/editorGuards'
import { blockAtSelection, selectionForBlock, selectionKeepingBlock } from '@/utils/outline/selectionMeta'
import { topLevelBlockIds } from '@/utils/outline/navigatorTree'
import { uploadAsset } from '@/services/document'
import { useDocumentStore } from '@/store/document'

const props = defineProps<{
  readonly: boolean
  threads: OutlineThread[]
  content?: Record<string, unknown> | null
  suspendRefresh?: boolean // IME/未保存期间父级延迟远端替换
}>()
const emit = defineEmits<{
  steps: [steps: Record<string, unknown>[]]
  'comment-range': [anchor: OutlineAnchorSpec]
  'request-link': []
  'request-move': [payload: { blockId: string, direction: 'up' | 'down' }]
  'selection-block': [blockId: string | null, topLevel: boolean]
  composing: [v: boolean]
  'doc-json': [doc: Record<string, unknown>]
}>()

const documentStore = useDocumentStore()
const outlineStore = useOutlineStore()
const editorRef = ref<HTMLElement>()
const uploads = ref<{ id: string, name: string, file: File, status: 'uploading' | 'error' | 'done', error?: string }[]>([])
const imageSel = ref<{ pos: number, blockId: string, caption: string, usage: string, usageDescription: string } | null>(null)
const canComment = ref(true)
const selectedTopBlock = ref<string | null>(null)
const isTopLevel = ref(false)
// moveNeighbor 读的是 EditorView 文档，不是响应式依赖。正文替换后选中 id 可能不变，靠修订号重算按钮。
const docRev = ref(0)
const moveLocked = ref(false)
const uploading = computed(() => uploads.value.some(u => u.status === 'uploading'))
const uploadingCount = computed(() => uploads.value.filter(u => u.status !== 'done').length)
const canMoveUp = computed(() => canMoveOutlineBlock({
  readonly: props.readonly,
  moveLocked: moveLocked.value,
  uploadsPending: uploadingCount.value,
  topLevel: isTopLevel.value,
  hasBlock: !!selectedTopBlock.value,
  hasNeighbor: docRev.value >= 0 && moveNeighbor('up'),
}))
const canMoveDown = computed(() => canMoveOutlineBlock({
  readonly: props.readonly,
  moveLocked: moveLocked.value,
  uploadsPending: uploadingCount.value,
  topLevel: isTopLevel.value,
  hasBlock: !!selectedTopBlock.value,
  hasNeighbor: docRev.value >= 0 && moveNeighbor('down'),
}))

let view: EditorView | null = null
let imageHold: ImageHold = { queued: [] }
const pendingSteps: Record<string, unknown>[] = []
const appendedSteps: Step[] = [] // appendTransaction 补的 blockId 修正，必须与原始 steps 同批发送
let flushTimer: ReturnType<typeof setTimeout> | null = null

const blockIdKey = new PluginKey('outlineBlockIds')
const threadMarkKey = new PluginKey('outlineThreads')

const S = outlineViewSchema


// ── 工具栏命令 ──
const cmd = (c: Command) => () => {
  if (view) c(view.state, view.dispatch, view); view?.focus()
}
const toolbar = computed(() => [
  { label: 'H1', title: '标题1', run: cmd(setBlockType(S.nodes.heading, { level: 1 })), active: () => blockActive('heading', 1) },
  { label: 'H2', title: '标题2', run: cmd(setBlockType(S.nodes.heading, { level: 2 })), active: () => blockActive('heading', 2) },
  { label: 'H3', title: '标题3', run: cmd(setBlockType(S.nodes.heading, { level: 3 })), active: () => blockActive('heading', 3) },
  { label: '¶', title: '正文', run: cmd(setBlockType(S.nodes.paragraph)) },
  { label: '•列表', title: '无序列表', run: cmd(wrapList(S.nodes.bullet_list)) },
  { label: '1.列表', title: '有序列表', run: cmd(wrapList(S.nodes.ordered_list)) },
  { label: '→缩进', title: '列表降一级', run: cmd(sinkListItem(S.nodes.list_item)) },
  { label: '←提升', title: '列表升一级', run: cmd(liftListItem(S.nodes.list_item)) },
  { label: '❝', title: '引用', run: cmd(wrapIn(S.nodes.blockquote)) },
  { label: '―', title: '分隔线', run: cmd(insertHr) },
  { label: 'B', title: '加粗', run: cmd(toggleMark(S.marks.strong)) },
  { label: 'I', title: '斜体', run: cmd(toggleMark(S.marks.em)) },
  { label: '🔗', title: '链接', run: toggleLink },
  { label: '↩', title: '撤销', run: cmd(undo) },
  { label: '↪', title: '重做', run: cmd(redo) },
])

function blockActive(name: string, level?: number) {
  if (!view) return false
  const { $from } = view.state.selection
  const n = $from.parent
  return n.type.name === name && (level === undefined || n.attrs.level === level)
}
// 使用 prosemirror-schema-list 的标准 wrapInList：保留选区文本、嵌套列表正确、caret 落 list_item 内
// 包装时给新 list/list_item 预分配 blockId（appendTransaction 再兜底补缺）
function wrapList(type: typeof S.nodes.bullet_list): Command {
  return wrapInList(type, { blockId: '' })
}
const insertHr: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(S.nodes.horizontal_rule.create({ blockId: `b_${nanoid(10)}` })).scrollIntoView())
  return true
}
let pendingLink: { from: number, to: number, docRev: number } | null = null
function toggleLink() {
  if (!view) return
  const { state } = view
  if (state.selection.empty) return
  pendingLink = { from: state.selection.from, to: state.selection.to, docRev: docRev.value }
  emit('request-link')
}

function moveNeighbor(dir: 'up' | 'down'): boolean {
  if (!view || !selectedTopBlock.value) return false
  const ids = topLevelBlockIds(view.state.doc.toJSON() as Record<string, unknown>)
  const i = ids.indexOf(selectedTopBlock.value)
  if (i < 0) return false
  if (dir === 'up') return i > 0
  return i < ids.length - 1
}

function emitMove(direction: 'up' | 'down') {
  if (moveLocked.value || !selectedTopBlock.value || !isTopLevel.value) return
  emit('request-move', { blockId: selectedTopBlock.value, direction })
}

function setMoveLock(on: boolean) {
  moveLocked.value = on
  // 立刻重算 contenteditable。只改 ref 时，慢请求期间浏览器仍可能把按键写进正文。
  if (view) view.updateState(view.state)
  if (!on) flushQueuedImages()
}

function contentRevision() {
  return docRev.value
}

function refreshSelectionMeta() {
  if (!view) return
  const hit = blockAtSelection(view.state.doc, view.state.selection)
  selectedTopBlock.value = hit.blockId
  isTopLevel.value = hit.topLevel
  emit('selection-block', hit.blockId, hit.topLevel)
}

function scrollToBlockId(blockId: string) {
  if (!view) return
  const sel = selectionForBlock(view.state.doc, blockId)
  if (!sel) return
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  view.focus()
  refreshSelectionMeta()
}

// ── 选区批注：文字选区→textRange fragments（跨区块逐片段）；块级选区/光标所在块→block；图片节点→image ──
function commentSelection() {
  if (!view) return
  emit('comment-range', selectionToAnchorSpec(view.state.doc, view.state.selection))
}

// ── 图片：选择/粘贴/拖拽上传（≤5MB、类型白名单、逐项进度/失败重试）──
const MAX_IMAGE = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
function checkFile(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return '仅支持 PNG/JPEG/GIF/WebP'
  if (file.size > MAX_IMAGE) return '图片超过 5MB'
  return null
}
function pickImages() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = IMAGE_TYPES.join(',')
  input.multiple = true
  input.onchange = () => void insertImages(Array.from(input.files ?? []))
  input.click()
}
async function insertImages(files: File[]) {
  for (const file of files) {
    const err = checkFile(file)
    if (err) {
      uploads.value.push({ id: nanoid(8), name: file.name, file, status: 'error', error: err })
      continue
    }
    const item = { id: nanoid(8), name: file.name, file, status: 'uploading' as const }
    uploads.value.push(item)
    await doUpload(item)
  }
}
async function doUpload(item: { id: string, name: string, file: File, status: string, error?: string }) {
  const asset = await uploadAsset(documentStore.docId, item.file).catch((e: Error) => ({ err: e.message }))
  const u = uploads.value.find(x => x.id === item.id)
  if (!u) return
  if ('err' in asset) {
    u.status = 'error'
    u.error = (asset as { err: string }).err
    return
  }
  insertImageNode(asset.url, item.file.name, asset.id, item.id)
}
function retryUpload(u: (typeof uploads.value)[number]) {
  u.status = 'uploading'
  u.error = undefined
  void doUpload(u)
}
function removeUpload(u: (typeof uploads.value)[number]) {
  uploads.value = uploads.value.filter(x => x.id !== u.id)
}
// 只读切换时清掉未上传占位（视图态不应挂起提交）。已拿到的 asset 仍留在队列，只读期间不插入。
watch(() => props.readonly, ro => {
  if (ro) uploads.value = []
  else flushQueuedImages()
})
function insertGate() {
  return { readonly: props.readonly, hasView: !!view, moveLocked: moveLocked.value }
}
function editorDispatchImage(image: UploadedImage): boolean {
  if (!view || !canDispatchImage(insertGate())) return false
  const revision = docRev.value
  const tr = view.state.tr.replaceSelectionWith(
    S.nodes.image.create({ blockId: `b_${nanoid(10)}`, src: image.src, alt: image.name, caption: '', usage: 'reference', usageDescription: '', assetId: image.assetId }),
  ).scrollIntoView()
  // 移动锁期间 dispatchTransaction 会丢掉 docChanged。这里必须当成没插入。
  if (!canDispatchImage(insertGate()) || !tr.docChanged) return false
  view.dispatch(tr)
  return docRev.value !== revision
}
function rememberInserted(image: UploadedImage) {
  const row = uploads.value.find(item => item.id === image.uploadId)
  if (!row || row.status === 'error') return
  row.status = uploadStatusAfterInsert(true)
}
function insertImageNode(src: string, name: string, assetId = '', uploadId = ''): boolean {
  const image: UploadedImage = { uploadId, src, name, assetId }
  const result = applyUploadedImage(imageHold, image, insertGate(), editorDispatchImage)
  imageHold = result.hold
  if (result.inserted) rememberInserted(image)
  return result.inserted
}
function flushQueuedImages() {
  const result = flushHeldImages(imageHold, insertGate(), editorDispatchImage)
  imageHold = result.hold
  for (const image of result.inserted) rememberInserted(image)
}
function applyImageAttrs() {
  if (!view || !imageSel.value) return
  const located = remapImageSel(view.state.doc, imageSel.value)
  if (!located) {
    imageSel.value = null
    return
  }
  imageSel.value = located
  const tr = imageAttrsTr(view.state, located.blockId, {
    caption: located.caption, usage: located.usage, usageDescription: located.usageDescription,
  })
  if (!tr) {
    imageSel.value = null
    return
  }
  view.dispatch(tr)
  // 保持面板打开：用户可连续修改多个字段，显式「完成」或图片被删时才关闭
}
function openImageAttrs(pos: number) {
  if (!view || props.readonly) return
  const node = view.state.doc.nodeAt(pos)
  // 原子节点必须真正选中（NodeSelection），否则 commentSelection 不会产出 image 锚点
  try {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).scrollIntoView())
  }
  catch { /* 位置失效时保持原选区 */ }
  if (!node || node.type.name !== 'image') return
  imageSel.value = { pos, blockId: node.attrs.blockId, caption: node.attrs.caption ?? '', usage: node.attrs.usage ?? 'reference', usageDescription: node.attrs.usageDescription ?? '' }
}

// ── EditorView ──
onMounted(() => {
  const state = EditorState.create({
    schema: S,
    doc: props.content ? S.nodeFromJSON(props.content) : undefined,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo, 'Mod-b': toggleMark(S.marks.strong), 'Mod-i': toggleMark(S.marks.em), 'Enter': chainCommands(splitListItem(S.nodes.list_item), exitCode) }),
      keymap(baseKeymap),
      createBlockIdPlugin(blockIdKey, steps => appendedSteps.push(...steps)),
      createThreadDecoPlugin(threadMarkKey, () => props.threads, {
        handleDOMEvents: {
          compositionstart: () => {
            emit('composing', true); return false
          },
          compositionend: () => {
            emit('composing', false); return false
          },
          click: (_v, event) => {
            const pos = view?.posAtCoords({ left: event.clientX, top: event.clientY })
            if (!pos || !view) return false
            // atom 叶子节点：pos.pos 命中节点起点；pos.inside 只会是父容器
            for (const cand of [pos.pos, pos.inside]) {
              const n = cand >= 0 ? view.state.doc.nodeAt(cand) : null
              if (n?.type.name === 'image') {
                openImageAttrs(cand); return true
              }
            }
            return false
          },
          paste: (_v, event) => {
            const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
            if (!files.length || props.readonly) return false
            event.preventDefault(); void insertImages(files); return true
          },
          drop: (_v, event) => {
            const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
            if (!files.length || props.readonly) return false
            event.preventDefault(); void insertImages(files); return true
          },
        },
      }),
    ],
  })
  watch(() => props.threads, () => {
    if (view) view.dispatch(view.state.tr) // 线程快照变化 → 装饰插件按签名整体重建
  })
  view = new EditorView(editorRef.value!, {
    state,
    editable: () => !props.readonly && !moveLocked.value,
    dispatchTransaction(tr) {
      if (moveLocked.value && tr.docChanged) return
      const newState = view!.state.apply(tr)
      view!.updateState(newState)
      canComment.value = true
      if (imageSel.value && tr.docChanged) {
        imageSel.value = remapImageSel(newState.doc, imageSel.value)
      }
      if (tr.selectionSet || tr.docChanged) refreshSelectionMeta()
      if (tr.docChanged) {
        docRev.value++
        // 收集全部实际 step：原始 tr.steps + appendTransaction 补的 blockId 修正
        for (const step of tr.steps) pendingSteps.push(step.toJSON() as Record<string, unknown>)
        for (const step of appendedSteps.splice(0)) pendingSteps.push(step.toJSON() as Record<string, unknown>)
        emit('doc-json', newState.doc.toJSON() as Record<string, unknown>)
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = setTimeout(() => {
          const batch = pendingSteps.splice(0)
          if (batch.length) emit('steps', batch)
        }, 300)
      }
    },
  })
  refreshSelectionMeta()
  flushQueuedImages()
})

function applyLinkHref(href: string) {
  if (!view) return
  const range = unchangedLinkRange(pendingLink, docRev.value)
  pendingLink = null
  if (!range) {
    outlineStore.lastError = '正文已变化，请重新选择文字后再添加链接'
    return
  }
  view.dispatch(view.state.tr.addMark(range.from, range.to, S.marks.link.create({ href, title: '' })))
  view.focus()
}

function anchorFragmentTexts(spec: OutlineAnchorSpec): string[] | null {
  if (!view) return null
  return textRangeFragmentTexts(view.state.doc, spec)
}

// 远端正文替换：suspendRefresh（未保存/IME）时不重建
watch(() => props.content, content => {
  if (!view || !content || props.suspendRefresh) return
  // 本地有未发出的 steps（300ms 缓冲）时绝不重建；内容相同（自回显）也跳过——保选区/undo
  if (pendingSteps.length > 0) return
  const next = S.nodeFromJSON(content)
  if (next.eq(view.state.doc)) return
  const keepId = selectedTopBlock.value
  const preferNode = view.state.selection instanceof NodeSelection
  view.updateState(EditorState.create({ schema: S, doc: next, plugins: view.state.plugins }))
  // updateState 不走 dispatchTransaction。选区恢复那次 dispatch 往往没有 docChanged，必须先按 blockId 重映射。
  if (imageSel.value) imageSel.value = remapImageSel(view.state.doc, imageSel.value)
  if (keepId) {
    const sel = selectionKeepingBlock(view.state.doc, keepId, preferNode)
    if (sel) view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  }
  refreshSelectionMeta()
  docRev.value++
})
watch(() => props.readonly, () => view?.updateState(view.state))

onBeforeUnmount(() => {
  if (flushTimer) clearTimeout(flushTimer)
  const batch = pendingSteps.splice(0)
  if (batch.length) emit('steps', batch)
  view?.destroy()
  view = null
})

// 父级 drain：立即冲刷 debounce 队列（保存前/导航前调用）
function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer); flushTimer = null
  }
  const batch = pendingSteps.splice(0)
  if (batch.length) emit('steps', batch)
}
watch(uploadingCount, n => outlineStore.setUploadsPending(n), { immediate: true })

defineExpose({
  flushNow,
  pendingUploads: uploadingCount,
  scrollToBlockId,
  applyLinkHref,
  anchorFragmentTexts,
  contentRevision,
  setMoveLock,
  get selectedBlockId() { return selectedTopBlock.value },
  get isTopLevelSelection() { return isTopLevel.value },
})
</script>

<style lang="scss">
.outline-editor-wrap { flex: 1; overflow-y: auto; }
.outline-toolbar {
  position: sticky; top: 0; z-index: 2; background: #fff;
  max-width: 760px; margin: 0 auto; padding: 8px 24px 4px;
  display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #eee;
  button { font-size: 12px; padding: 3px 8px; border: 1px solid #d4d4d4; border-radius: 4px; background: #fff; cursor: pointer; }
  button.active { background: #dbeafe; border-color: #2563eb; }
  button:disabled { opacity: 0.5; cursor: default; }
}
.upload-item { font-size: 12px; padding: 2px 24px; max-width: 760px; margin: 0 auto; color: #666; &.error { color: #dc2626; } }
.image-attrs {
  max-width: 760px; margin: 4px auto; padding: 8px 24px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  background: #f8fafc; border: 1px solid #e5e5e5; border-radius: 6px; font-size: 12px;
  input { font-size: 12px; padding: 3px 6px; border: 1px solid #d4d4d4; border-radius: 4px; }
}
.outline-editor {
  max-width: 760px; margin: 0 auto; padding: 16px 24px 48px;
  .ProseMirror { outline: none; min-height: 60vh; line-height: 1.7; }
  h1 { font-size: 28px; margin: 20px 0 10px; }
  h2 { font-size: 22px; margin: 18px 0 8px; }
  h3 { font-size: 17px; margin: 14px 0 6px; }
  p { margin: 6px 0; }
  blockquote { border-left: 3px solid #d4d4d4; margin: 8px 0; padding: 2px 0 2px 14px; color: #555; }
  figure.outline-image { margin: 12px 0; img { max-width: 100%; } figcaption { font-size: 13px; color: #777; } }
  hr { border: none; border-top: 1px solid #d4d4d4; margin: 16px 0; }
  .thread-hl { background: #fef08a; &.resolved { background: #dcfce7; } }
  .ProseMirror-selectednode { outline: 2px solid #2563eb; }
}
</style>
