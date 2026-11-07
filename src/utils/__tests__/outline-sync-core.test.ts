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
    patch: (p: { steps: unknown[] }) => {
      calls.push(p)
      return Promise.resolve({ ok: true as const, version: 2, contentVersion: 2 })
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
