<template>
  <div class="outline-page">
    <header class="outline-header">
      <div class="title">大纲协作</div>
      <OutlineWorkflowStatus
        class="workflow"
        :approval="outline.status?.approval"
        :generation="outline.status?.generation"
      />
      <div class="meta">
        <span>v{{ outline.version }} / c{{ outline.contentVersion }}</span>
        <span :class="['save', outline.saveStatus]">{{ saveText }}</span>
        <span v-if="outline.lastError" class="err">{{ outline.lastError }}</span>
        <span v-if="submittedInfo" class="pending">{{ submittedInfo }}</span>
      </div>
      <div class="actions">
        <button v-if="isNarrow" type="button" class="btn drawer-toggle" @click="navOpen = !navOpen">树</button>
        <button class="btn drawer-toggle" @click="drawerOpen = !drawerOpen">
          批注<span v-if="outline.openThreads">({{ outline.openThreads }})</span>
        </button>
        <a class="btn" :href="pptUrl" @click="onNavPpt">查看 PPT</a>
        <template v-if="!outline.readonly">
          <button class="btn" :disabled="!canAct" @click="onSubmitFeedback">提交反馈</button>
          <button v-if="!outline.status?.approval?.valid" class="btn primary" :disabled="!canAct" @click="onApprove">确认大纲</button>
          <button v-else class="btn" :disabled="!canAct" @click="onRevoke">撤销确认</button>
        </template>
      </div>
    </header>

    <div v-if="outline.saveStatus === 'conflict' || outline.localDraft" class="banner conflict">
      <template v-if="outline.saveStatus === 'conflict'">
        <strong>版本冲突：</strong>服务器版本与本地未同步写入不一致，编辑已锁定。
        远端已到 v{{ outline.conflictRemote?.version }}（c{{ outline.conflictRemote?.contentVersion }}）。
      </template>
      <p class="conflict-note">
        本地草稿不会自动丢弃。请先<strong>复制或下载 JSON</strong>后再刷新为最新版本；不会自动重放失败的上移/下移等 ops。
      </p>
      <div class="conflict-actions">
        <button v-if="outline.localDraft" type="button" class="btn" @click="copyDraft">复制草稿内容</button>
        <button v-if="outline.localDraft" type="button" class="btn" @click="downloadDraft">下载草稿 JSON</button>
        <button
          v-if="outline.saveStatus === 'conflict'"
          type="button"
          class="btn"
          :disabled="resolving || !conflictRefreshAllowed(conflictDraftPreserved, !!outline.localDraft)"
          @click="onDiscardDraft"
        >
          {{ outline.localDraft ? '刷新为最新版本（保留草稿）' : '刷新为最新版本' }}
        </button>
        <button v-if="outline.localDraft" type="button" class="btn" @click="onDropDraft">丢弃草稿</button>
      </div>
      <p v-if="outline.saveStatus === 'conflict' && outline.localDraft && !conflictDraftPreserved" class="ack-hint">刷新前请先复制或下载草稿。</p>
    </div>
    <div v-else-if="outline.saveStatus === 'offline'" class="banner">
      保存失败：{{ outline.lastError }}。修改已保留，恢复后会自动重试。
      <button class="btn" @click="sync.flush">立即重试</button>
    </div>
    <div v-else-if="outline.uploadsPending" class="banner warn">图片上传中或失败，先完成/重试再提交反馈或确认。</div>

    <main class="outline-main">
      <OutlineNavigator
        v-show="!isNarrow || navOpen"
        class="nav-col"
        :content="editorContent"
        :active-block-id="activeBlockId"
        @navigate="onNavBlock"
      />
      <OutlineEditor
        ref="editorRef"
        class="editor-col"
        :readonly="outline.readonly || resolving"
        :threads="outline.threads"
        :content="editorContent"
        :suspend-refresh="suspendRefresh"
        @steps="onSteps"
        @comment-range="onCommentRange"
        @request-link="linkModalOpen = true"
        @request-move="onMoveBlock"
        @selection-block="onSelectionBlock"
        @composing="sync.setComposing"
        @doc-json="onDocJson"
      />
      <CommentsPanel
        v-show="drawerOpen"
        class="panel"
        :threads="outline.threads"
        :submissions="outline.submissions"
        :readonly="outline.readonly"
        @op="onThreadOp"
        @locate="onLocate"
        @request-add-comment="onRequestDocComment"
      />
    </main>

    <CommentComposerModal
      :visible="commentModalOpen"
      @submit="onCommentModalSubmit"
      @cancel="commentModalOpen = false"
    />
    <LinkModal
      :visible="linkModalOpen"
      @submit="onLinkSubmit"
      @cancel="linkModalOpen = false"
    />
    <Modal :visible="approveConfirmOpen" :width="440" @update:visible="v => !v && (approveConfirmOpen = false)">
      <p>{{ approveConfirmText }}</p>
      <div class="modal-actions">
        <button type="button" class="btn" @click="approveConfirmOpen = false">取消</button>
        <button type="button" class="btn primary" @click="onApproveAckThreads">仍要确认</button>
      </div>
    </Modal>
    <Modal :visible="leaveModalOpen" :width="400" @update:visible="v => !v && (leaveModalOpen = false)">
      <p>有未保存内容或保存失败，仍要离开？</p>
      <div class="modal-actions">
        <button type="button" class="btn" @click="leaveModalOpen = false">留下</button>
        <button type="button" class="btn primary" @click="confirmLeavePpt">离开</button>
      </div>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { nanoid } from 'nanoid'
import Modal from '@/components/Modal.vue'
import { useDocumentStore } from '@/store/document'
import { useOutlineStore } from '@/store/outline'
import useOutlineSync from '@/hooks/useOutlineSync'
import type { OutlineAnchorSpec, OutlineThread } from '@/types/outline'
import { outlineActionBlocked } from '@/utils/outline/submitGate'
import { commentRevisionCurrent, conflictRefreshAllowed, navigationNeedsLeave, reviewedVersionCurrent, sameDraftBody, textsEqual } from '@/utils/outline/editorGuards'
import { moveBlockedByPendingUploads } from '@/utils/outline/imageInsert'
import { revokePendingBlobs, scheduleBlobRevoke, type BlobRevokeTimer } from '@/utils/outline/blobRevoke'
import { topLevelBlockIds } from '@/utils/outline/navigatorTree'
import { submitOutlineFeedback, approveOutline, revokeOutlineApproval, postOutlineOps } from '@/services/outline'
import OutlineEditor from './OutlineEditor.vue'
import CommentsPanel from './CommentsPanel.vue'
import OutlineNavigator from './OutlineNavigator.vue'
import OutlineWorkflowStatus from './OutlineWorkflowStatus.vue'
import CommentComposerModal from './CommentComposerModal.vue'
import LinkModal from './LinkModal.vue'

const documentStore = useDocumentStore()
const outline = useOutlineStore()
const sync = useOutlineSync()
const editorRef = ref<InstanceType<typeof OutlineEditor>>()
const busy = ref(false)
const drawerOpen = ref(true)
const navOpen = ref(false)
const isNarrow = ref(false)
const editorContent = ref<Record<string, unknown> | null>(null)
const suspendRefresh = ref(false)
const resolving = ref(false)
const activeBlockId = ref<string | null>(null)
const conflictDraftPreserved = ref(false)
const draftBlobRevokes: BlobRevokeTimer[] = []

const commentModalOpen = ref(false)
const pendingCommentAnchor = ref<OutlineAnchorSpec | null>(null)
const pendingCommentTexts = ref<string[] | null>(null)
const pendingCommentRev = ref<number | null>(null)
const commentSubmitting = ref(false)
const moving = ref(false)
const approveReviewedVersion = ref<number | null>(null)
const linkModalOpen = ref(false)
const approveConfirmOpen = ref(false)
const approveConfirmText = ref('')
const leaveModalOpen = ref(false)

const pptUrl = computed(() => `/?doc=${documentStore.docId}#t=${documentStore.token}`)
const draftSteps = computed(() => outline.localDraft?.steps.length ?? 0)
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

watch(() => outline.saveStatus, s => {
  if (s === 'conflict') conflictDraftPreserved.value = false
})
watch(() => outline.conflictRemote?.version, () => {
  if (outline.saveStatus === 'conflict') conflictDraftPreserved.value = false
})
watch(() => outline.localDraft?.steps?.length, () => {
  if (outline.saveStatus === 'conflict') conflictDraftPreserved.value = false
})

const onDocJson = (doc: Record<string, unknown>) => {
  sync.trackEditorDoc(doc)
  // trackEditorDoc 会把 buffered 置上。本地导航和移动邻居必须用这份正文，
  // 远端替换仍由 outline.content 的未保存守卫拦住。
  editorContent.value = doc
}

const onSelectionBlock = (id: string | null) => {
  activeBlockId.value = id
}

const onNavBlock = (blockId: string) => {
  editorRef.value?.scrollToBlockId(blockId)
  navOpen.value = false
}

const onSteps = (steps: Record<string, unknown>[]) => {
  sync.enqueueSteps(steps)
}

const postOps = async (op: Record<string, unknown>) => {
  if (outline.readonly) return
  editorRef.value?.flushNow()
  await Promise.resolve()
  if (!(await sync.drain())) {
    outline.lastError = '请先解决未保存/冲突内容'
    return
  }
  busy.value = true
  try {
    const res = await postOutlineOps(documentStore.docId, outline.version, nanoid(16), [op])
    outline.setVersions(res.version, res.contentVersion)
    await sync.refresh()
  }
  catch (err) {
    const e = err as { message?: string }
    outline.lastError = e.message ?? '操作失败'
  }
  finally {
    busy.value = false
  }
}

const onThreadOp = (op: Record<string, unknown>) => void postOps(op)

const onMoveBlock = async ({ blockId, direction }: { blockId: string, direction: 'up' | 'down' }) => {
  const blocked = moveBlockedByPendingUploads(outline.uploadsPending)
  if (blocked) {
    outline.lastError = blocked
    return
  }
  if (moving.value || outline.readonly || outline.saveStatus === 'conflict') return
  const ids = topLevelBlockIds(editorContent.value)
  const i = ids.indexOf(blockId)
  if (i < 0) return
  const op: Record<string, unknown> = { op: 'moveBlock', blockId }
  if (direction === 'up') {
    if (i === 0) return
    op.before = ids[i - 1]
  }
  else {
    if (i >= ids.length - 1) return
    op.after = ids[i + 1]
  }
  moving.value = true
  editorRef.value?.setMoveLock(true)
  try {
    await postOps(op)
  }
  finally {
    editorRef.value?.setMoveLock(false)
    moving.value = false
  }
}

const onLocate = (t: OutlineThread) => {
  const target = document.querySelector(`.ProseMirror [data-thread-id="${t.id}"]`)
    ?? document.querySelector(`.comments-panel [data-thread-id="${t.id}"]`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const onCommentRange = (anchor: OutlineAnchorSpec) => {
  pendingCommentAnchor.value = anchor
  pendingCommentTexts.value = anchor.kind === 'textRange' ? editorRef.value?.anchorFragmentTexts(anchor) ?? null : null
  pendingCommentRev.value = anchor.kind === 'textRange' ? editorRef.value?.contentRevision() ?? null : null
  commentModalOpen.value = true
}

const onRequestDocComment = () => {
  pendingCommentAnchor.value = { kind: 'document' }
  commentModalOpen.value = true
}

const onCommentModalSubmit = async (text: string) => {
  if (commentSubmitting.value) return
  commentSubmitting.value = true
  const anchor = pendingCommentAnchor.value
  const expected = pendingCommentTexts.value
  try {
    if (!anchor) {
      commentModalOpen.value = false
      return
    }
    editorRef.value?.flushNow()
    await Promise.resolve()
    if (!(await sync.drain())) {
      outline.lastError = '请先解决未保存/冲突内容'
      return
    }
    const revisionOk = commentRevisionCurrent(pendingCommentRev.value, editorRef.value?.contentRevision() ?? null)
    if (anchor.kind === 'textRange' && (!revisionOk || !textsEqual(expected, editorRef.value?.anchorFragmentTexts(anchor) ?? null))) {
      outline.lastError = '正文已变化，请重新选择文字后再批注'
      commentModalOpen.value = false
      pendingCommentAnchor.value = null
      pendingCommentTexts.value = null
      pendingCommentRev.value = null
      return
    }
    commentModalOpen.value = false
    pendingCommentAnchor.value = null
    pendingCommentTexts.value = null
    pendingCommentRev.value = null
    await postOps({ op: 'addComment', anchor, content: text })
  }
  finally {
    commentSubmitting.value = false
  }
}

const onLinkSubmit = (href: string) => {
  linkModalOpen.value = false
  editorRef.value?.applyLinkHref(href)
}

const guard = async () => {
  editorRef.value?.flushNow()
  await Promise.resolve()
  if (outline.uploadsPending) {
    outline.lastError = '有图片上传未完成'
    return false
  }
  return sync.drain()
}

const onSubmitFeedback = async () => {
  if (!(await guard())) {
    outline.lastError = '内容未保存完成，暂不能提交'
    return
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
    outline.lastError = '内容未保存完成，暂不能确认'
    return
  }
  const reviewed = outline.version
  approveReviewedVersion.value = reviewed
  busy.value = true
  try {
    await approveOutline(documentStore.docId, { baseVersion: reviewed, requestId: nanoid(16), acknowledgeOpenThreads: false })
    approveReviewedVersion.value = null
    await sync.refresh()
  }
  catch (err) {
    const e = err as { status?: number, issues?: { openThreads?: number }, message?: string }
    if (e.status === 409 && (e.issues as { openThreads?: number })?.openThreads) {
      if (!reviewedVersionCurrent(reviewed, outline.version)) {
        approveConfirmOpen.value = false
        outline.lastError = '大纲版本已变化，请重新审阅后再确认'
        return
      }
      const n = (e.issues as { openThreads: number }).openThreads
      approveConfirmText.value = `还有 ${n} 条未解决批注，仍确认当前版本进入制作？`
      approveConfirmOpen.value = true
    }
    else outline.lastError = e.message ?? '确认失败'
  }
  finally {
    busy.value = false
  }
}

const onApproveAckThreads = async () => {
  const reviewed = approveReviewedVersion.value
  editorRef.value?.flushNow()
  await Promise.resolve()
  if (outline.uploadsPending) {
    outline.lastError = '有图片上传未完成'
    return
  }
  if (sync.hasUnsavedChanges() || reviewed == null || !reviewedVersionCurrent(reviewed, outline.version)) {
    approveConfirmOpen.value = false
    outline.lastError = '大纲版本已变化，请重新审阅后再确认'
    return
  }
  if (!(await sync.drain())) {
    outline.lastError = '内容未保存完成，暂不能确认'
    return
  }
  if (!reviewedVersionCurrent(reviewed, outline.version)) {
    approveConfirmOpen.value = false
    outline.lastError = '大纲版本已变化，请重新审阅后再确认'
    return
  }
  approveConfirmOpen.value = false
  busy.value = true
  try {
    await approveOutline(documentStore.docId, { baseVersion: reviewed, requestId: nanoid(16), acknowledgeOpenThreads: true })
    approveReviewedVersion.value = null
    await sync.refresh()
  }
  catch (err) {
    outline.lastError = (err as { message?: string }).message ?? '确认失败'
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

const onDiscardDraft = async () => {
  if (resolving.value || !conflictRefreshAllowed(conflictDraftPreserved.value, !!outline.localDraft)) return
  resolving.value = true
  try {
    editorRef.value?.flushNow()
    await Promise.resolve()
    await sync.resolveConflict()
  }
  finally {
    resolving.value = false
  }
}

const onDropDraft = () => {
  outline.dropDraft()
  sync.dropDraft()
}

const buildDraftPayload = () => {
  const d = outline.localDraft
  if (!d) return null
  return { content: d.content, steps: d.steps, savedAt: Date.now() }
}

const copyDraft = async () => {
  const payload = buildDraftPayload()
  if (!payload) return
  const text = JSON.stringify(payload, null, 2)
  if (!text.includes('"content"') || text.length < 10) return
  const copied = JSON.parse(JSON.stringify({ content: payload.content, steps: payload.steps })) as { content: unknown, steps: unknown }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    const now = buildDraftPayload()
    if (!sameDraftBody(copied, now ? { content: now.content, steps: now.steps } : null)) {
      conflictDraftPreserved.value = false
      outline.lastError = '草稿已变化，请重新复制后再刷新'
      return
    }
    conflictDraftPreserved.value = true
    outline.lastError = '草稿已复制到剪贴板（JSON）'
  }
  catch {
    outline.lastError = '复制失败，请使用下载草稿 JSON'
    conflictDraftPreserved.value = false
  }
}

const downloadDraft = async () => {
  const payload = buildDraftPayload()
  if (!payload) return
  const text = JSON.stringify(payload, null, 2)
  if (!text.includes('"content"') || text.length < 10) return
  const snapshot = JSON.parse(JSON.stringify({ content: payload.content, steps: payload.steps })) as { content: unknown, steps: unknown }
  let url: string | undefined
  let anchor: HTMLAnchorElement | undefined
  try {
    const blob = new Blob([text], { type: 'application/json' })
    if (blob.size < 10) return
    const written = await blob.text()
    const parsed = JSON.parse(written) as { content: unknown, steps: unknown }
    if (!written.includes('"content"') || !sameDraftBody(snapshot, { content: parsed.content, steps: parsed.steps })) {
      throw new Error('download payload mismatch')
    }
    url = URL.createObjectURL(blob)
    const probed = await (await fetch(url)).text()
    const probedBody = JSON.parse(probed) as { content: unknown, steps: unknown }
    if (probed !== written || !sameDraftBody(snapshot, { content: probedBody.content, steps: probedBody.steps })) {
      throw new Error('download bytes mismatch')
    }
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `outline-draft-${documentStore.docId}.json`
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    anchor.addEventListener('click', (event) => event.stopPropagation())
    document.body.appendChild(anchor)
    anchor.click()
    const now = buildDraftPayload()
    if (!sameDraftBody(snapshot, now ? { content: now.content, steps: now.steps } : null)) {
      conflictDraftPreserved.value = false
      outline.lastError = '草稿已变化，请重新下载后再刷新'
      return
    }
    conflictDraftPreserved.value = true
    outline.lastError = '草稿已下载'
  }
  catch {
    outline.lastError = '下载失败'
    conflictDraftPreserved.value = false
  }
  finally {
    anchor?.remove()
    // click() 同期 revoke 时，部分浏览器可能还没把文件读完。延后收回；卸载时再清未触发的定时器。
    if (url) scheduleBlobRevoke(url, draftBlobRevokes, blobUrl => URL.revokeObjectURL(blobUrl))
  }
}

const onNavPpt = async (e: Event) => {
  e.preventDefault()
  editorRef.value?.flushNow()
  await Promise.resolve()
  const drained = await sync.drain()
  if (navigationNeedsLeave(drained, sync.hasUnsavedChanges(), outline.saveStatus)) {
    leaveModalOpen.value = true
    return
  }
  window.location.href = pptUrl.value
}

const confirmLeavePpt = () => {
  leaveModalOpen.value = false
  window.location.href = pptUrl.value
}

const onBeforeUnload = (e: BeforeUnloadEvent) => {
  editorRef.value?.flushNow()
  void sync.flush()
  if (sync.hasUnsavedChanges()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

const mq = () => { isNarrow.value = window.matchMedia('(max-width: 860px)').matches }

watch(() => outline.saveStatus, s => {
  suspendRefresh.value = s === 'dirty' || s === 'saving' || s === 'conflict'
}, { immediate: true })
watch(() => outline.content, c => {
  if (c && !sync.hasUnsavedChanges()) editorContent.value = c
}, { deep: false })

onMounted(async () => {
  mq()
  window.addEventListener('resize', mq)
  try {
    await sync.init()
    editorContent.value = outline.content
    window.addEventListener('beforeunload', onBeforeUnload)
  }
  catch {
    outline.lastError = '大纲加载失败'
  }
})

const DRAIN_TIMEOUT_MS = 3000
onBeforeUnmount(() => {
  revokePendingBlobs(draftBlobRevokes, blobUrl => URL.revokeObjectURL(blobUrl))
  window.removeEventListener('resize', mq)
  window.removeEventListener('beforeunload', onBeforeUnload)
  void (async () => {
    editorRef.value?.flushNow()
    await Promise.resolve()
    await Promise.race([sync.drain(), new Promise(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS))])
    if (sync.pendingCount()) sync.preservePending()
    sync.destroy()
  })()
})
</script>

<style lang="scss" scoped>
.outline-page { height: 100%; display: flex; flex-direction: column; }
.outline-header {
  display: flex; align-items: flex-start; gap: 12px; padding: 8px 16px;
  border-bottom: 1px solid #e5e5e5; flex-wrap: wrap;
  .title { font-size: 16px; font-weight: 600; }
  .workflow { flex: 0 0 auto; }
  .meta { flex: 1 1 200px; display: flex; gap: 10px; font-size: 12px; color: #666; flex-wrap: wrap; align-items: center; }
  .save.dirty, .save.offline, .save.conflict, .err { color: #d97706; }
}
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px;
  background: #fff; cursor: pointer; text-decoration: none; color: #333;
  &.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  &:disabled { opacity: 0.5; cursor: default; }
}
.banner { padding: 8px 16px; background: #fef3c7; font-size: 13px; &.conflict { background: #fee2e2; } &.warn { background: #fef9c3; } }
.conflict-note { margin: 6px 0; font-size: 12px; line-height: 1.5; }
.conflict-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ack-hint { font-size: 12px; color: #b45309; margin: 6px 0 0; }
.outline-main { flex: 1; display: flex; min-height: 0; }
.editor-col { flex: 1; min-width: 0; }
.panel { width: 300px; border-left: 1px solid #e5e5e5; flex-shrink: 0; }
.modal-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
@media (max-width: 860px) {
  .panel { position: fixed; right: 0; top: 0; bottom: 0; z-index: 20; background: #fff; box-shadow: -2px 0 8px rgba(0,0,0,.12); }
}
</style>
