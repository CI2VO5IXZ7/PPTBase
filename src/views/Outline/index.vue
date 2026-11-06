<template>
  <div class="outline-page">
    <header class="outline-header">
      <div class="title">大纲协作</div>
      <div class="meta">
        <span>v{{ outline.version }} / c{{ outline.contentVersion }}</span>
        <span :class="['save', outline.saveStatus]">{{ saveText }}</span>
        <span v-if="outline.status?.pendingSubmissions" class="pending">
          第 {{ outline.status.pendingSubmissions }} 轮反馈待处理（需在聊天中让 Agent 继续）
        </span>
        <span v-if="outline.status?.approval?.valid" class="approved">已确认版本 {{ outline.status.approval.contentVersion }}</span>
        <span v-else-if="outline.status?.approval" class="stale">确认已偏离，请重新确认</span>
      </div>
      <div class="actions" v-if="!outline.readonly">
        <a class="btn" :href="pptUrl">查看 PPT</a>
        <button class="btn" :disabled="busy" @click="onSubmitFeedback">提交反馈</button>
        <button v-if="!outline.status?.approval?.valid" class="btn primary" :disabled="busy" @click="onApprove">确认大纲，进入制作</button>
        <button v-else class="btn" :disabled="busy" @click="onRevoke">撤销确认</button>
      </div>
    </header>
    <div v-if="outline.saveStatus === 'conflict'" class="banner">
      版本冲突（远端 v{{ outline.conflictRemote?.version }}）。本地未提交修改已保留，可刷新为最新版本后重新编辑。
      <button class="btn" @click="sync.resolveConflict">刷新为最新版本</button>
    </div>
    <div v-else-if="outline.saveStatus === 'offline'" class="banner">保存失败：{{ outline.lastError }}，恢复后会自动重试。</div>
    <main class="outline-main">
      <OutlineEditor
        :readonly="outline.readonly"
        :threads="outline.threads"
        @steps="onSteps"
        @comment-range="onCommentRange"
      />
      <CommentsPanel
        class="panel"
        :threads="outline.threads"
        :readonly="outline.readonly"
        @op="onThreadOp"
      />
    </main>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { nanoid } from 'nanoid'
import type { OutlineAnchorSpec } from '@/types/outline'
import { useDocumentStore } from '@/store/document'
import { useOutlineStore } from '@/store/outline'
import useOutlineSync from '@/hooks/useOutlineSync'
import { submitOutlineFeedback, approveOutline, revokeOutlineApproval, postOutlineOps } from '@/services/outline'
import OutlineEditor from './OutlineEditor.vue'
import CommentsPanel from './CommentsPanel.vue'

const documentStore = useDocumentStore()
const outline = useOutlineStore()
const sync = useOutlineSync()
const busy = ref(false)

const pptUrl = computed(() => `/?doc=${documentStore.docId}#t=${documentStore.token}`)

const saveText = computed(() => ({
  saved: '已保存', saving: '保存中…', dirty: '未保存', offline: '保存失败', conflict: '版本冲突',
} as Record<string, string>)[outline.saveStatus])

const onSteps = (steps: Record<string, unknown>[]) => {
  outline.queueSteps(steps)
  sync.scheduleFlush()
}

const onThreadOp = async (op: Record<string, unknown>) => {
  if (outline.readonly) return
  busy.value = true
  try {
    const res = await postOutlineOps(documentStore.docId, outline.version, nanoid(16), [op])
    outline.setVersions(res.version, res.contentVersion)
    await sync.refresh()
  }
  finally {
    busy.value = false
  }
}

const onCommentRange = (anchor: OutlineAnchorSpec) => {
  const content = window.prompt('批注内容')
  if (!content) return
  void onThreadOp({ op: 'addComment', anchor, content })
}

const onSubmitFeedback = async () => {
  busy.value = true
  try {
    await sync.flush()
    if (outline.pendingSteps.length) return
    const res = await submitOutlineFeedback(documentStore.docId, { requestId: nanoid(16) })
    void res
    await sync.refresh()
  }
  finally {
    busy.value = false
  }
}

const onApprove = async () => {
  busy.value = true
  try {
    await sync.flush()
    if (outline.pendingSteps.length) return
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
    else {
      outline.lastError = e.message ?? '确认失败'
    }
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

onMounted(async () => {
  try {
    await sync.init()
  }
  catch {
    outline.lastError = '大纲加载失败'
  }
})
onBeforeUnmount(() => {
  void sync.flush()
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
  .save.dirty, .save.offline, .save.conflict { color: #d97706; }
  .approved { color: #059669; }
  .stale, .pending { color: #d97706; }
}
.actions { display: flex; gap: 8px; }
.btn {
  font-size: 13px; padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px;
  background: #fff; cursor: pointer; text-decoration: none; color: #333;
  &.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  &:disabled { opacity: 0.5; cursor: default; }
}
.banner { padding: 8px 16px; background: #fef3c7; font-size: 13px; }
.outline-main { flex: 1; display: flex; min-height: 0; }
.panel { width: 300px; border-left: 1px solid #e5e5e5; }
@media (max-width: 768px) {
  .panel { position: fixed; right: 0; top: 0; bottom: 0; z-index: 10; background: #fff; box-shadow: -2px 0 8px rgba(0,0,0,.1); }
}
</style>
