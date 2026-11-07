import test from 'node:test'
import assert from 'node:assert/strict'
import { outlineActionBlocked } from '../outline/submitGate.ts'

const base = { busy: false, readonly: false, uploadsPending: 0, saveStatus: 'saved' }

test('上传中或失败计数阻塞提交/确认', () => {
  assert.equal(outlineActionBlocked({ ...base, uploadsPending: 1 }), true)
  // 失败但未移除同样计 pending（上传中+失败都算）
  assert.equal(outlineActionBlocked({ ...base, uploadsPending: 3 }), true)
  // 全部成功/显式移除后放行
  assert.equal(outlineActionBlocked(base), false)
})

test('只读/忙碌/冲突/保存中阻塞', () => {
  assert.equal(outlineActionBlocked({ ...base, readonly: true }), true)
  assert.equal(outlineActionBlocked({ ...base, busy: true }), true)
  assert.equal(outlineActionBlocked({ ...base, saveStatus: 'conflict' }), true)
  assert.equal(outlineActionBlocked({ ...base, saveStatus: 'saving' }), true)
})

test('未保存/离线不直接阻塞（由 drain 冲刷后再判定）', () => {
  assert.equal(outlineActionBlocked({ ...base, saveStatus: 'dirty' }), false)
  assert.equal(outlineActionBlocked({ ...base, saveStatus: 'offline' }), false)
})
