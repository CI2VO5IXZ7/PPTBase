import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyUploadedImage,
  canMoveOutlineBlock,
  flushHeldImages,
  moveBlockedByPendingUploads,
  uploadStatusAfterInsert,
  type ImageHold,
  type UploadedImage,
} from '../outline/imageInsert.ts'

const imageA: UploadedImage = { uploadId: 'u1', src: '/assets/a.png', name: 'a.png', assetId: 'asset-a' }
const imageB: UploadedImage = { uploadId: 'u2', src: '/assets/b.png', name: 'b.png', assetId: 'asset-b' }
const locked = { readonly: false, hasView: true, moveLocked: true }
const open = { readonly: false, hasView: true, moveLocked: false }

test('moveLocked 时上传完成不得把图片丢掉，解锁后应插入', () => {
  const placed: string[] = []
  const dispatch = (item: UploadedImage) => {
    placed.push(item.assetId)
    return true
  }
  let hold: ImageHold = { queued: [] }
  const first = applyUploadedImage(hold, imageA, locked, dispatch)
  const second = applyUploadedImage(first.hold, imageB, locked, dispatch)
  assert.equal(first.inserted, false)
  assert.equal(second.inserted, false)
  assert.equal(uploadStatusAfterInsert(first.inserted), 'uploading')
  assert.equal(uploadStatusAfterInsert(second.inserted), 'uploading')
  assert.deepEqual(placed, [])
  assert.deepEqual(second.hold.queued.map(item => item.assetId), ['asset-a', 'asset-b'])

  const stillLocked = flushHeldImages(second.hold, locked, () => {
    placed.push('too-early')
    return true
  })
  assert.deepEqual(placed, [])
  assert.equal(stillLocked.inserted.length, 0)
  assert.equal(stillLocked.hold.queued.length, 2)

  const unlocked = flushHeldImages(stillLocked.hold, open, dispatch)
  assert.deepEqual(placed, ['asset-a', 'asset-b'])
  assert.deepEqual(unlocked.inserted.map(item => item.assetId), ['asset-a', 'asset-b'])
  assert.deepEqual(unlocked.hold.queued, [])
  assert.equal(uploadStatusAfterInsert(true), 'done')
})

test('dispatch 被移动锁拒绝时不能当成已插入，其余图片也留在队列', () => {
  const placed: string[] = []
  let rejectA = true
  const dispatch = (item: UploadedImage) => {
    if (rejectA && item.assetId === 'asset-a') return false
    placed.push(item.assetId)
    return true
  }
  const tried = applyUploadedImage({ queued: [] }, imageA, open, dispatch)
  assert.equal(tried.inserted, false)
  assert.equal(uploadStatusAfterInsert(tried.inserted), 'uploading')
  assert.deepEqual(placed, [])
  assert.equal(tried.hold.queued.length, 1)

  const held = applyUploadedImage(tried.hold, imageB, locked, dispatch)
  const blocked = flushHeldImages(held.hold, open, dispatch)
  assert.deepEqual(placed, [])
  assert.deepEqual(blocked.hold.queued.map(item => item.assetId), ['asset-a', 'asset-b'])

  rejectA = false
  const done = flushHeldImages(blocked.hold, open, dispatch)
  assert.deepEqual(placed, ['asset-a', 'asset-b'])
  assert.deepEqual(done.hold.queued, [])
})

test('暂时没有 view 时入队，恢复后插入；只读不插入也不入队', () => {
  const placed: string[] = []
  const dispatch = (item: UploadedImage) => {
    placed.push(item.assetId)
    return true
  }
  const noView = applyUploadedImage({ queued: [] }, imageA, { readonly: false, hasView: false, moveLocked: false }, dispatch)
  assert.equal(noView.inserted, false)
  assert.deepEqual(placed, [])
  assert.equal(noView.hold.queued.length, 1)

  const readonlyFlush = flushHeldImages(noView.hold, { readonly: true, hasView: true, moveLocked: false }, dispatch)
  assert.deepEqual(placed, [])
  assert.equal(readonlyFlush.hold.queued.length, 1)

  const restored = flushHeldImages(readonlyFlush.hold, open, dispatch)
  assert.deepEqual(placed, ['asset-a'])
  assert.deepEqual(restored.hold.queued, [])

  const rejected = applyUploadedImage({ queued: [] }, imageB, { readonly: true, hasView: true, moveLocked: false }, dispatch)
  assert.equal(rejected.inserted, false)
  assert.deepEqual(rejected.hold.queued, [])
  assert.deepEqual(placed, ['asset-a'])
})

test('uploadsPending 或 moveLocked 时不能移动', () => {
  const ready = {
    readonly: false,
    moveLocked: false,
    uploadsPending: 0,
    topLevel: true,
    hasBlock: true,
    hasNeighbor: true,
  }
  assert.equal(canMoveOutlineBlock(ready), true)
  assert.equal(canMoveOutlineBlock({ ...ready, uploadsPending: 1 }), false)
  assert.equal(canMoveOutlineBlock({ ...ready, uploadsPending: 2 }), false)
  assert.equal(canMoveOutlineBlock({ ...ready, moveLocked: true }), false)
  assert.equal(moveBlockedByPendingUploads(1), '有图片上传未完成')
  assert.equal(moveBlockedByPendingUploads(2), '有图片上传未完成')
  assert.equal(moveBlockedByPendingUploads(0), null)
})
