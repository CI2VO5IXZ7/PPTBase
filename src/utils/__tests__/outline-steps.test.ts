// 可直接用 Node 22+ 运行：node --test src/utils/__tests__/outline-steps.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StepsQueue, MAX_BATCH } from '../outline/pendingSteps.ts'

test('追加不截断；批量取出仅提交已确认部分', () => {
  const q = new StepsQueue()
  q.enqueue([{ a: 1 }, { a: 2 }])
  q.enqueue([{ a: 3 }])
  assert.equal(q.size, 3)
  const batch = q.takeBatch('r1')!
  assert.equal(batch.length, 3)
  assert.equal(q.inFlight, true)
  q.commit()
  assert.equal(q.size, 0)
})

test('超过 MAX_BATCH 分多批，剩余保留', () => {
  const q = new StepsQueue()
  q.enqueue(Array.from({ length: MAX_BATCH + 10 }, (_, i) => ({ i })))
  const first = q.takeBatch('r1')!
  assert.equal(first.length, MAX_BATCH)
  assert.equal(q.pendingCount, 10)
  q.commit()
  const second = q.takeBatch('r2')!
  assert.equal(second.length, 10)
})

test('不确定结果 requeue 保序放回，重试可用同一 requestId', () => {
  const q = new StepsQueue()
  q.enqueue([{ a: 1 }, { a: 2 }])
  const batch = q.takeBatch('r-x')!
  q.enqueue([{ a: 3 }])
  const rid = q.requeue()
  assert.equal(rid, 'r-x')
  assert.equal(q.size, 3)
  assert.deepEqual(q.takeBatch('r-x'), batch.concat({ a: 3 }))
})

test('飞行中不能再取；snapshotAll 不丢任何步骤', () => {
  const q = new StepsQueue()
  q.enqueue([{ a: 1 }])
  assert.equal(q.takeBatch('r1') !== null, true)
  assert.equal(q.takeBatch('r2'), null)
  q.enqueue([{ a: 2 }])
  assert.deepEqual(q.snapshotAll(), [{ a: 1 }, { a: 2 }])
})
