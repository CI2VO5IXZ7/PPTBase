// 大纲同步：初始化拉取、批量 steps 自动保存、409 保留本地草稿、
// SSE outline 事件补拉、切页/关闭前 flush。与 PPT 版本体系完全隔离。
import { nanoid } from 'nanoid'
import { useOutlineStore } from '@/store/outline'
import { useDocumentStore } from '@/store/document'
import { setDocToken, subscribe } from '@/services/document'
import { getOutline, patchOutlineSteps } from '@/services/outline'

const FLUSH_DELAY = 1200

export default function useOutlineSync() {
  const outline = useOutlineStore()
  const documentStore = useDocumentStore()

  let initialized = false
  let applyingRemote = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null

  async function refresh() {
    const state = await getOutline(documentStore.docId)
    applyingRemote = true
    outline.load(state)
    applyingRemote = false
  }

  // 自动保存一批 steps（编辑器 dispatchTransaction 收集后调用）
  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!initialized || applyingRemote || outline.readonly || !outline.pendingSteps.length) return
    const baseVersion = outline.version
    const steps = outline.pendingSteps.slice(0, 200)
    outline.setSaveStatus('saving')
    try {
      const res = await patchOutlineSteps(documentStore.docId, baseVersion, nanoid(16), steps)
      outline.clearPending(steps.length)
      outline.setVersions(res.version, res.contentVersion)
      outline.setSaveStatus(outline.pendingSteps.length ? 'dirty' : 'saved')
      if (!res.unchanged) {
        // 版本已前进；线程/锚点可能有更新，轻量补拉元数据（不打断输入）
        await refresh().catch(() => undefined)
      }
    }
    catch (err) {
      const e = err as { status?: number, currentVersion?: number, message?: string }
      if (e.status === 409) {
        // 正文冲突：保留本地 pendingSteps 供用户取回/在新版本重放，不做盲放
        outline.setConflict(e.currentVersion ?? 0)
        outline.lastError = e.message ?? '版本冲突'
      }
      else {
        outline.setSaveStatus('offline')
        outline.lastError = e.message ?? '网络错误'
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flush(), FLUSH_DELAY)
  }

  // 409 后：拉取最新版替换本地文档；pendingSteps 留在队列里由用户决定丢弃或复制取回
  async function resolveConflict() {
    await refresh()
    outline.pendingSteps = []
    outline.setSaveStatus('saved')
    outline.conflictRemote = null
  }

  const init = async () => {
    if (initialized) return
    initialized = true
    setDocToken(documentStore.token)
    await refresh()
    unsubscribe = subscribe(documentStore.docId, () => undefined, async () => {
      // outline 事件：元数据/远端写入时补拉；有未保存内容时延迟到保存后
      if (outline.pendingSteps.length) return
      await refresh().catch(() => undefined)
    })
  }

  const destroy = () => {
    unsubscribe?.()
    unsubscribe = null
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    initialized = false
  }

  const hasUnsavedChanges = () => outline.pendingSteps.length > 0 || outline.saveStatus === 'saving' || outline.saveStatus === 'dirty'

  return { init, destroy, flush, scheduleFlush, refresh, resolveConflict, hasUnsavedChanges }
}
