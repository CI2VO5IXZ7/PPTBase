// 大纲同步（Vue 包装）：初始化拉取、批量自动保存、SSE outline 事件延迟补拉、
// 断线重连独立 GET 补拉、提交/确认/导航前 drain。状态机在
// src/utils/outline/syncCore.ts（纯实现，离线可测）；这里只做 store/服务桥接。
import { nanoid } from 'nanoid'
import { useOutlineStore } from '@/store/outline'
import { useDocumentStore } from '@/store/document'
import { setDocToken, subscribe } from '@/services/document'
import { getOutline, listOutlineFeedback, patchOutlineSteps } from '@/services/outline'
import { OutlineSyncCore, type OutlineStateSnapshot } from '@/utils/outline/syncCore'

const FLUSH_DELAY = 1200
const OFFLINE_RETRY_DELAY = 5000

export default function useOutlineSync() {
  const outline = useOutlineStore()
  const documentStore = useDocumentStore()

  let initialized = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let composing = false

  const core = new OutlineSyncCore(
    {
      getState: async () => {
        const s = await getOutline(documentStore.docId)
        return {
          version: s.version, contentVersion: s.contentVersion,
          content: s.content, threads: s.threads, status: s.status,
        }
      },
      patchSteps: (baseVersion, requestId, steps) =>
        patchOutlineSteps(documentStore.docId, baseVersion, requestId, steps),
    },
    {
      onStatus: (s, error) => {
        outline.setSaveStatus(s)
        outline.lastError = error ?? ''
      },
      onConflict: ({ remoteVersion, remoteContentVersion }) => {
        outline.setConflict(remoteVersion, remoteContentVersion)
        if (core.localDraft?.content) {
          outline.stashDraft(core.localDraft.content, core.localDraft.steps)
        }
      },
      onVersion: (v, cv) => outline.setVersions(v, cv),
      onRemoteState: (state) => applyRemoteState(state),
    },
    () => nanoid(16),
  )

  // 远端状态应用到 store：仅在无未提交内容时替换正文（避免覆盖正在输入的文本）
  function applyRemoteState(state: OutlineStateSnapshot) {
    if (core.pendingCount || composing) {
      core.remotePullPending = true
      outline.setVersions(state.version, outline.contentVersion)
      return
    }
    outline.load({
      docId: documentStore.docId,
      role: outline.role || 'view',
      version: state.version,
      contentVersion: state.contentVersion,
      content: state.content,
      threads: state.threads as never[],
      status: state.status as never,
      updatedAt: Date.now(),
    })
    void loadSubmissions()
  }

  async function loadSubmissions() {
    if (outline.readonly) return
    const res = await listOutlineFeedback(documentStore.docId, '?limit=20').catch(() => null)
    if (res) outline.setSubmissions(res.submissions)
  }

  function refresh() {
    return core.pull(true)
  }

  function scheduleFlush(delay = FLUSH_DELAY) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flush(), delay)
  }

  async function flush(): Promise<boolean> {
    const ok = await core.flush()
    if (!ok && core.status === 'offline') scheduleFlush(OFFLINE_RETRY_DELAY)
    if (ok && core.remotePullPending && !core.pendingCount && !composing) {
      core.remotePullPending = false
      void core.pull(true)
    }
    return ok
  }

  function enqueueSteps(steps: Record<string, unknown>[]) {
    if (outline.readonly) return
    const res = core.enqueue(steps)
    if (res.warning) outline.lastError = res.warning
    scheduleFlush()
  }

  const drain = () => core.drain()
  const setComposing = (v: boolean) => {
    composing = v
    if (!v && core.remotePullPending) {
      core.remotePullPending = false
      void core.pull(true)
    }
  }
  const trackEditorDoc = (doc: Record<string, unknown>) => core.trackDoc(doc)

  async function resolveConflict() {
    await core.resolveConflict()
    outline.conflictRemote = null
  }

  const init = async () => {
    if (initialized) return
    initialized = true
    setDocToken(documentStore.token)
    await core.pull(true)
    await loadSubmissions()
    unsubscribe = subscribe(
      documentStore.docId,
      () => undefined,
      // outline 事件：有未提交内容时延迟到安全时机
      () => {
        if (!core.pendingCount && !composing) void core.pull(true)
      },
      // 断线重连：独立 GET 补拉，不依赖事件回放
      () => {
        void core.pull(true)
      },
    )
  }

  const destroy = () => {
    unsubscribe?.()
    unsubscribe = null
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    initialized = false
    core.queue.clear()
  }

  const hasUnsavedChanges = () => core.hasUnsaved
  const pendingCount = () => core.pendingCount

  return {
    init, destroy, flush, drain, scheduleFlush, refresh, resolveConflict,
    enqueueSteps, hasUnsavedChanges, pendingCount, setComposing, trackEditorDoc,
  }
}
