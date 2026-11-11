import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cloneDraftBody,
  CONFLICT_REBACKUP_MESSAGE,
  conflictInputLocked,
  conflictRefreshAllowed,
  conflictRefreshDecision,
  noteLocalConflictEdit,
  type DraftBody,
} from '../outline/editorGuards.ts'

const backed: DraftBody = { content: { type: 'doc', text: 'a' }, steps: [{ a: 1 }] }

test('已备份后、steps 尚未入队时又发生本地正文变化，刷新必须被拒绝', () => {
  const invalidated = noteLocalConflictEdit({
    status: 'conflict',
    preserved: true,
    snapshot: backed,
    localDocChange: true,
  })
  assert.equal(invalidated.preserved, false)
  assert.equal(invalidated.snapshot, null)
  assert.equal(invalidated.message, CONFLICT_REBACKUP_MESSAGE)

  // onDocJson 已清掉标志，新 steps 还没进草稿
  const cleared = conflictRefreshDecision({
    draftPreserved: invalidated.preserved,
    hasDraft: true,
    snapshot: invalidated.snapshot,
    current: { content: { type: 'doc', text: 'ab' }, steps: [{ a: 1 }] },
  })
  assert.equal(cleared.allowed, false)

  // 步骤长度监听还没跑，标志仍为真，但正文已经和备份不一致
  const stillLatched = conflictRefreshDecision({
    draftPreserved: true,
    hasDraft: true,
    snapshot: backed,
    current: { content: { type: 'doc', text: 'ab' }, steps: [{ a: 1 }] },
  })
  assert.equal(stillLatched.allowed, false)
  assert.equal(stillLatched.clearPreserve, true)
  assert.equal(stillLatched.message, CONFLICT_REBACKUP_MESSAGE)
})

test('flush 后草稿与备份快照不一致必须拒绝', () => {
  const live = { content: { type: 'doc', text: 'a' }, steps: [{ a: 1 }] }
  const snapshot = cloneDraftBody(live)
  assert.ok(snapshot)
  live.steps.push({ a: 2 })
  ;(live.content as { text: string }).text = 'ab'
  assert.deepEqual(snapshot.steps, [{ a: 1 }])
  assert.equal((snapshot.content as { text: string }).text, 'a')

  const decision = conflictRefreshDecision({
    draftPreserved: true,
    hasDraft: true,
    snapshot,
    current: live,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.clearPreserve, true)
  assert.equal(decision.message, CONFLICT_REBACKUP_MESSAGE)
})

test('选区或非冲突状态不清除备份；快照一致或草稿已不在才放行', () => {
  const selection = noteLocalConflictEdit({
    status: 'conflict',
    preserved: true,
    snapshot: backed,
    localDocChange: false,
  })
  assert.equal(selection.preserved, true)
  assert.equal(selection.snapshot, backed)
  assert.equal(selection.message, null)

  const notConflict = noteLocalConflictEdit({
    status: 'saved',
    preserved: true,
    snapshot: backed,
    localDocChange: true,
  })
  assert.equal(notConflict.preserved, true)
  assert.equal(notConflict.snapshot, backed)

  assert.equal(conflictRefreshDecision({
    draftPreserved: true,
    hasDraft: true,
    snapshot: backed,
    current: { content: { type: 'doc', text: 'a' }, steps: [{ a: 1 }] },
  }).allowed, true)
  assert.equal(conflictRefreshDecision({
    draftPreserved: false,
    hasDraft: false,
    snapshot: null,
    current: null,
  }).allowed, true)
  assert.equal(conflictRefreshDecision({
    draftPreserved: false,
    hasDraft: true,
    snapshot: backed,
    current: backed,
  }).allowed, false)

  assert.equal(conflictRefreshAllowed(false, true), false)
  assert.equal(conflictRefreshAllowed(true, true), true)
  assert.equal(conflictRefreshAllowed(false, false), true)
})

test('冲突且草稿已不在时锁定正文；仍有草稿时不锁定', () => {
  assert.equal(conflictInputLocked('conflict', false), true)
  assert.equal(conflictInputLocked('conflict', true), false)
  assert.equal(conflictInputLocked('saved', false), false)
  assert.equal(conflictInputLocked('dirty', false), false)
  assert.equal(conflictInputLocked('offline', true), false)
})
