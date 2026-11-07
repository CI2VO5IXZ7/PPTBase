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
  // 在途初始化 Promise：并发 init 共享同一次结果，避免重复拉取/订阅
  let initPromise: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let composing = false

  const core = new OutlineSyncCore(
    {
      getState: async () => {
        const s = await getOutline(documentStore.docId)
        return {
          version: s.version, contentVersion: s.contentVersion,
          role: s.role, content: s.content, threads: s.threads, status: s.status,
        }
      },
      patchSteps: (baseVersion, requestId, steps) =>
        patchOutlineSteps(documentStore.docId, baseVersion, requestId, steps),
    },
    {
      onStatus: (s, error) => {
        if (s === 'saved') core.setBuffered(false)
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
    if (core.pendingCount || core.buffered || composing) {
      core.remotePullPending = true
      outline.setVersions(state.version, outline.contentVersion)
      return
    }
    core.setBuffered(false)
    outline.load({
      docId: documentStore.docId,
      // 服务端返回的权威角色；不默认降级 view（否则编辑令牌被锁死）
      role: (state.role as 'owner' | 'edit' | 'view') || outline.role || 'view',
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
    // 元数据 409 重放/超批续传：仍有未发 steps 时立即续传，不等下一次输入
    if (core.hasPending && core.status !== 'conflict') scheduleFlush(0)
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
  const trackEditorDoc = (doc: Record<string, unknown>) => {
    core.trackDoc(doc)
    core.setBuffered(true) // 编辑器 300ms 聚合未落队，同样按未提交内容保护
  }

  async function resolveConflict() {
    core.setBuffered(false)
    await core.resolveConflict()
    outline.conflictRemote = null
  }

  // 只有全部成功才置 initialized；失败清理已挂订阅/定时器，保持可重试
  const init = () => {
    if (initialized) return Promise.resolve()
    initPromise ??= doInit().finally(() => { initPromise = null })
    return initPromise
  }

  const doInit = async () => {
    setDocToken(documentStore.token)
    try {
      await core.pull(true)
      await loadSubmissions()
      unsubscribe = subscribe(
        documentStore.docId,
        () => undefined,
        // outline 事件（含自身 PATCH 的服务端映射回执）：未提交/合成中置延迟标记，安全后补拉
        () => {
          if (core.requestPull(composing)) void core.pull(true)
        },
        // 断线重连：独立 GET 补拉，不依赖事件回放
        () => {
          void core.pull(true)
        },
      )
    }
    catch (err) {
      // 初始化失败：清掉已挂上的订阅与定时器，复位后下次 init 可干净重试
      unsubscribe?.()
      unsubscribe = null
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      throw err
    }
    initialized = true
  }

  // destroy 前兜底：drain 未排空的未提交 steps 连同本地正文存为 store 草稿，清队列也不丢数据
  const preservePending = () => {
    const d = core.snapshotPendingDraft()
    if (d) outline.stashDraft(d.content ?? outline.content ?? {}, d.steps)
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
    enqueueSteps, hasUnsavedChanges, pendingCount, preservePending, setComposing, trackEditorDoc,
  }
}
