// 可直接运行：node --test src/utils/__tests__/outline-ops-conflict.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  conflictInputLocked,
  outlineOpsContentConflict,
  resolveOpsConflictVersions,
} from '../outline/editorGuards.ts'

test('正文 ops 409 取出版本对；openThreads 确认 409 不是正文冲突', () => {
  assert.deepEqual(
    outlineOpsContentConflict({
      status: 409,
      message: 'baseVersion 不一致',
      issues: { currentVersion: 9, currentContentVersion: 4 },
    }),
    { remoteVersion: 9, remoteContentVersion: 4, message: 'baseVersion 不一致' },
  )
  assert.deepEqual(
    outlineOpsContentConflict({
      status: 409,
      message: '冲突',
      currentVersion: 6,
      currentContentVersion: 2,
    }),
    { remoteVersion: 6, remoteContentVersion: 2, message: '冲突' },
  )
  // issues 优先于顶层字段
  assert.deepEqual(
    outlineOpsContentConflict({
      status: 409,
      currentVersion: 1,
      currentContentVersion: 1,
      issues: { currentVersion: 8, currentContentVersion: 3 },
    })?.remoteVersion,
    8,
  )
  assert.equal(outlineOpsContentConflict({
    status: 409,
    message: '还有未解决批注',
    issues: { openThreads: 2, currentVersion: 9, currentContentVersion: 4 },
  }), null)
  assert.equal(outlineOpsContentConflict({ status: 500, message: 'boom' }), null)
  assert.equal(outlineOpsContentConflict(null), null)
  assert.equal(outlineOpsContentConflict(undefined), null)
})

test('409 只有 currentVersion 时不编造 contentVersion', () => {
  assert.deepEqual(
    outlineOpsContentConflict({ status: 409, message: '冲突', currentVersion: 7 }),
    { remoteVersion: 7, remoteContentVersion: null, message: '冲突' },
  )
  assert.deepEqual(
    outlineOpsContentConflict({ status: 409, issues: { requestId: 'same' } }),
    { remoteVersion: null, remoteContentVersion: null, message: '版本冲突' },
  )
})

test('已有正文版本时不改用后来的拉取；缺正文版本才采用同一次只读拉取', () => {
  const reported = { remoteVersion: 9, remoteContentVersion: 4 }
  assert.deepEqual(
    resolveOpsConflictVersions(reported, { version: 12, contentVersion: 8 }),
    reported,
  )
  assert.deepEqual(
    resolveOpsConflictVersions(
      { remoteVersion: 9, remoteContentVersion: null },
      { version: 9, contentVersion: 4 },
    ),
    { remoteVersion: 9, remoteContentVersion: 4 },
  )
  assert.deepEqual(
    resolveOpsConflictVersions(
      { remoteVersion: 9, remoteContentVersion: null },
      { version: 11, contentVersion: 5 },
    ),
    { remoteVersion: 11, remoteContentVersion: 5 },
  )
  // 拉取比 409 更旧：不把旧 contentVersion 配到更新的 version 上
  assert.deepEqual(
    resolveOpsConflictVersions(
      { remoteVersion: 9, remoteContentVersion: null },
      { version: 7, contentVersion: 2 },
    ),
    { remoteVersion: 9, remoteContentVersion: null },
  )
  assert.deepEqual(
    resolveOpsConflictVersions({ remoteVersion: 9, remoteContentVersion: null }, null),
    { remoteVersion: 9, remoteContentVersion: null },
  )
})

test('冲突锁只在没有草稿时生效', () => {
  assert.equal(conflictInputLocked('conflict', false), true)
  assert.equal(conflictInputLocked('conflict', true), false)
  assert.equal(conflictInputLocked('saved', false), false)
})
