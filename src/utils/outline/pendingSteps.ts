// 待保存 steps 队列：纯模块，不依赖框架，便于离线回归测试。
// 语义：enqueue 追加不截断；takeBatch 取前 N 条；commit 仅删除已确认发送的条数；
// requeue 在请求未确认完成时把取出的批次放回队首，保序且不丢步。

export const MAX_BATCH = 200

export class StepsQueue {
  private steps: Record<string, unknown>[] = []
  private flight: Record<string, unknown>[] | null = null
  // 每个 in-flight 批次自己的 requestId：网络结果不确定时按同一 requestId 重试（服务端幂等）
  private flightRequestId = ''

  get size(): number {
    return this.steps.length + (this.flight?.length ?? 0)
  }
  get pendingCount(): number {
    return this.steps.length
  }
  get inFlight(): boolean {
    return this.flight !== null
  }
  get inflightRequestId(): string {
    return this.flightRequestId
  }

  enqueue(batch: Record<string, unknown>[]): number {
    this.steps.push(...batch)
    return this.steps.length
  }

  // in-flight 批次内容（用于同 requestId 重试；不重置飞行状态）
  takeFlightPayload(): Record<string, unknown>[] | null {
    return this.flight
  }

  // 取一批（<=MAX_BATCH），记录 in-flight 状态；已在飞行中返回 null
  takeBatch(requestId: string): Record<string, unknown>[] | null {
    if (this.flight) return null
    if (!this.steps.length) return null
    this.flight = this.steps.splice(0, MAX_BATCH)
    this.flightRequestId = requestId
    return this.flight
  }

  // 写成功：丢弃已提交的批次
  commit(): void {
    this.flight = null
    this.flightRequestId = ''
  }

  // 结果不确定（网络错误/超时）：批次回队首，可安全按同一 requestId 重试
  requeue(): string {
    if (this.flight) this.steps = [...this.flight, ...this.steps]
    const rid = this.flightRequestId
    this.flight = null
    this.flightRequestId = ''
    return rid
  }

  // 冲突放弃本地修改时取回全部未提交 steps（供复制/展示，不清空）
  snapshotAll(): Record<string, unknown>[] {
    return [...(this.flight ?? []), ...this.steps]
  }

  clear(): void {
    this.steps = []
    this.flight = null
    this.flightRequestId = ''
  }
}
