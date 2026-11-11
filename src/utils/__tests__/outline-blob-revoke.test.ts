import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DRAFT_BLOB_REVOKE_DELAY_MS, revokePendingBlobs, scheduleBlobRevoke, type BlobRevokeTimer } from '../outline/blobRevoke.ts'

test('默认在约 1s 后才收回，调度当时不收回；卸载会立刻收回未到期的地址', () => {
  const revoked: string[] = []
  const pending: BlobRevokeTimer[] = []
  scheduleBlobRevoke('blob:late', pending, url => revoked.push(url))
  assert.equal(DRAFT_BLOB_REVOKE_DELAY_MS, 1000)
  assert.deepEqual(revoked, [])
  assert.equal(pending.length, 1)
  revokePendingBlobs(pending, url => revoked.push(url))
  assert.deepEqual(revoked, ['blob:late'])
  assert.equal(pending.length, 0)
})

test('卸载清掉未到期的定时器后不会再收回一次', async () => {
  const revoked: string[] = []
  const pending: BlobRevokeTimer[] = []
  scheduleBlobRevoke('blob:cancel', pending, url => revoked.push(url), 30)
  revokePendingBlobs(pending, url => revoked.push(url))
  assert.deepEqual(revoked, ['blob:cancel'])
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(revoked, ['blob:cancel'])
})

test('延后到期后才收回，且不会重复收回', async () => {
  const revoked: string[] = []
  const pending: BlobRevokeTimer[] = []
  scheduleBlobRevoke('blob:soon', pending, url => revoked.push(url), 20)
  assert.deepEqual(revoked, [])
  const started = Date.now()
  while (revoked.length === 0 && Date.now() - started < 500) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(revoked, ['blob:soon'])
  assert.equal(pending.length, 0)
  revokePendingBlobs(pending, url => revoked.push(`again:${url}`))
  assert.deepEqual(revoked, ['blob:soon'])
})
