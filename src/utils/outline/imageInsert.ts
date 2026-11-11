// 上传成功后的插图与移动门闩。
// 移动锁或暂时没有 view 时先保住已拿到的 asset；真正插入成功后才算完成。
// 只读期间不插入，也不把这次上传放进待插队列。

export interface UploadedImage {
  uploadId: string
  src: string
  name: string
  assetId: string
}

export interface InsertGate {
  readonly: boolean
  hasView: boolean
  moveLocked: boolean
}

export interface ImageHold {
  queued: UploadedImage[]
}

export function canDispatchImage(gate: InsertGate): boolean {
  return !gate.readonly && gate.hasView && !gate.moveLocked
}

/** 插入成功才是 done。失败或入队时保持 uploading，避免 uploadsPending 提前归零。 */
export function uploadStatusAfterInsert(inserted: boolean): 'done' | 'uploading' {
  return inserted ? 'done' : 'uploading'
}

function queueWithoutUpload(queue: readonly UploadedImage[], uploadId: string): UploadedImage[] {
  if (!uploadId) return [...queue]
  return queue.filter(item => item.uploadId !== uploadId)
}

export function acceptUploadedImage(
  hold: ImageHold,
  image: UploadedImage,
  gate: InsertGate,
): { hold: ImageHold, insertNow: UploadedImage | null } {
  if (gate.readonly) return { hold, insertNow: null }
  const queued = queueWithoutUpload(hold.queued, image.uploadId)
  if (!canDispatchImage(gate)) return { hold: { queued: [...queued, image] }, insertNow: null }
  return { hold: { queued }, insertNow: image }
}

/** dispatch 被移动锁丢掉时不能当成已插入，放回队列。 */
export function requeueRejectedInsert(hold: ImageHold, image: UploadedImage): ImageHold {
  const queued = queueWithoutUpload(hold.queued, image.uploadId)
  return { queued: [...queued, image] }
}

export function imagesReadyToInsert(hold: ImageHold, gate: InsertGate): { hold: ImageHold, ready: UploadedImage[] } {
  if (!canDispatchImage(gate)) return { hold, ready: [] }
  return { hold: { queued: [] }, ready: [...hold.queued] }
}

function dispatchSafely(dispatch: (image: UploadedImage) => boolean, image: UploadedImage): boolean {
  try {
    return dispatch(image) === true
  }
  catch {
    return false
  }
}

export function applyUploadedImage(
  hold: ImageHold,
  image: UploadedImage,
  gate: InsertGate,
  dispatch: (image: UploadedImage) => boolean,
): { hold: ImageHold, inserted: boolean } {
  const decision = acceptUploadedImage(hold, image, gate)
  if (!decision.insertNow) return { hold: decision.hold, inserted: false }
  if (dispatchSafely(dispatch, decision.insertNow)) return { hold: decision.hold, inserted: true }
  return { hold: requeueRejectedInsert(decision.hold, decision.insertNow), inserted: false }
}

export function flushHeldImages(
  hold: ImageHold,
  gate: InsertGate,
  dispatch: (image: UploadedImage) => boolean,
): { hold: ImageHold, inserted: UploadedImage[] } {
  const next = imagesReadyToInsert(hold, gate)
  const inserted: UploadedImage[] = []
  let rejected: ImageHold = { queued: [] }
  let blocked = false
  for (const image of next.ready) {
    if (blocked || !dispatchSafely(dispatch, image)) {
      rejected = requeueRejectedInsert(rejected, image)
      blocked = true
      continue
    }
    inserted.push(image)
  }
  let queued = next.hold
  for (const image of rejected.queued) queued = requeueRejectedInsert(queued, image)
  return { hold: queued, inserted }
}

export function canMoveOutlineBlock(input: {
  readonly: boolean
  moveLocked: boolean
  uploadsPending: number
  topLevel: boolean
  hasBlock: boolean
  hasNeighbor: boolean
}): boolean {
  if (input.readonly || input.moveLocked || input.uploadsPending > 0) return false
  return input.topLevel && input.hasBlock && input.hasNeighbor
}

export function moveBlockedByPendingUploads(uploadsPending: number): string | null {
  if (uploadsPending > 0) return '有图片上传未完成'
  return null
}
