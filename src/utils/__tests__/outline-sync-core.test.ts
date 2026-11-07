// 可直接运行：node --test src/utils/__tests__/outline-sync-core.test.ts
// 大纲同步状态机离线回归：失败重试/幂等/冲突/背压/补拉，全部用 fake transport。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OutlineSyncCore, type OutlineStateSnapshot, type StepJson, type WriteResult } from '../outline/syncCore.ts'

type PatchCall = { baseVersion: number, requestId: string, steps: StepJson[] }
type Behavior = (call: PatchCall, n: number) => Promise<WriteResult>

function fakeTransport(behavior: Behavior, remote?: () => OutlineStateSnapshot) {
  const calls: PatchCall[] = []
  let remoteState: OutlineStateSnapshot = { version: 1, contentVersion: 1, content: { type: 'doc' }, threads: [], status: null }
  return {
    calls,
    transport: {
      getState: () => Promise.resolve(remote ? remote() : remoteState),
      patchSteps: (baseVersion: number, requestId: string, steps: StepJson[]) => {
        calls.push({ baseVersion, requestId, steps })
        return behavior({ baseVersion, requestId, steps }, calls.length)
      },
      setRemote(s: OutlineStateSnapshot) {
        remoteState = s
      },
    },
  }
}

const okWrite = (v: number, cv: number): WriteResult => ({ version: v, contentVersion: cv })
const rid = () => 'fixed-rid'

// 1. 两次 5xx 后恢复：同 requestId+payload+baseVersion 重试，成功才推进
test('两次 5xx → 恢复：同一 requestId/payload/baseVersion，成功前不丢步', async () => {
  let n = 0
  const { transport, calls } = fakeTransport(() => {
    n++
    if (n <= 2) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }))
    return Promise.resolve(okWrite(2, 2))
  })
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  assert.equal(await core.flush(), false)
  assert.equal(core.status, 'offline')
  assert.equal(await core.flush(), false)
  // 恢复
  assert.equal(await core.flush(), true)
  assert.equal(calls.length, 3)
  for (const c of calls) {
    assert.equal(c.requestId, 'fixed-rid')
    assert.equal(c.baseVersion, 1)
    assert.deepEqual(c.steps, [{ a: 1 }])
  }
  assert.equal(core.status, 'saved')
})

// 2. 飞行期间新输入不混入已发送 payload，独立批次发送
test('飞行期间新输入：不混入 retried payload，成功后单独发送', async () => {
  let call = 0
  const { transport, calls } = fakeTransport(() => {
    call++
    if (call === 1) return Promise.reject(new Error('net'))
    return Promise.resolve(okWrite(2 + call, 2))
  })
  const core = new OutlineSyncCore(transport, {}, (() => {
    let i = 0; return () => `r${++i}`
  })())
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  await core.flush() // 网络失败 → flight 'r1'
  core.enqueue([{ a: 2 }]) // 新输入在飞行期间
  await core.flush() // 重试 r1 批次（仅 a:1）
  assert.deepEqual(calls[1].steps, [{ a: 1 }])
  assert.equal(calls[1].requestId, 'r1')
  // 清空后新输入发送
  await core.flush()
  assert.deepEqual(calls[2].steps, [{ a: 2 }])
  assert.equal(calls[2].requestId, 'r2')
})

// 3. 409 元数据版本变化（contentVersion 未变）→ 安全重放
test('409 仅元数据变化：contentVersion 未变 → 更新版本自动重试', async () => {
  let n = 0
  const { transport, calls } = fakeTransport(() => {
    n++
    if (n === 1) {
      return Promise.reject(Object.assign(new Error('conflict'), {
        status: 409, issues: { currentVersion: 5, currentContentVersion: 1 },
      }))
    }
    return Promise.resolve(okWrite(6, 1))
  })
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  await core.flush() // 409：version 更新到 5，contentVersion 仍 1 → 可重放
  assert.equal(calls.length, 1)
  await core.flush()
  assert.equal(calls[1].baseVersion, 5)
  assert.equal(calls[1].requestId, 'fixed-rid')
  assert.equal(core.status, 'saved')
  assert.equal(core.localDraft, null)
})

// 4. 409 正文变化 → 冲突 + 本地草稿保留全部 steps
test('409 正文变化：conflict + 草稿含全部未提交 steps', async () => {
  const { transport } = fakeTransport(() => Promise.reject(Object.assign(new Error('conflict'), {
    status: 409, issues: { currentVersion: 9, currentContentVersion: 7 },
  })))
  const conflicts: { remoteVersion: number }[] = []
  const core = new OutlineSyncCore(transport, { onConflict: i => {
    conflicts.push(i)
  } }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ type: 'doc', content: [] })
  core.enqueue([{ a: 1 }, { a: 2 }])
  await core.flush()
  assert.equal(core.status, 'conflict')
  assert.equal(conflicts[0].remoteVersion, 9)
  assert.equal(core.localDraft!.steps.length, 2)
  // 再输入也保留（不丢）
  core.enqueue([{ a: 3 }])
  assert.equal(core.queue.size, 3)
})

// 5. drain 在冲突时明确返回 false；正常排空
test('drain：冲突返回 false；正常清空队列返回 true', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.enqueue([{ a: 1 }])
  assert.equal(await core.drain(), true)
  const c2 = new OutlineSyncCore(fakeTransport(() => Promise.reject(Object.assign(new Error('c'), {
    status: 409, issues: { currentVersion: 9, currentContentVersion: 9 },
  }))).transport, {}, rid)
  c2.enqueue([{ a: 1 }])
  assert.equal(await c2.drain(), false)
})

// 6. pull：有未提交内容仅更新元数据不覆盖；无未提交内容应用远端
test('断线重连 pull：独立 GET；未提交时只更新版本不覆盖正文', async () => {
  let remote = { version: 10, contentVersion: 10, content: { type: 'doc', content: [{ type: 'paragraph' }] }, threads: [], status: null }
  const applied: OutlineStateSnapshot[] = []
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(11, 10)), () => remote)
  const core = new OutlineSyncCore(transport, { onRemoteState: s => {
    applied.push(s)
  } }, rid)
  // 无未提交 → 全量应用
  assert.equal(await core.pull(true), 'applied')
  // 有未提交 → deferred，仅元数据
  core.enqueue([{ a: 1 }])
  remote = { ...remote, version: 20 }
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.version, 20)
  assert.equal(core.remotePullPending, true)
})

// 7. 队列压力 >8000：全部保留 + 显式背压告警
test('队列 >8000 步：不丢任何步骤，返回背压告警', async () => {
  const { transport, calls } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  const res = core.enqueue(Array.from({ length: 8100 }, (_, i) => ({ i })))
  assert.equal(res.accepted, true)
  assert.ok(res.warning)
  assert.equal(core.queue.size, 8100)
  // 排空后全部发送（多批次）
  while (core.queue.size) {
    if (!(await core.flush())) break
  }
  const total = calls.reduce((n, c) => n + c.steps.length, 0)
  assert.equal(total, 8100)
})

// 8. 4xx 明确失败：批次回队首 + offline
test('4xx：回队首保留 + offline（不伪装已保存）', async () => {
  const { transport } = fakeTransport(() => Promise.reject(Object.assign(new Error('bad'), { status: 403 })))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.enqueue([{ a: 1 }])
  assert.equal(await core.flush(), false)
  assert.equal(core.status, 'offline')
  assert.equal(core.queue.size, 1)
})

// 9. SSE 事件节流：pending/in-flight/合成中置 remotePullPending，安全时机直拉
test('SSE 事件 → requestPull：有未提交/合成中挂起，安全时机返回 true', async () => {
  const calls: { steps: unknown[] }[] = []
  const transport = {
    patchSteps: (baseVersion: number, requestId: string, steps: StepJson[]) => {
      calls.push({ steps })
      return Promise.resolve({ version: 2, contentVersion: 2 })
    },
    getState: () => Promise.resolve({
      docId: 'd', version: 3, contentVersion: 3, title: '', content: null,
      threads: [], submissions: [], approvals: [], readonly: false, role: 'edit' as const,
    }),
  }
  const core = new OutlineSyncCore(transport, {}, () => 'r')
  // 队列非空 → 挂起
  core.enqueue([{ a: 1 }])
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  // 合成中 → 挂起
  core.queue.clear()
  assert.equal(core.requestPull(true), false)
  assert.equal(core.remotePullPending, true)
  // 干净时机 → 允许立即 pull
  core.remotePullPending = false
  assert.equal(core.requestPull(false), true)
  assert.equal(core.remotePullPending, false)
  // in-flight 期间 → 挂起（不丢服务端映射回执）
  core.enqueue([{ b: 2 }])
  const flushing = core.flush()
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  await flushing
})

// 10. deferred pull：远端正文已变 → 不推进版本，直接 conflict 保草稿；仅元数据变 → 版本可前进
test('pull deferred：正文已变 → conflict+草稿，版本不盲推进；元数据变 → 版本前进', async () => {
  const base: OutlineStateSnapshot = { version: 1, contentVersion: 1, content: { type: 'doc' }, threads: [], status: null }
  const { transport, calls } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  transport.setRemote(base)
  const events: string[] = []
  const core = new OutlineSyncCore(transport, { onConflict: () => events.push('conflict') }, rid)
  assert.equal(await core.pull(true), 'applied') // 初始化基线 v1/cv1
  core.enqueue([{ stepType: 'replace' }])
  transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(calls.length, 0)
  // 远端正文已变（cv 1→3），本地有未提交 → conflict，version 不推进
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.status, 'conflict')
  assert.equal(core.version, 1, '版本不得在未验证 contentVersion 下盲推进到 5')
  assert.deepEqual(events, ['conflict'])
  assert.ok(core.localDraft, '本地草稿必须保留供复制取回')

  // 仅元数据推进（contentVersion 不变）：deferred 但版本可安全前进
  const t2 = fakeTransport(() => Promise.resolve(okWrite(2, 1)))
  t2.transport.setRemote(base)
  const c2 = new OutlineSyncCore(t2.transport, {}, rid)
  assert.equal(await c2.pull(true), 'applied')
  c2.enqueue([{ stepType: 'replace' }])
  t2.transport.setRemote({ version: 7, contentVersion: 1, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await c2.pull(true), 'deferred')
  assert.equal(c2.status, 'dirty')
  assert.equal(c2.version, 7)
})

// 11. buffered：编辑器 debounce 未落队的输入视为未提交；PATCH 成功/空队列都不得报 saved
test('buffered：未落队输入不算已保存；enqueue 落队后 drain 才通过', async () => {
  const { transport, calls } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  // 编辑器 300ms 缓冲有新输入（doc-json 已发、steps 未 emit）
  core.trackDoc({ type: 'doc' })
  core.setBuffered(true)
  assert.equal(core.hasUnsaved, true)
  assert.notEqual(core.status, 'saved')
  // 早期 PATCH 成功（此处为无批空跑）也不得以「已保存」清位
  assert.equal(await core.flush(), true)
  assert.equal(calls.length, 0)
  assert.equal(core.hasUnsaved, true)
  // 缓冲未落队：drain 不得提前返回 true
  assert.equal(await core.drain(40, 60), false)
  // 缓冲经 enqueue 落队 → drain 冲刷后才是真正 saved
  core.enqueue([{ a: 1 }])
  assert.equal(core.buffered, false)
  assert.equal(await core.drain(), true)
  assert.equal(core.status, 'saved')
  assert.equal(core.hasUnsaved, false)
  assert.deepEqual(calls[0].steps, [{ a: 1 }])
})

// 11b. drain 等待期间缓冲落队：正常排空而不是超时失败
test('drain 等待期间 buffered 经 enqueue 落队 → 正常排空', async () => {
  const { transport, calls } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.setBuffered(true)
  const draining = core.drain(40, 2000)
  setTimeout(() => core.enqueue([{ b: 1 }]), 30)
  assert.equal(await draining, true)
  assert.equal(core.status, 'saved')
  assert.deepEqual(calls[0].steps, [{ b: 1 }])
})

// 12. drain 超时：在途 PATCH 不被中断/丢弃，后台完成后不重复发送
test('drain 超时：在途 flush 后台继续完成，版本/队列正常推进不重复发送', async () => {
  let resolvePatch: ((r: WriteResult) => void) | null = null
  const { transport, calls } = fakeTransport(() => new Promise<WriteResult>(r => { resolvePatch = r }))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  // PATCH 挂起超过时限 → drain 立即返回 false，而不是卡在 await flush 上
  assert.equal(await core.drain(40, 40), false)
  assert.equal(calls.length, 1)
  // 在途请求后台完成：正常推进版本/队列，下一次 flush 复用结果不重复发送
  resolvePatch!(okWrite(2, 2))
  assert.equal(await core.flush(), true)
  assert.equal(core.version, 2)
  assert.equal(core.queue.size, 0)
  assert.equal(core.status, 'saved')
  assert.equal(calls.length, 1, '同一批 steps 不得重复发送')
})

// 13. 并发 pull：更慢的旧响应丢弃，version/contentVersion 不回滚、不触发全量应用
test('并发 pull：旧响应不回滚已推进的版本，不触发远端应用', async () => {
  const resolvers: ((s: OutlineStateSnapshot) => void)[] = []
  const applied: OutlineStateSnapshot[] = []
  const transport = {
    getState: () => new Promise<OutlineStateSnapshot>(r => resolvers.push(r)),
    patchSteps: () => Promise.resolve(okWrite(9, 9)),
  }
  const core = new OutlineSyncCore(transport, { onRemoteState: s => applied.push(s) }, rid)
  const pNew = core.pull(true)
  const pOld = core.pull(true)
  // 较新的响应先到 → 应用
  resolvers[0]({ version: 5, contentVersion: 5, content: { type: 'doc', n: 5 }, threads: [], status: null })
  assert.equal(await pNew, 'applied')
  assert.equal(core.version, 5)
  // 更旧的响应后到 → 丢弃，不回滚、不触发 onRemoteState
  resolvers[1]({ version: 3, contentVersion: 3, content: { type: 'doc', n: 3 }, threads: [], status: null })
  assert.equal(await pOld, 'stale')
  assert.equal(core.version, 5)
  assert.equal(core.contentVersion, 5)
  assert.equal(applied.length, 1)
  // 有未提交内容时旧响应同样丢弃（元数据分支也守卫：不挂起、不动版本）
  core.enqueue([{ a: 1 }])
  const p3 = core.pull(true)
  resolvers[2]({ version: 4, contentVersion: 4, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await p3, 'stale')
  assert.equal(core.version, 5)
  assert.equal(core.remotePullPending, false)
})

// 14. 冲突期间继续编辑：trackDoc/enqueue 并入 localDraft；resolveConflict 清队列前移交外层
test('冲突后继续编辑：草稿同步最新正文+steps，resolveConflict 移交完整草稿', async () => {
  const remote: OutlineStateSnapshot = { version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null }
  const { transport, calls } = fakeTransport(
    () => Promise.reject(Object.assign(new Error('conflict'), {
      status: 409, issues: { currentVersion: 9, currentContentVersion: 7 },
    })),
    () => remote,
  )
  const drafts: { content: Record<string, unknown> | null, steps: StepJson[] }[] = []
  const core = new OutlineSyncCore(transport, { onDraft: d => drafts.push(d) }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  await core.flush()
  assert.equal(core.status, 'conflict')
  assert.equal(core.localDraft!.steps.length, 1)
  // 冲突期间继续编辑：正文+新 steps 同步进草稿（同一步骤重复入队不重复追加）
  core.trackDoc({ v: 2 })
  const dup = { a: 2 }
  core.enqueue([dup, { a: 3 }])
  core.enqueue([dup])
  assert.deepEqual(core.localDraft!.content, { v: 2 })
  assert.deepEqual(core.localDraft!.steps, [{ a: 1 }, { a: 2 }, { a: 3 }])
  // 冲突状态下不发新 steps
  const sent = calls.length
  assert.equal(await core.flush(), false)
  assert.equal(calls.length, sent)
  // resolveConflict 清队列前把含续编的最新草稿交外层
  await core.resolveConflict()
  assert.equal(drafts.length, 1)
  assert.deepEqual(drafts[0].content, { v: 2 })
  assert.deepEqual(drafts[0].steps, [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.equal(core.queue.size, 0)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 9)
})

// 15. 在途 pull 期间开始 IME：响应到达只挂起不推进版本，组合结束补拉正常应用
test('在途 pull 期间开始 IME：只挂起不推进版本，组合结束补拉应用远端', async () => {
  const resolvers: ((s: OutlineStateSnapshot) => void)[] = []
  const events: string[] = []
  const transport = {
    getState: () => new Promise<OutlineStateSnapshot>(r => resolvers.push(r)),
    patchSteps: () => Promise.resolve(okWrite(9, 9)),
  }
  const core = new OutlineSyncCore(transport, {
    onRemoteState: () => events.push('remote'),
    onConflict: () => events.push('conflict'),
  }, rid)
  core.version = 1; core.contentVersion = 1
  // pull 已发出、getState 在途：此时开始输入法组合
  const p = core.pull(true)
  core.setComposing(true)
  resolvers[0]({ version: 5, contentVersion: 5, content: { type: 'doc' }, threads: [], status: null })
  // 响应到达：只挂起，不推进版本、不应用远端、不建冲突
  assert.equal(await p, 'deferred')
  assert.equal(core.version, 1)
  assert.equal(core.contentVersion, 1)
  assert.equal(core.remotePullPending, true)
  assert.deepEqual(events, [])
  // 组合结束补拉：正常应用远端并推进版本
  core.setComposing(false)
  const p2 = core.pull(true)
  resolvers[1]({ version: 5, contentVersion: 5, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await p2, 'applied')
  assert.equal(core.version, 5)
  assert.equal(core.contentVersion, 5)
})

// 16. 仅有缓冲无入队 steps 时 pull：deferred 不建空草稿；落队后补拉正常进冲突
test('仅缓冲未落队时 pull：deferred 不建空草稿，落队后补拉正常进冲突', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  const conflicts: { localSteps: StepJson[] }[] = []
  const core = new OutlineSyncCore(transport, { onConflict: i => conflicts.push(i) }, rid)
  core.version = 1; core.contentVersion = 1
  // 编辑器缓冲有输入但 steps 未 emit：不得建空 steps 冲突草稿
  core.setBuffered(true)
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.localDraft, null)
  assert.equal(conflicts.length, 0)
  assert.equal(core.remotePullPending, true)
  assert.equal(core.version, 1)
  // 缓冲落队后补拉：正常进入冲突且草稿含真实 steps
  core.enqueue([{ a: 1 }])
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.status, 'conflict')
  assert.deepEqual(core.localDraft!.steps, [{ a: 1 }])
  assert.equal(conflicts.length, 1)
})

// 17. requestPull 门控：buffered/queue 非空/in-flight/composing 任一成立挂起
test('requestPull 门控：buffered/queue/inFlight/composing 任一成立挂起', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(2, 2)))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  // buffered 未落队 → 挂起
  core.setBuffered(true)
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  core.setBuffered(false)
  core.remotePullPending = false
  // queue 非空 → 挂起
  core.enqueue([{ a: 1 }])
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  core.queue.clear()
  core.remotePullPending = false
  // in-flight → 挂起
  core.enqueue([{ a: 1 }])
  const flushing = core.flush()
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  await flushing
  core.remotePullPending = false
  // composing → 挂起
  core.setComposing(true)
  assert.equal(core.requestPull(false), false)
  assert.equal(core.remotePullPending, true)
  core.setComposing(false)
  core.remotePullPending = false
  // 全部排空 → 允许立即 pull 且不置挂起
  assert.equal(core.requestPull(false), true)
  assert.equal(core.remotePullPending, false)
})

// 18. 冲突期间 onDraftUpdate 实时同步续编；resolveConflict 后归档草稿隔离不被篡改
test('冲突期间 onDraftUpdate 实时同步续编，resolve 后归档草稿隔离不被篡改', async () => {
  const remote: OutlineStateSnapshot = { version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null }
  const { transport } = fakeTransport(
    () => Promise.reject(Object.assign(new Error('conflict'), {
      status: 409, issues: { currentVersion: 9, currentContentVersion: 7 },
    })),
    () => remote,
  )
  const updates: { content: Record<string, unknown> | null, steps: StepJson[] }[] = []
  const handed: { content: Record<string, unknown> | null, steps: StepJson[] }[] = []
  const core = new OutlineSyncCore(transport, {
    onDraftUpdate: d => updates.push({ content: d.content, steps: [...d.steps] }),
    onDraft: d => handed.push(d),
  }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  await core.flush()
  assert.equal(core.status, 'conflict')
  // 冲突期间续编：正文与 steps 实时经 onDraftUpdate 同步出去
  core.trackDoc({ v: 2 })
  core.enqueue([{ a: 2 }])
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[0].content, { v: 2 })
  assert.deepEqual(updates[0].steps, [{ a: 1 }])
  assert.deepEqual(updates[1].content, { v: 2 })
  assert.deepEqual(updates[1].steps, [{ a: 1 }, { a: 2 }])
  // resolveConflict 移交后 core 草稿隔离
  await core.resolveConflict()
  assert.equal(core.localDraft, null)
  assert.equal(handed.length, 1)
  assert.deepEqual(handed[0].content, { v: 2 })
  assert.deepEqual(handed[0].steps, [{ a: 1 }, { a: 2 }])
  // 解决后继续正常编辑：已归档草稿对象不再被改
  core.trackDoc({ v: 3 })
  core.enqueue([{ a: 9 }])
  assert.deepEqual(handed[0].content, { v: 2 })
  assert.deepEqual(handed[0].steps, [{ a: 1 }, { a: 2 }])
})

// 19. 冲突态乱序 pull：更慢的旧快照不得回滚已上报的 conflictRemote
test('冲突态并发 pull：更慢旧快照 stale，不回滚 conflictRemote', async () => {
  const resolvers: ((s: OutlineStateSnapshot) => void)[] = []
  const transport = {
    getState: () => new Promise<OutlineStateSnapshot>(r => resolvers.push(r)),
    patchSteps: () => Promise.resolve(okWrite(9, 9)),
  }
  const conflicts: { remoteVersion: number, remoteContentVersion: number }[] = []
  const core = new OutlineSyncCore(transport, { onConflict: i => conflicts.push(i) }, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  const pNew = core.pull(true)
  const pOld = core.pull(true)
  // 较新的冲突远端先到 → conflict 上报 10/5
  resolvers[0]({ version: 10, contentVersion: 5, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await pNew, 'deferred')
  assert.equal(core.status, 'conflict')
  assert.equal(conflicts[0].remoteVersion, 10)
  assert.equal(conflicts[0].remoteContentVersion, 5)
  // 更慢的旧快照后到 → stale，不重复触发冲突、不回滚已上报的远端版本
  resolvers[1]({ version: 6, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await pOld, 'stale')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].remoteVersion, 10)
  assert.equal(conflicts[0].remoteContentVersion, 5)
})

// 20. 冲突期间 buffered 步骤经 enqueue 落队并入草稿，resolveConflict 移交最新草稿
test('冲突期间 buffered 落队并入草稿：resolveConflict 移交含最新正文的完整草稿', async () => {
  const remote: OutlineStateSnapshot = { version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null }
  const { transport } = fakeTransport(
    () => Promise.reject(Object.assign(new Error('conflict'), {
      status: 409, issues: { currentVersion: 9, currentContentVersion: 7 },
    })),
    () => remote,
  )
  const handed: { content: Record<string, unknown> | null, steps: StepJson[] }[] = []
  const core = new OutlineSyncCore(transport, { onDraft: d => handed.push(d) }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  await core.flush()
  assert.equal(core.status, 'conflict')
  // 冲突期间的输入先进缓冲再落队：并入草稿
  core.trackDoc({ v: 2 })
  core.setBuffered(true)
  core.enqueue([{ a: 2 }])
  assert.equal(core.buffered, false)
  assert.deepEqual(core.localDraft!.steps, [{ a: 1 }, { a: 2 }])
  await core.resolveConflict()
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 9)
  assert.equal(core.contentVersion, 7)
  assert.equal(handed.length, 1)
  assert.deepEqual(handed[0].content, { v: 2 })
  assert.deepEqual(handed[0].steps, [{ a: 1 }, { a: 2 }])
})

// 21. dropDraft 语义：解决后不复活草稿，drop 后编辑不再 onDraftUpdate
test('dropDraft 后 resolveConflict 不移交不重建草稿，后续编辑不再同步草稿', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(9, 7)))
  transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  const updates: unknown[] = []
  const handed: unknown[] = []
  const core = new OutlineSyncCore(transport, {
    onDraftUpdate: d => updates.push(d),
    onDraft: d => handed.push(d),
  }, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  assert.equal(await core.pull(true), 'deferred') // 远端 cv3 > 本地 cv1 → conflict
  assert.equal(core.status, 'conflict')
  core.dropDraft()
  assert.equal(core.localDraft, null)
  // drop 后继续编辑：不再产生 onDraftUpdate
  core.trackDoc({ v: 2 })
  core.enqueue([{ a: 2 }])
  assert.equal(updates.length, 0)
  // resolveConflict：用户已显式丢弃，不得从队列复活移交
  transport.setRemote({ version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null })
  await core.resolveConflict()
  assert.equal(handed.length, 0)
  assert.equal(core.localDraft, null)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 9)
})

// 22. drain 失败退避按剩余时限截断：临近 maxWaitMs 不超预算空等
test('drain 退避按剩余时限截断：恒失败时约 maxWaitMs 返回 false', async () => {
  const { transport } = fakeTransport(() => Promise.reject(Object.assign(new Error('boom'), { status: 500 })))
  const core = new OutlineSyncCore(transport, {}, rid)
  core.enqueue([{ a: 1 }])
  const t0 = Date.now()
  assert.equal(await core.drain(40, 100), false)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 250, `退避不应超过剩余时限预算，实际 ${elapsed}ms`)
})

// 23. pull 冲突先到 + 在途 PATCH 409 后到：跨通道共享水位，旧 409 不回滚不重发
test('pull 先报冲突 10/5 后在途 409(6/3) 到达：水位不回滚、onConflict 不重发', async () => {
  let rejectPatch: ((e: unknown) => void) | null = null
  const { transport } = fakeTransport(() => new Promise<WriteResult>((_res, rej) => { rejectPatch = rej }))
  transport.setRemote({ version: 10, contentVersion: 5, content: { type: 'doc', remote: true }, threads: [], status: null })
  const conflicts: { remoteVersion: number, remoteContentVersion: number }[] = []
  const core = new OutlineSyncCore(transport, { onConflict: i => conflicts.push(i) }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  const flushing = core.flush() // patchSteps(baseVersion=1) 在途
  // pull 先返回远端 v10/cv5 → conflict 上报 10/5
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.status, 'conflict')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].remoteVersion, 10)
  assert.equal(conflicts[0].remoteContentVersion, 5)
  // 在途旧 PATCH 后到：报告的 6/3 低于水位 → 不回滚、不重发
  rejectPatch!(Object.assign(new Error('conflict'), {
    status: 409, issues: { currentVersion: 6, currentContentVersion: 3 },
  }))
  assert.equal(await flushing, false)
  assert.equal(conflicts.length, 1, '低于水位的旧 409 不得重复触发 onConflict')
  assert.equal(conflicts[0].remoteVersion, 10)
  assert.equal(conflicts[0].remoteContentVersion, 5)
  assert.equal(core.status, 'conflict')
  assert.deepEqual(core.localDraft!.steps, [{ a: 1 }])
  // 水位仍是 10/5：等于/低于水位的 pull 快照 stale
  transport.setRemote({ version: 6, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await core.pull(true), 'stale')
})

// 24. resolveConflict 期间在途 PATCH 迟到：结果整体丢弃，不回滚已解决状态
test('resolveConflict 使在途 flush 作废：迟到的成功与 409 均不回滚不复活冲突', async () => {
  const pending: { res: (r: WriteResult) => void, rej: (e: unknown) => void }[] = []
  const { transport } = fakeTransport(() => new Promise<WriteResult>((res, rej) => pending.push({ res, rej })))
  const conflicts: unknown[] = []
  const core = new OutlineSyncCore(transport, { onConflict: i => conflicts.push(i) }, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  const flushing = core.flush() // patchSteps(baseVersion=1) 在途
  // 在途期间用户完成 resolveConflict：刷新到远端 v10/cv5 恢复 saved
  transport.setRemote({ version: 10, contentVersion: 5, content: { type: 'doc', remote: true }, threads: [], status: null })
  await core.resolveConflict()
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 10)
  assert.equal(core.contentVersion, 5)
  // 旧 patchSteps 随后成功返回 v2/cv2：纪元已变 → 整体丢弃，version 不回滚
  pending[0].res(okWrite(2, 2))
  assert.equal(await flushing, false)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 10)
  assert.equal(core.contentVersion, 5)
  assert.equal(conflicts.length, 0)
  assert.equal(core.localDraft, null)
  assert.equal(core.queue.size, 0)
  // 变体：旧 patchSteps 返回 409 同样丢弃，不得打回 conflict 或建空 steps 草稿
  core.enqueue([{ b: 2 }])
  const flushing2 = core.flush()
  transport.setRemote({ version: 11, contentVersion: 6, content: { type: 'doc', remote: true }, threads: [], status: null })
  await core.resolveConflict()
  pending[1].rej(Object.assign(new Error('conflict'), {
    status: 409, issues: { currentVersion: 12, currentContentVersion: 8 },
  }))
  assert.equal(await flushing2, false)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 11)
  assert.equal(core.contentVersion, 6)
  assert.equal(conflicts.length, 0)
  assert.equal(core.localDraft, null)
})

// 25. dropDraft 后：卸载兜底 snapshot 不复活、更高 pull 不复活不重发、resolve 不移交
test('dropDraft 后 snapshot 为 null、更高 pull 不重建草稿不重发冲突、resolve 不移交', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(9, 7)))
  transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  const conflicts: { remoteVersion: number }[] = []
  const handed: unknown[] = []
  const core = new OutlineSyncCore(transport, {
    onConflict: i => conflicts.push(i),
    onDraft: d => handed.push(d),
  }, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  assert.equal(await core.pull(true), 'deferred') // 远端 cv3 > 本地 cv1 → conflict
  assert.equal(core.status, 'conflict')
  assert.equal(conflicts.length, 1)
  core.dropDraft()
  assert.equal(core.localDraft, null)
  // 卸载兜底：已 drop 不得从残留队列复活草稿
  assert.equal(core.snapshotPendingDraft(), null)
  // 更高版本 pull：水位可前进但草稿不复活、冲突事件不重发
  transport.setRemote({ version: 6, contentVersion: 4, content: { type: 'doc', remote: true }, threads: [], status: null })
  assert.equal(await core.pull(true), 'deferred')
  assert.equal(core.status, 'conflict')
  assert.equal(core.localDraft, null)
  assert.equal(conflicts.length, 1, '已 drop 草稿时更高 pull 不得重发 onConflict')
  // resolveConflict：不重建不移交
  transport.setRemote({ version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null })
  await core.resolveConflict()
  assert.equal(handed.length, 0)
  assert.equal(core.localDraft, null)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 9)
})

// 26. resolveConflict 的 getState 在途期间的新输入/挂起拉取：返回后一并结清
test('resolveConflict getState 在途期间的新输入与挂起：完成后 buffered/remotePullPending 清位', async () => {
  const resolvers: ((s: OutlineStateSnapshot) => void)[] = []
  const transport = {
    getState: () => new Promise<OutlineStateSnapshot>(r => resolvers.push(r)),
    patchSteps: () => Promise.resolve(okWrite(2, 2)),
  }
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  const p = core.pull(true)
  resolvers[0]({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  assert.equal(await p, 'deferred')
  assert.equal(core.status, 'conflict')
  // getState 在途期间模拟：编辑器缓冲新输入 + SSE 事件挂起的补拉
  const resolving = core.resolveConflict()
  core.trackDoc({ v: 2 })
  core.setBuffered(true)
  assert.equal(core.requestPull(true), false)
  assert.equal(core.remotePullPending, true)
  resolvers[1]({ version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null })
  await resolving
  assert.equal(core.buffered, false)
  assert.equal(core.remotePullPending, false)
  assert.equal(core.status, 'saved')
  assert.equal(core.version, 9)
  assert.equal(core.contentVersion, 7)
})

// 27. 非冲突态 dropDraft 不置位：resolve（保留草稿）后点「丢弃草稿」，后续编辑的卸载兜底不被污染
test('resolve 后 dropDraft：新编辑 snapshot 正常返回；冲突态 drop 仍为 null', async () => {
  const remote: OutlineStateSnapshot = { version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null }
  const { transport } = fakeTransport(
    () => Promise.reject(Object.assign(new Error('conflict'), {
      status: 409, issues: { currentVersion: 9, currentContentVersion: 7 },
    })),
    () => remote,
  )
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.trackDoc({ v: 1 })
  core.enqueue([{ a: 1 }])
  await core.flush()
  assert.equal(core.status, 'conflict')
  // 「刷新为最新版本（保留草稿）」：草稿移交外层归档，core 内 draftDropped 复位、status 回 saved
  await core.resolveConflict()
  assert.equal(core.status, 'saved')
  // 复制完归档草稿后点「丢弃草稿」关横幅：不得留下永久 draftDropped
  core.dropDraft()
  // 继续正常编辑：卸载兜底必须返回新编辑 steps 而非 null（回归：draftDropped 永久置 true 全丢）
  core.trackDoc({ v: 2 })
  core.enqueue([{ b: 2 }])
  assert.deepEqual(core.snapshotPendingDraft(), { content: { v: 2 }, steps: [{ b: 2 }] })
  // 冲突态 drop 的原有语义不被破坏（与 T25 一致的独立覆盖）
  const t2 = fakeTransport(() => Promise.resolve(okWrite(9, 7)))
  t2.transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  const c2 = new OutlineSyncCore(t2.transport, {}, rid)
  c2.version = 1; c2.contentVersion = 1
  c2.enqueue([{ a: 1 }])
  assert.equal(await c2.pull(true), 'deferred') // 远端 cv3 > 本地 cv1 → conflict
  assert.equal(c2.status, 'conflict')
  c2.dropDraft()
  assert.equal(c2.snapshotPendingDraft(), null)
})

// 28. drain 在途期间 resolveConflict 抬纪元+清队列：drain 不得把「清空」误判为「已保存」
test('drain 在途 flush 期间 resolveConflict：纪元变化 → drain 返回 false', async () => {
  let resolvePatch: ((r: WriteResult) => void) | null = null
  const { transport } = fakeTransport(() => new Promise<WriteResult>(r => { resolvePatch = r }))
  transport.setRemote({ version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null })
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  const draining = core.drain(40, 5000) // flush 在途：patchSteps 挂起
  // drain 等待期间冲突被解决：resetEpoch++、queue.clear() —— 队空是清出来的不是发完的
  await core.resolveConflict()
  assert.equal(core.status, 'saved')
  // 在途 PATCH 随后成功返回：纪元不符整体丢弃；drain 见到 epoch 变化必须返回 false
  resolvePatch!(okWrite(2, 2))
  assert.equal(await draining, false)
  assert.equal(core.version, 9)
  assert.equal(core.queue.size, 0)
})

// 29. resolveConflict 复位 composing：组合中点「刷新为最新版本」后编辑器不停在旧文档
test('resolveConflict 复位 composing：残留组合态不得阻塞远端应用', async () => {
  const { transport } = fakeTransport(() => Promise.resolve(okWrite(9, 7)))
  transport.setRemote({ version: 5, contentVersion: 3, content: { type: 'doc' }, threads: [], status: null })
  const core = new OutlineSyncCore(transport, {}, rid)
  core.version = 1; core.contentVersion = 1
  core.enqueue([{ a: 1 }])
  assert.equal(await core.pull(true), 'deferred') // 远端 cv3 > 本地 cv1 → conflict
  assert.equal(core.status, 'conflict')
  // 组合中点「刷新为最新版本」：编辑器转只读后部分浏览器不发 compositionend → composing 残留
  core.setComposing(true)
  transport.setRemote({ version: 9, contentVersion: 7, content: { type: 'doc', remote: true }, threads: [], status: null })
  await core.resolveConflict()
  assert.equal(core.composing, false)
  assert.equal(core.status, 'saved')
  // 若残留 true，后续 pull 会走 deferred 永久挂起；已清零 → 正常应用远端
  transport.setRemote({ version: 10, contentVersion: 8, content: { type: 'doc', remote2: true }, threads: [], status: null })
  assert.equal(await core.pull(true), 'applied')
  assert.equal(core.version, 10)
  assert.equal(core.contentVersion, 8)
})
