// 大纲自动保存状态机：框架无关纯实现，transport 可注入 → 离线回归测试全生命周期。
// 规则（§4.6）：
//  - steps 永不静默丢弃；每批 ≤MAX_BATCH，in-flight 批次带稳定 requestId；
//  - 网络/5xx 结果不确定 → 保留 flight，下一次 flush 用同一 requestId+payload+baseVersion 重试；
//    飞行期间新输入只进待发送队列，绝不混入已飞行的 payload；
//  - 4xx 明确失败 → 批次回队首 + 状态 offline；
//  - 409 → 区分「仅元数据版本变化（contentVersion 未变，可安全重放）」与「正文已变（冲突）」；
//  - 仅元数据变化：更新 baseVersion 后立即自动重试一次；正文变化：保留全部本地 steps+草稿，进入 conflict；
//  - 断线重连必须独立 GET 当前状态补拉，不依赖 SSE 事件回放；
//  - drain 把编辑器 debounce 与队列全部排空后才允许提交/确认/导航。

import { StepsQueue } from './pendingSteps.ts'

export type StepJson = Record<string, unknown>

export interface OutlineStateSnapshot {
  version: number
  role?: string
  contentVersion: number
  content: Record<string, unknown>
  threads: unknown[]
  status: unknown
}

export interface WriteResult {
  version: number
  contentVersion: number
  unchanged?: boolean
}

export interface SyncTransport {
  getState(): Promise<OutlineStateSnapshot>
  patchSteps(baseVersion: number, requestId: string, steps: StepJson[]): Promise<WriteResult>
}

export interface RequestError extends Error {
  status?: number
  issues?: { currentVersion?: number, currentContentVersion?: number }
  currentVersion?: number
  currentContentVersion?: number
}

export type SyncStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict'

export interface ConflictInfo {
  remoteVersion: number
  remoteContentVersion: number
  localSteps: StepJson[]
}

export interface SyncEvents {
  onStatus?(s: SyncStatus, error?: string): void
  onConflict?(info: ConflictInfo): void
  onVersion?(version: number, contentVersion: number): void
  // 远端最新状态（pull/refresh 成功）。由外层决定何时安全应用到编辑器
  onRemoteState?(state: OutlineStateSnapshot): void
}

const RETRY_DELAY_MS = 0 // 测试可控；外层可包 setTimeout

export class OutlineSyncCore {
  readonly queue = new StepsQueue()
  version = 0
  contentVersion = 0
  status: SyncStatus = 'saved'
  lastError = ''
  // 冲突时保留的本地草稿（正文 + 全部未提交 steps）
  localDraft: { content: Record<string, unknown> | null, steps: StepJson[] } | null = null
  // 输入中/IME 期间收到的远端更新挂起
  remotePullPending = false
  private flushing = false
  private currentDoc: Record<string, unknown> | null = null
  private transport: SyncTransport
  private events: SyncEvents
  private newRequestId: () => string

  constructor(
    transport: SyncTransport,
    events: SyncEvents = {},
    newRequestId: () => string,
  ) {
    this.transport = transport
    this.events = events
    this.newRequestId = newRequestId
  }

  private setStatus(s: SyncStatus, error = '') {
    this.status = s
    this.lastError = error
    this.events.onStatus?.(s, error)
  }

  trackDoc(doc: Record<string, unknown>) {
    this.currentDoc = doc
  }

  // 新输入：永不丢弃；超上限仅告警（显式背压，不丢步骤）
  enqueue(steps: StepJson[], softCap = 8000): { accepted: boolean, warning?: string } {
    this.queue.enqueue(steps)
    if (this.status === 'saved') this.setStatus('dirty')
    if (this.queue.size > softCap) {
      return { accepted: true, warning: `未保存修改已达 ${this.queue.size} 步，请等待保存后再继续大量输入` }
    }
    return { accepted: true }
  }

  // 主写循环：优先重试 in-flight（同 requestId+payload+baseVersion），否则取新批
  async flush(): Promise<boolean> {
    if (this.flushing) return false
    // 取批：in-flight 优先（幂等重试）；否则新批次（新 requestId，不含后续新输入）
    let batch: StepJson[] | null = null
    let rid = ''
    if (this.queue.inFlight) {
      rid = this.queue.inflightRequestId
      batch = this.queue.takeFlightPayload()
    }
    else {
      rid = this.newRequestId()
      batch = this.queue.takeBatch(rid)
    }
    if (!batch || !batch.length) return true

    this.flushing = true
    this.setStatus('saving')
    const baseVersion = this.version
    const baseContentVersion = this.contentVersion
    let done = false
    try {
      const res = await this.transport.patchSteps(baseVersion, rid, batch)
      this.queue.commit()
      this.version = res.version
      this.contentVersion = res.contentVersion
      this.events.onVersion?.(res.version, res.contentVersion)
      done = true
      this.setStatus(this.queue.size ? 'dirty' : 'saved')
    }
    catch (err) {
      const e = err as RequestError
      const curV = e.issues?.currentVersion ?? e.currentVersion
      const curCV = e.issues?.currentContentVersion ?? e.currentContentVersion
      if (e.status === 409) {
        if (curCV !== undefined && curCV === baseContentVersion) {
          // 仅元数据版本推进（评论/线程）：正文基线未变，steps 仍安全 → 更新版本重放
          this.version = curV ?? this.version
          this.queue.requeue()
          this.queue.takeBatch(rid) // 重新进入 in-flight 同 requestId
        }
        else {
          // 正文已变：全部未提交 steps 保序放回 + 保存草稿 → conflict，绝不盲放
          const steps = [...(this.queue.snapshotAll())]
          this.queue.requeue()
          this.localDraft = { content: this.currentDoc, steps }
          this.setStatus('conflict', e.message || '版本冲突')
          this.events.onConflict?.({
            remoteVersion: curV ?? 0,
            remoteContentVersion: curCV ?? 0,
            localSteps: steps,
          })
        }
      }
      else if (e.status !== undefined && e.status >= 400 && e.status < 500) {
        // 明确拒绝：批次回队首 + offline（不伪装已保存）
        this.queue.requeue()
        this.setStatus('offline', e.message || `保存失败（${e.status}）`)
      }
      else {
        // 网络/5xx 不确定：flight 保持原 requestId 待重试
        this.setStatus('offline', e.message || '网络错误，恢复后自动重试')
      }
    }
    finally {
      this.flushing = false
    }
    return done
  }

  // 排空：提交/确认/导航前调用；冲突或持续失败返回 false
  async drain(maxRounds = 40): Promise<boolean> {
    for (let i = 0; i < maxRounds; i++) {
      if (!this.queue.size) return true
      if (this.status === 'conflict') return false
      const ok = await this.flush()
      if (!ok && (this.status as string) === 'conflict') return false
      if (!ok) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
      }
    }
    return !this.queue.size
  }

  // 独立 GET 补拉（初始化、SSE 重连、延迟安全时机）。有未提交内容只更新元数据版本，
  // 不覆盖本地正文；无未提交内容才允许外层应用全量状态。
  async pull(applyRemote: boolean): Promise<'applied' | 'deferred' | 'meta-only'> {
    const state = await this.transport.getState()
    if (this.queue.size) {
      this.version = Math.max(this.version, state.version)
      this.remotePullPending = true
      this.events.onRemoteState?.(state)
      return 'deferred'
    }
    if (applyRemote) {
      this.version = state.version
      this.contentVersion = state.contentVersion
      this.events.onRemoteState?.(state)
      return 'applied'
    }
    this.events.onRemoteState?.(state)
    return 'meta-only'
  }

  // 冲突后：取回最新版；本地草稿保留在 localDraft 供复制/人工迁移
  async resolveConflict(): Promise<OutlineStateSnapshot> {
    const state = await this.transport.getState()
    this.version = state.version
    this.contentVersion = state.contentVersion
    this.queue.clear()
    this.setStatus('saved')
    this.events.onRemoteState?.(state)
    return state
  }

  dropDraft() {
    this.localDraft = null
  }

  get pendingCount() {
    return this.queue.size
  }
  get hasUnsaved() {
    return this.queue.size > 0 || this.status === 'saving' || this.status === 'dirty'
  }
}
