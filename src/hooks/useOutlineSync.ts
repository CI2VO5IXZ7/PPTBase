// 大纲同步：初始化拉取、StepsQueue 批量自动保存、单飞写入、
// 不确定结果按同一 requestId 幂等重试、409 保留本地草稿、
// SSE outline 事件延迟补拉（输入中/IME 不打断）、切换前 drain。
// 与 PPT version 完全隔离；所有失败状态如实呈现，绝不伪装已保存。
import { nanoid } from 'nanoid'
import { useOutlineStore } from '@/store/outline'
import { useDocumentStore } from '@/store/document'
import { setDocToken, subscribe } from '@/services/document'
import { getOutline, listOutlineFeedback, patchOutlineSteps } from '@/services/outline'
import { StepsQueue, MAX_BATCH } from '@/utils/outline/pendingSteps'

const FLUSH_DELAY = 1200
const MAX_QUEUE_BATCHES = 40 // 队列上限 40*200 步，防止无限增长

export default function useOutlineSync() {
  const outline = useOutlineStore()
  const documentStore = useDocumentStore()

  const queue = new StepsQueue()
  let initialized = false
  let applyingRemote = false
  let flushing = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  // 输入中/IME 期间到达的远端事件 → 延迟到安全时机补拉
  let remotePullQueued = false
  // 编辑器组合输入中（IME/emoji 组合），禁止重建文档
  let composing = false
  let editorDoc: Record<string, unknown> | null = null

  function setComposing(v: boolean) {
    composing = v
    if (!v && remotePullQueued) void safeRemotePull()
  }

  function trackEditorDoc(c: Record<string, unknown>) {
    editorDoc = c
  }

  async function loadSubmissions() {
    if (outline.readonly) return
    const res = await listOutlineFeedback(documentStore.docId, '?limit=20').catch(() => null)
    if (res) outline.setSubmissions(res.submissions)
  }

  async function refresh() {
    const state = await getOutline(documentStore.docId)
    applyingRemote = true
    outline.load(state)
    applyingRemote = false
    await loadSubmissions()
    return state
  }

  // 远端事件/重连后的补拉：有未提交内容或 IME 中只标记，待安全时机执行
  async function safeRemotePull() {
    remotePullQueued = false
    if (queue.size || composing) {
      remotePullQueued = true
      return
    }
    await refresh().catch(() => undefined)
  }

  // 单飞自动保存：把队列里的一批 steps 以 baseVersion+requestId 提交。
  // 网络结果不确定时按同一 requestId 重试一次（服务端幂等，重复提交返回原结果）。
  async function flush(): Promise<boolean> {
    if (flushing || !initialized || applyingRemote || outline.readonly) return false
    const batch = queue.takeBatch(nanoid(16))
    if (!batch) return true
    flushing = true
    outline.setSaveStatus('saving')
    const baseVersion = outline.version
    let ok = false
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        // 重试沿用同一 requestId：若上次其实已提交，服务端按幂等键返回原结果
        const res = await patchOutlineSteps(
          documentStore.docId, baseVersion,
          attempt === 0 ? queue.inflightRequestId : queue.inflightRequestId,
          batch,
        )
        queue.commit()
        outline.setVersions(res.version, res.contentVersion)
        ok = true
      }
      catch (err) {
        const e = err as { status?: number, currentVersion?: number, contentVersion?: number, message?: string }
        if (e.status === 409) {
          // 正文冲突：requeue 保序放回，保存本地草稿供用户取回；不做盲目重放
          queue.requeue()
          if (editorDoc) outline.stashDraft(editorDoc, queue.snapshotAll())
          outline.setConflict(e.currentVersion ?? 0, e.contentVersion ?? 0)
          outline.lastError = e.message ?? '版本冲突'
          flushing = false
          return false
        }
        if (e.status && e.status < 500 && e.status !== 0) {
          // 4xx 明确失败：steps 保留在队列，如实报失败，不伪装已保存
          queue.requeue()
          outline.setSaveStatus('offline')
          outline.lastError = e.message ?? `保存失败（${e.status}）`
          flushing = false
          return false
        }
        // 网络/5xx：结果不确定 → requeue 后下一轮用同一 requestId 重试（幂等键）
        const rid = queue.requeue()
        queue.takeBatch(rid)
      }
    }
    if (ok) {
      outline.setSaveStatus(queue.size ? 'dirty' : 'saved')
      outline.lastError = ''
      // 还有剩余批次（>MAX_BATCH 的长输入）继续排空
      if (queue.size) scheduleFlush(0)
      else if (remotePullQueued) void safeRemotePull()
    }
    else {
      outline.setSaveStatus('offline')
      outline.lastError = outline.lastError || '网络错误，已保留修改，恢复后自动重试'
      scheduleFlush(5000) // 退避重试
    }
    flushing = false
    return ok
  }

  function scheduleFlush(delay = FLUSH_DELAY) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flush(), delay)
  }

  function enqueueSteps(steps: Record<string, unknown>[]) {
    if (outline.readonly || applyingRemote) return
    if (queue.size > MAX_QUEUE_BATCHES * MAX_BATCH) {
      outline.lastError = '未保存修改过多，请等待保存或刷新页面'
      return
    }
    queue.enqueue(steps)
    outline.setSaveStatus('dirty')
    scheduleFlush()
  }

  // 提交反馈/确认/切页前：排空编辑器 debounce + 同步队列
  async function drain(): Promise<boolean> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    for (let i = 0; i < 60; i++) {
      if (!queue.size) return true
      if (outline.saveStatus === 'conflict') return false
      const ok = await flush()
      if (!ok) {
        if ((outline.saveStatus as string) === 'conflict') return false
        // 离线：短暂等待重试一轮再放弃
        await new Promise(r => setTimeout(r, 800))
        if (!(await flush())) return false
      }
    }
    return !queue.size
  }

  // 冲突处理：取回最新服务端版本；本地草稿保留在 store.localDraft 供复制/人工迁移
  async function resolveConflict() {
    await refresh()
    queue.clear()
    outline.setSaveStatus('saved')
    outline.conflictRemote = null
  }

  const init = async () => {
    if (initialized) return
    initialized = true
    setDocToken(documentStore.token)
    await refresh()
    unsubscribe = subscribe(documentStore.docId, () => undefined, async () => {
      // outline 事件：断线重连/远端写入后补拉；本地有未保存内容时延迟
      await safeRemotePull()
    })
  }

  const destroy = () => {
    unsubscribe?.()
    unsubscribe = null
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    initialized = false
    flushing = false
    queue.clear()
  }

  const hasUnsavedChanges = () => queue.size > 0 || outline.saveStatus === 'saving' || outline.saveStatus === 'dirty'
  const pendingCount = () => queue.size

  return {
    init, destroy, flush, drain, scheduleFlush, refresh, resolveConflict,
    enqueueSteps, hasUnsavedChanges, pendingCount, setComposing, trackEditorDoc,
  }
}
