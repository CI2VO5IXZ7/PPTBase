<template>
  <div class="outline-page">
    <header class="outline-header">
      <div class="title">大纲协作</div>
      <div class="meta">
        <span>v{{ outline.version }} / c{{ outline.contentVersion }}</span>
        <span :class="['save', outline.saveStatus]">{{ saveText }}</span>
        <span v-if="outline.lastError" class="err">{{ outline.lastError }}</span>
        <span v-if="submittedInfo" class="pending">{{ submittedInfo }}</span>
        <span v-if="outline.status?.approval?.valid" class="approved">已确认版本 {{ outline.status.approval.contentVersion }}</span>
        <span v-else-if="outline.status?.approval" class="stale">确认已偏离，请重新确认</span>
        <span v-if="outline.status?.generation" :class="outline.status.generation.stale ? 'stale' : 'approved'">
          制作来源{{ outline.status.generation.stale ? '已失效' : `有效（确认稿 c${outline.status.generation.contentVersion}）` }}
        </span>
      </div>
      <div class="actions">
        <button class="btn drawer-toggle" @click="drawerOpen = !drawerOpen">
          批注<span v-if="outline.openThreads">({{ outline.openThreads }})</span>
        </button>
        <a class="btn" :href="pptUrl" @click="onNavPpt">查看 PPT</a>
        <template v-if="!outline.readonly">
          <button class="btn" :disabled="!canAct" @click="onSubmitFeedback">提交反馈</button>
          <button v-if="!outline.status?.approval?.valid" class="btn primary" :disabled="!canAct" @click="onApprove">确认大纲，进入制作</button>
          <button v-else class="btn" :disabled="!canAct" @click="onRevoke">撤销确认</button>
        </template>
      </div>
    </header>

    <div v-if="outline.saveStatus === 'conflict'" class="banner conflict">
      版本冲突：远端已到 v{{ outline.conflictRemote?.version }}（c{{ outline.conflictRemote?.contentVersion }}）。
      本地未提交修改已保存为草稿（{{ draftSteps }} 步），不会自动丢弃。
      <button class="btn" @click="onDiscardDraft">刷新为最新版本（保留草稿）</button>
      <button v-if="outline.localDraft" class="btn" @click="copyDraft">复制草稿内容</button>
      <button v-if="outline.localDraft" class="btn" @click="outline.dropDraft()">丢弃草稿</button>
    </div>
    <div v-else-if="outline.saveStatus === 'offline'" class="banner">
      保存失败：{{ outline.lastError }}。修改已保留，恢复后会自动重试。
      <button class="btn" @click="sync.flush">立即重试</button>
    </div>
    <div v-else-if="outline.uploadsPending" class="banner warn">图片上传中或失败，先完成/重试再提交反馈或确认。</div>

    <main class="outline-main">
      <OutlineEditor
        ref="editorRef"
        :readonly="outline.readonly"
        :threads="outline.threads"
        :content="editorContent"
        :suspend-refresh="suspendRefresh"
        @steps="onSteps"
        @comment-range="onCommentRange"
        @composing="sync.setComposing"
        @doc-json="sync.trackEditorDoc"
      />
      <CommentsPanel
        v-show="drawerOpen"
        class="panel"
        :threads="outline.threads"
        :submissions="outline.submissions"
        :readonly="outline.readonly"
        @op="onThreadOp"
        @locate="onLocate"
      />
    </main>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { nanoid } from 'nanoid'
import { useDocumentStore } from '@/store/document'
import { useOutlineStore } from '@/store/outline'
import useOutlineSync from '@/hooks/useOutlineSync'
import type { OutlineAnchorSpec, OutlineThread } from '@/types/outline'
import { outlineActionBlocked } from '@/utils/outline/submitGate'
import { submitOutlineFeedback, approveOutline, revokeOutlineApproval, postOutlineOps } from '@/services/outline'
import OutlineEditor from './OutlineEditor.vue'
import CommentsPanel from './CommentsPanel.vue'

const documentStore = useDocumentStore()
const outline = useOutlineStore()
const sync = useOutlineSync()
const editorRef = ref<InstanceType<typeof OutlineEditor>>()
const busy = ref(false)
const drawerOpen = ref(true)
const editorContent = ref<Record<string, unknown> | null>(null)
const suspendRefresh = ref(false)

const pptUrl = computed(() => `/?doc=${documentStore.docId}#t=${documentStore.token}`)
const draftSteps = computed(() => outline.localDraft?.steps.length ?? 0)
// 最新一轮提交 vs 当前内容版本：区分“已提交到 cX”与“其后还有未提交修改”
const submittedInfo = computed(() => {
  const last = outline.submissions[0]
  if (!last) return ''
  const dirty = outline.contentVersion > last.contentVersion
  return `已提交第 ${last.round} 轮（c${last.contentVersion}）${dirty ? '·其后还有未提交修改' : ''}`
})
const canAct = computed(() => !outlineActionBlocked({
  busy: busy.value, readonly: outline.readonly,
  uploadsPending: outline.uploadsPending, saveStatus: outline.saveStatus,
}))

const saveText = computed(() => ({
  saved: '已保存', saving: '保存中…', dirty: '未保存', offline: '保存失败', conflict: '版本冲突',
} as Record<string, string>)[outline.saveStatus])

const onSteps = (steps: Record<string, unknown>[]) => sync.enqueueSteps(steps)

const onThreadOp = async (op: Record<string, unknown>) => {
  if (outline.readonly) return
  // 先冲刷编辑器 300ms 缓冲（打字后秒按批注也不能丢/错基线），再 drain
  editorRef.value?.flushNow()
  await Promise.resolve()
  if (!(await sync.drain())) {
    outline.lastError = '请先解决未保存/冲突内容'; return
  }
  busy.value = true
  try {
    const res = await postOutlineOps(documentStore.docId, outline.version, nanoid(16), [op])
    outline.setVersions(res.version, res.contentVersion)
    await sync.refresh()
  }
  catch (err) {
    const e = err as { message?: string }
    outline.lastError = e.message ?? '批注操作失败'
  }
  finally {
    busy.value = false
  }
}

const onLocate = (t: OutlineThread) => {
  // 定位该线程自身的高亮；脱离/无文档高亮时回退到面板中该线程条目
  const target = document.querySelector(`.ProseMirror [data-thread-id="${t.id}"]`)
    ?? document.querySelector(`.comments-panel [data-thread-id="${t.id}"]`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
const onCommentRange = (anchor: OutlineAnchorSpec) => {
  const content = window.prompt('批注内容')
  if (!content) return
  void onThreadOp({ op: 'addComment', anchor, content })
}

const guard = async () => {
  editorRef.value?.flushNow()
  await Promise.resolve() // 让 flushNow 同步 emit 的 steps 先进入队列
  if (outline.uploadsPending) {
    outline.lastError = '有图片上传未完成'; return false
  }
  return sync.drain()
}

const onSubmitFeedback = async () => {
  if (!(await guard())) {
    outline.lastError = '内容未保存完成，暂不能提交'; return
  }
  busy.value = true
  try {
    await submitOutlineFeedback(documentStore.docId, { requestId: nanoid(16) })
    await sync.refresh()
  }
  catch (err) {
    outline.lastError = (err as { message?: string }).message ?? '提交失败'
  }
  finally {
    busy.value = false
  }
}

const onApprove = async () => {
  if (!(await guard())) {
    outline.lastError = '内容未保存完成，暂不能确认'; return
  }
  busy.value = true
  try {
    await approveOutline(documentStore.docId, { baseVersion: outline.version, requestId: nanoid(16), acknowledgeOpenThreads: false })
    await sync.refresh()
  }
  catch (err) {
    const e = err as { status?: number, issues?: { openThreads?: number }, message?: string }
    if (e.status === 409 && (e.issues as { openThreads?: number })?.openThreads) {
      const n = (e.issues as { openThreads: number }).openThreads
      if (window.confirm(`还有 ${n} 条未解决批注，仍确认当前版本进入制作？`)) {
        await approveOutline(documentStore.docId, { baseVersion: outline.version, requestId: nanoid(16), acknowledgeOpenThreads: true })
        await sync.refresh()
      }
    }
    else outline.lastError = e.message ?? '确认失败'
  }
  finally {
    busy.value = false
  }
}

const onRevoke = async () => {
  busy.value = true
  try {
    await revokeOutlineApproval(documentStore.docId)
    await sync.refresh()
  }
  finally {
    busy.value = false
  }
}

// 冲突：刷新为最新版本，本地草稿保留可复制
const onDiscardDraft = async () => {
  await sync.resolveConflict()
}
const copyDraft = async () => {
  const d = outline.localDraft
  if (!d) return
  const text = JSON.stringify(d.content, null, 2)
  await navigator.clipboard?.writeText(text).catch(() => undefined)
  outline.lastError = '草稿已复制到剪贴板（JSON）'
}

// 导航到 PPT 前 flush 未保存内容
const onNavPpt = async (e: Event) => {
  e.preventDefault()
  editorRef.value?.flushNow()
  if (!(await sync.drain())) {
    if (window.confirm('有未保存内容或保存失败，仍要离开？')) window.location.href = pptUrl.value
    return
  }
  window.location.href = pptUrl.value
}

// 关闭前处理未保存内容（flush 尽力而为 + 警告）
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  editorRef.value?.flushNow()
  void sync.flush()
  if (sync.hasUnsavedChanges()) {
    e.preventDefault(); e.returnValue = ''
  }
}

// 有未保存内容或 IME 中：挂起远端刷新，避免重建编辑器打断输入
watch(() => outline.saveStatus, s => {
  suspendRefresh.value = s === 'dirty' || s === 'saving' || s === 'conflict'
}, { immediate: true })
watch(() => outline.content, c => {
  if (c && !sync.hasUnsavedChanges()) editorContent.value = c
}, { deep: false })

onMounted(async () => {
  try {
    await sync.init()
    editorContent.value = outline.content
    window.addEventListener('beforeunload', onBeforeUnload)
  }
  catch {
    outline.lastError = '大纲加载失败'
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  editorRef.value?.flushNow()
  void sync.drain()
  sync.destroy()
})
</script>

<style lang="scss" scoped>
.outline-page { height: 100%; display: flex; flex-direction: column; }
.outline-header {
  display: flex; align-items: center; gap: 12px; padding: 8px 16px;
  border-bottom: 1px solid #e5e5e5; flex-wrap: wrap;
  .title { font-size: 16px; font-weight: 600; }
  .meta { flex: 1; display: flex; gap: 10px; font-size: 12px; color: #666; flex-wrap: wrap; }
  .save.dirty, .save.offline, .save.conflict, .err { color: #d97706; }
  .approved { color: #059669; }
  .stale { color: #d97706; }
}
.actions { display: flex; gap: 8px; }
.btn {
  font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px;
  background: #fff; cursor: pointer; text-decoration: none; color: #333;
  &.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  &:disabled { opacity: 0.5; cursor: default; }
}
.banner { padding: 8px 16px; background: #fef3c7; font-size: 13px; &.conflict { background: #fee2e2; } &.warn { background: #fef9c3; } }
.outline-main { flex: 1; display: flex; min-height: 0; }
.panel { width: 300px; border-left: 1px solid #e5e5e5; flex-shrink: 0; }
@media (max-width: 860px) {
  .panel { position: fixed; right: 0; top: 0; bottom: 0; z-index: 20; background: #fff; box-shadow: -2px 0 8px rgba(0,0,0,.12); }
}
</style>
