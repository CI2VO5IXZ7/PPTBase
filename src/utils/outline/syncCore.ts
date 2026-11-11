// 大纲自动保存状态机：框架无关纯实现，transport 可注入 → 离线回归测试全生命周期。
// 规则（§4.6）：
//  - steps 永不静默丢弃；每批 ≤MAX_BATCH，in-flight 批次带稳定 requestId；
//  - 网络/5xx 结果不确定 → 保留 flight，下一次 flush 用同一 requestId+payload+baseVersion 重试；
//    飞行期间新输入只进待发送队列，绝不混入已飞行的 payload；
//  - 4xx 明确失败 → 批次回队首 + 状态 offline；
//  - 409 → 区分「仅元数据版本变化（contentVersion 未变，可安全重放）」与「正文已变（冲突）」；
//  - 仅元数据变化：更新 baseVersion 后立即自动重试一次；正文变化：保留全部本地 steps+草稿，进入 conflict；
//  - 断线重连必须独立 GET 当前状态补拉，不依赖 SSE 事件回放；
//  - drain 把编辑器 debounce 与队列全部排空后才允许提交/确认/导航；
//  - buffered（编辑器 debounce 未落队的输入）视为未提交：不落队不报 saved，drain 等其排空；
//  - pull 响应按版本单调守卫：更慢的旧快照不得回滚已推进的 version/contentVersion；
//  - composing 中或仅有缓冲未落队时 pull 只挂起 remotePullPending：不推进版本、不应用远端、不建空草稿；
//  - 冲突远端版本单调：更慢的旧快照不得回滚已上报的 conflictRemote（409 与 pull 共享水位；
//    onConflict 统一上报水位值而非原始快照，低于水位的旧 409/旧 pull 不重发事件）；
//  - 冲突期间继续编辑并入 localDraft 并 onDraftUpdate 实时同步外层；resolveConflict 清队列前
//    移交最新草稿后隔离（localDraft 置空）；draftDropped 仅冲突态 dropDraft 置位（非冲突态
//    丢弃只关横幅清归档）、仅首次进入冲突或 resolveConflict 时复位，已 drop 草稿不因后到
//    409/更高 pull/卸载兜底 snapshot 复活；
//  - resolveConflict 递增 resetEpoch：在途 flush 的迟到结果（成功/409/5xx）纪元不符即整体
//    丢弃，不回滚版本、不改状态、不触发事件、不重建草稿；同时结清 buffered/remotePullPending
//    /composing；drain 全程校验纪元，期间发生 resolve 即返回 false——队空是清出来的不是发完的；
//    重叠的 resolveConflict 同理：自身 GET 返回时纪元已被更新调用抬高即整体丢弃返回 null，
//    后到旧快照不得回滚新 resolve 已应用的版本/远端状态、不得重复移交草稿；
//  - drain 失败退避按剩余时限截断，不超 maxWaitMs 预算空等。
//  - 外部 ops（moveBlock）的正文 409 经 noteExternalConflict 进入 conflict：不重放该 op、
//    不改 currentDoc / 版本、不覆盖未保存正文；有未提交队列或缓冲时并入 localDraft，
//    已 drop 的草稿不复活。peekRemoteVersion 只读远端版本，不应用正文。

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
  // 本地草稿移交（resolveConflict 清队列前）：外层应 stashDraft 保留供取回/复制
  onDraft?(draft: { content: Record<string, unknown> | null, steps: StepJson[] }): void
  // 冲突期间草稿内容变化实时同步外层（区别于 resolveConflict 一次性移交的 onDraft）
  onDraftUpdate?(draft: { content: Record<string, unknown> | null, steps: StepJson[] }): void
}

// drain 失败重试退避：真实间隔，连续失败线性增长并封顶，不做 0ms 空转
const RETRY_DELAY_MS = 300
const RETRY_DELAY_MAX_MS = 2000
// drain 总耗时上限：超时立即返回 false，不跑满 maxRounds
const DRAIN_MAX_WAIT_MS = 10_000

export class OutlineSyncCore {
  readonly queue = new StepsQueue()
  version = 0
  contentVersion = 0
  status: SyncStatus = 'saved'
  lastError = ''
  // 冲突时保留的本地草稿（正文 + 全部未提交 steps）
  localDraft: { content: Record<string, unknown> | null, steps: StepJson[] } | null = null
  // 编辑器 300ms 聚合缓冲内尚未 emit 到队列的本地输入：补拉/远端应用同样视为「有未提交内容」。
  // 清位点仅在 enqueue 落队（缓冲已并入该批 steps）或外层显式确认；PATCH 成功不得清位——
  // 缓冲里可能已有更新的输入
  buffered = false
  setBuffered(v: boolean) {
    this.buffered = v
    if (v && this.status === 'saved') this.setStatus('dirty')
  }
  // IME 组合中：pull 不推进版本/不建冲突草稿只挂起；hook 的 compositionstart/end 同步到此
  composing = false
  setComposing(v: boolean) {
    this.composing = v
  }
  // 已见过的最高冲突远端版本（pull 与 409 共享水位）：更慢的旧快照不得回滚 conflictRemote
  private conflictRemoteVersion = 0
  private conflictRemoteContentVersion = 0
  // 用户显式丢弃草稿后置位：resolveConflict 不得从队列复活草稿；新冲突入口复位
  private draftDropped = false
  // resolveConflict 纪元：每次调用 +1，使在途 flush/重叠 resolve 的迟到结果整体失效
  private resetEpoch = 0
  // 输入中/IME 期间收到的远端更新挂起
  remotePullPending = false
  // 在途 flush Promise：并发调用共享同一结果，不当作失败
  private inflightFlush: Promise<boolean> | null = null
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
    // 冲突期间继续编辑：草稿正文跟随最新本地快照并实时同步外层（resolve/drop 后隔离不再更新）
    if (this.localDraft && this.status === 'conflict' && doc !== this.localDraft.content) {
      this.localDraft.content = doc
      this.events.onDraftUpdate?.(this.localDraft)
    }
  }

  // 新输入：永不丢弃；超上限仅告警（显式背压，不丢步骤）
  enqueue(steps: StepJson[], softCap = 8000): { accepted: boolean, warning?: string } {
    this.queue.enqueue(steps)
    // 编辑器缓冲已随本批 steps 落队 → buffered 的明确清位点
    this.buffered = false
    // 冲突期间继续编辑：新 steps 并入草稿（引用去重、保序，不重复追加已在草稿内的），
    // 有实际新增才实时同步外层（resolve/drop 后隔离不再更新）
    if (this.localDraft && this.status === 'conflict') {
      let added = false
      for (const s of steps) {
        if (!this.localDraft.steps.includes(s)) {
          this.localDraft.steps.push(s)
          added = true
        }
      }
      if (added) this.events.onDraftUpdate?.(this.localDraft)
    }
    if (this.status === 'saved') this.setStatus('dirty')
    if (this.queue.size > softCap) {
      return { accepted: true, warning: `未保存修改已达 ${this.queue.size} 步，请等待保存后再继续大量输入` }
    }
    return { accepted: true }
  }

  // 主写循环入口：已有 flush 在途时并发调用等待同一结果（不算失败），否则执行一轮
  async flush(): Promise<boolean> {
    if (this.inflightFlush) return this.inflightFlush
    // 冲突状态下不发新 steps（必被 409 拒绝且混淆基线），等显式 resolveConflict
    if (this.status === 'conflict') return false
    this.inflightFlush = this.runFlush()
    try {
      return await this.inflightFlush
    }
    finally {
      this.inflightFlush = null
    }
  }

  // 主写循环：优先重试 in-flight（同 requestId+payload+baseVersion），否则取新批
  private async runFlush(): Promise<boolean> {
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

    this.setStatus('saving')
    const baseVersion = this.version
    const baseContentVersion = this.contentVersion
    // 发送前记纪元：await 期间 resolveConflict 会 +1，迟到结果不得再碰任何状态
    const epoch = this.resetEpoch
    let done = false
    try {
      const res = await this.transport.patchSteps(baseVersion, rid, batch)
      if (epoch !== this.resetEpoch) return false
      this.queue.commit()
      this.version = res.version
      this.contentVersion = res.contentVersion
      this.events.onVersion?.(res.version, res.contentVersion)
      done = true
      // 队列空但编辑器缓冲仍有未落队输入时不得报 saved（否则掩盖未提交内容）
      this.setStatus(this.queue.size || this.buffered ? 'dirty' : 'saved')
    }
    catch (err) {
      if (epoch !== this.resetEpoch) return false
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
          // 与 pull 冲突分支共享水位：低于已上报水位的旧 409 只落队列，不回滚、不重发事件
          const entering = this.status !== 'conflict'
          const staleReport = !entering
            && (curV ?? 0) <= this.conflictRemoteVersion
            && (curCV ?? 0) <= this.conflictRemoteContentVersion
          this.conflictRemoteVersion = Math.max(this.conflictRemoteVersion, curV ?? 0)
          this.conflictRemoteContentVersion = Math.max(this.conflictRemoteContentVersion, curCV ?? 0)
          // 仅首次进入冲突复位丢弃标记：已 drop 的草稿不得因后到 409 复活
          if (entering) this.draftDropped = false
          if (!this.draftDropped) this.localDraft = { content: this.currentDoc, steps }
          this.setStatus('conflict', e.message || '版本冲突')
          // 统一上报单调水位值（非原始 409 快照）：更慢的旧 409 不得回滚 UI 的 conflictRemote
          if (!staleReport && !this.draftDropped) {
            this.events.onConflict?.({
              remoteVersion: this.conflictRemoteVersion,
              remoteContentVersion: this.conflictRemoteContentVersion,
              localSteps: steps,
            })
          }
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
    return done
  }

  // 排空：提交/确认/导航前调用；冲突、超时或持续失败返回 false。
  // flush 在途时与剩余时限竞速——超时返回 false 但不中断请求：在途 flush 仍在后台完成并
  // 正常推进版本/队列，下一次 drain/flush 经 inflightFlush 复用结果，不重复发送；
  // 失败重试带真实退避间隔，不做 0ms 空转
  async drain(maxRounds = 40, maxWaitMs = DRAIN_MAX_WAIT_MS): Promise<boolean> {
    const start = Date.now()
    // 入口记纪元：在途 flush/退避期间 resolveConflict 会抬纪元并清队列，
    // 随后的「队空」是清出来的而非发完的，drain 必须返回 false 不得放行提交/确认/跳转
    const epoch = this.resetEpoch
    let failures = 0
    for (let i = 0; i < maxRounds; i++) {
      if (this.resetEpoch !== epoch) return false
      if (!this.queue.size && !this.buffered) return true
      if (this.status === 'conflict') return false
      const remaining = maxWaitMs - (Date.now() - start)
      // 总耗时超上限立即返回 false，不跑满 maxRounds
      if (remaining <= 0) return false
      if (!this.queue.size) {
        // 仅剩编辑器 debounce 未落队：等其 emit 入队（外层 flushNow/300ms 定时器会触发）
        await new Promise(r => setTimeout(r, Math.min(Math.max(50, maxWaitMs / maxRounds), remaining)))
        continue
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      const ok = await Promise.race([
        this.flush(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining) }),
      ])
      if (timer) clearTimeout(timer) // flush 先完成时清掉竞速定时器，不留挂起句柄
      if (ok === null) return false // 在途请求超时：返回 false，后台继续不丢弃
      if (!ok && (this.status as string) === 'conflict') return false
      if (!ok) {
        // 连续失败线性退避（封顶 RETRY_DELAY_MAX_MS），成功后复位
        failures++
        if (Date.now() - start >= maxWaitMs) return false
        await new Promise(r => setTimeout(r, Math.min(RETRY_DELAY_MS * failures, RETRY_DELAY_MAX_MS, Math.max(0, maxWaitMs - (Date.now() - start)))))
      }
      else failures = 0
    }
    return this.resetEpoch === epoch && !this.queue.size && !this.buffered
  }

  // 独立 GET 补拉（初始化、SSE 重连、延迟安全时机）。有未提交内容只更新元数据版本，
  // 不覆盖本地正文；无未提交内容才允许外层应用全量状态。
  async pull(applyRemote: boolean): Promise<'applied' | 'deferred' | 'meta-only' | 'stale'> {
    const state = await this.transport.getState()
    // 单调守卫：并发 pull 中更慢的旧响应不得回滚已推进的版本（含 PATCH 提交推进的）；
    // 不更新版本、不触发 onRemoteState，元数据分支同样适用
    if (state.version < this.version || state.contentVersion < this.contentVersion) return 'stale'
    // 组合中/仅有缓冲未落队：只挂起不推进版本、不应用远端、不建空 steps 冲突草稿；
    // 组合结束或缓冲落队后补拉重跑本函数，冲突检测不丢只是延迟
    if (this.composing || (this.buffered && !this.queue.size)) {
      this.remotePullPending = true
      return 'deferred'
    }
    if (this.queue.size || this.buffered) {
      // 远端正文已变 + 本地未提交 steps：不得推进版本盲放旧位置 steps → 进入冲突保草稿
      if (state.contentVersion > this.contentVersion) {
        // 冲突远端水位单调：更慢的旧快照不得回滚已上报的 conflictRemote、不重复触发冲突事件
        if (state.version <= this.conflictRemoteVersion && state.contentVersion <= this.conflictRemoteContentVersion) return 'stale'
        this.conflictRemoteVersion = state.version
        this.conflictRemoteContentVersion = state.contentVersion
        this.remotePullPending = true
        // 仅首次进入冲突复位丢弃标记：已 drop 的草稿不得因更高 pull 复活、不重发冲突事件
        // （水位仍按事实单调前进，UI 已处于冲突态）
        if (this.status !== 'conflict') this.draftDropped = false
        if (!this.draftDropped) this.localDraft = { content: this.currentDoc, steps: [...this.queue.snapshotAll()] }
        this.setStatus('conflict', '远端正文已更新，与本地未保存修改冲突')
        if (!this.draftDropped) {
          this.events.onConflict?.({
            remoteVersion: this.conflictRemoteVersion,
            remoteContentVersion: this.conflictRemoteContentVersion,
            localSteps: this.localDraft?.steps ?? [],
          })
        }
        this.events.onRemoteState?.(state)
        return 'deferred'
      }
      // 仅元数据推进：版本可前进（正文基线未变，steps 基线仍有效）
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

  // 冲突后：取回最新版；本地草稿经 onDraft 移交外层（store）保留供复制/人工迁移，
  // 移交后 localDraft 置空隔离——解决后的正常编辑不得再改写已归档草稿。
  // 返回契约：正常应用返回拉取的快照；纪元已失效的重叠调用返回 null（core 内无法如实
  // 构造 content/threads/status 的「当前」快照，故用哨兵而非编造——调用方只需知道
  // null = 本次未应用任何状态，不产生任何副作用）
  async resolveConflict(): Promise<OutlineStateSnapshot | null> {
    // 先抬纪元再拉取：使在途 flush 的迟到结果整体失效，不得回滚已解决状态；
    // 记下本纪元供 GET 返回时校验重叠 resolve
    this.resetEpoch++
    const epoch = this.resetEpoch
    const state = await this.transport.getState()
    // 重叠 resolve：更新的调用已抬纪元（其结果将/已应用），本次旧快照整体丢弃——
    // 不动版本、不改状态、不清队列、不移交草稿、不触发 onRemoteState/onVersion 等任何事件；
    // 否则后到的旧 GET 会把编辑器和版本回滚到新 resolve 之前
    if (epoch !== this.resetEpoch) return null
    this.version = state.version
    this.contentVersion = state.contentVersion
    this.conflictRemoteVersion = 0
    this.conflictRemoteContentVersion = 0
    // 清队列前把本地未提交内容移交外层保存：冲突期间的续编已并入 localDraft，
    // 兜底再并入队列剩余，保证刷新后用户仍能从 store 草稿取回/复制；
    // 用户已显式 dropDraft 时不得从队列重建移交（解决后草稿不复活）
    if (!this.draftDropped && (this.localDraft || this.queue.size)) {
      const draft = this.localDraft ?? { content: this.currentDoc, steps: [] as StepJson[] }
      for (const s of this.queue.snapshotAll()) if (!draft.steps.includes(s)) draft.steps.push(s)
      this.events.onDraft?.(draft)
    }
    // 移交后隔离：解决后的正常编辑不得再篡改已归档草稿
    this.localDraft = null
    this.draftDropped = false
    this.queue.clear()
    // getState 等待期间产生的缓冲/挂起拉取一并结清：远端状态已拉取应用、不再补拉；
    // 解决期间的新输入由外层禁编保证不产出（旧基线 steps 不得按新版本发出）
    this.buffered = false
    this.remotePullPending = false
    // 组合态一并结清：解决期间编辑器只读，部分浏览器不触发 compositionend，
    // 残留 true 会让 onRemoteState → applyRemoteState 永久挂起、编辑器停在旧冲突文档；
    // 必须在 onRemoteState 之前清零
    this.composing = false
    this.setStatus('saved')
    this.events.onRemoteState?.(state)
    return state
  }

  // 块移动等外部 ops 的正文 409。不发送、不重放该 op，也不把远端正文写进 currentDoc。
  // 版本对不齐时仍进入 conflict（不报 saved）。已丢弃的草稿不得借这次冲突复活。
  noteExternalConflict(info: {
    remoteVersion: number | null
    remoteContentVersion: number | null
    message?: string
  }): void {
    // 已经飞出去的 steps 回包不得把本次 conflict 盖成 saved，也不得顺势重放失败的 op。
    this.resetEpoch++
    const entering = this.status !== 'conflict'
    const curV = info.remoteVersion
    const curCV = info.remoteContentVersion
    const comparable = curV != null && curCV != null
    const staleReport = !entering
      && comparable
      && curV <= this.conflictRemoteVersion
      && curCV <= this.conflictRemoteContentVersion
    if (curV != null) this.conflictRemoteVersion = Math.max(this.conflictRemoteVersion, curV)
    if (curCV != null) this.conflictRemoteContentVersion = Math.max(this.conflictRemoteContentVersion, curCV)
    if (entering) this.draftDropped = false
    const unsaved = this.queue.size > 0 || this.buffered || this.localDraft != null
    if (!this.draftDropped && unsaved && !this.localDraft) {
      this.localDraft = { content: this.currentDoc, steps: [...this.queue.snapshotAll()] }
    }
    this.setStatus('conflict', info.message || '版本冲突')
    if (staleReport || this.draftDropped || !comparable) return
    this.events.onConflict?.({
      remoteVersion: this.conflictRemoteVersion,
      remoteContentVersion: this.conflictRemoteContentVersion,
      localSteps: this.localDraft?.steps ?? [],
    })
  }

  // 409 体没有 contentVersion 时补一对远端版本。不更新本地版本、不触发 onRemoteState。
  async peekRemoteVersion(): Promise<{ version: number, contentVersion: number } | null> {
    try {
      const state = await this.transport.getState()
      return { version: state.version, contentVersion: state.contentVersion }
    }
    catch {
      return null
    }
  }

  dropDraft() {
    this.localDraft = null
    // 仅冲突态置位：「已 drop 不复活」只对本场冲突有意义。非冲突态的丢弃只是
    // 关闭已归档草稿横幅（resolve 后 store 仍持有草稿副本），不得留下永久标志
    // 污染后续正常编辑的卸载兜底 snapshotPendingDraft
    if (this.status === 'conflict') this.draftDropped = true
  }

  // 销毁/卸载前兜底：仍待提交的 steps + 当前本地正文快照，供外层存草稿（清队列不丢数据）
  snapshotPendingDraft(): { content: Record<string, unknown> | null, steps: StepJson[] } | null {
    // 用户已显式丢弃：卸载兜底不得从残留队列复活草稿；
    // draftDropped 仅冲突态有意义——非冲突态不误拦兜底（纵深防御，冲突态行为不变）
    if (this.draftDropped && this.status === 'conflict') return null
    const steps = this.queue.snapshotAll()
    if (!steps.length) return null
    return { content: this.currentDoc ?? this.localDraft?.content ?? null, steps }
  }

  // SSE 远端事件入口：有未提交 steps/in-flight 或合成中 → 挂起，flush/合成结束后补拉；
  // 安全时机返回 true，调用方执行 pull(true)。
  requestPull(deferring: boolean): boolean {
    if (this.queue.size || this.queue.inFlight || this.buffered || this.composing || deferring) {
      this.remotePullPending = true
      return false
    }
    return true
  }

  get pendingCount() {
    return this.queue.size
  }
  // 含在途批次（元数据 409 重放/多批次续传都依赖它触发下一轮 flush）
  get hasPending() {
    return this.queue.size > 0 || this.queue.inFlight
  }
  get hasUnsaved() {
    return this.queue.size > 0 || this.buffered || this.status === 'saving' || this.status === 'dirty' || this.status === 'offline'
  }
}
