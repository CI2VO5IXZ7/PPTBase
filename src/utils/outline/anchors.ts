// 大纲批注锚点：创建、随 transforms 映射、失效判定。
// 纯模型层，DOM 无关；映射只用 ProseMirror StepMap 语义，
// 失效宁可标记 detached 保留引用原文，也不按相似度重绑到别处。

import type { Node as PMNode } from 'prosemirror-model'
import type { Mapping } from 'prosemirror-transform'

import type {
  OutlineAnchor,
  OutlineAnchorSpec,
  OutlineRangeFragment,
  OutlineThread,
} from '../../types/outline'
import { OUTLINE_LIMITS } from './schema'

export interface BlockRef {
  blockId: string
  node: PMNode
  // 节点自身在文档中的位置（节点起始 token 前）
  pos: number
}

// 当前文档中 blockId → 区块引用。调用方应保证 blockId 已归一化（唯一且非空）
export function blockIndex(doc: PMNode): Map<string, BlockRef> {
  const index = new Map<string, BlockRef>()
  doc.descendants((node, pos) => {
    const id = node.attrs.blockId
    if (typeof id === 'string' && id && !index.has(id)) {
      index.set(id, { blockId: id, node, pos })
    }
    return true
  })
  return index
}

// textblock 的文本内容范围（不含自身边界 token）
export function blockContentRange(ref: BlockRef): { from: number, to: number } {
  return { from: ref.pos + 1, to: ref.pos + ref.node.nodeSize - 1 }
}

function excerpt(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

export function requireAnchorBlock(doc: PMNode, blockId: string): BlockRef {
  const ref = blockIndex(doc).get(blockId)
  if (!ref) throw new Error(`找不到区块 blockId=${blockId}`)
  return ref
}

// 由锚点描述生成存储锚点。textRange 的 from/to 是目标 textblock 文本内容内的偏移
export function createAnchor(
  doc: PMNode,
  spec: OutlineAnchorSpec,
  contentVersion: number,
): OutlineAnchor {
  const index = blockIndex(doc)

  if (spec.kind === 'document') {
    return { kind: 'document', createdContentVersion: contentVersion }
  }

  if (spec.kind === 'block' || spec.kind === 'image') {
    const ref = index.get(spec.blockId)
    if (!ref) throw new Error(`找不到区块 blockId=${spec.blockId}`)
    if (spec.kind === 'image' && ref.node.type.name !== 'image') {
      throw new Error(`blockId=${spec.blockId} 不是图片区块`)
    }
    const anchor: OutlineAnchor = {
      kind: spec.kind,
      blockId: spec.blockId,
      pos: ref.pos,
      createdContentVersion: contentVersion,
    }
    if (ref.node.isTextblock) {
      const { from, to } = blockContentRange(ref)
      const text = doc.textBetween(from, to, ' ', ' ')
      anchor.quote = { before: '', text: excerpt(text, OUTLINE_LIMITS.maxQuoteChars), after: '' }
    }
    else if (ref.node.type.name === 'image') {
      anchor.quote = {
        before: '',
        text: excerpt(String(ref.node.attrs.caption || ref.node.attrs.alt || ref.node.attrs.src || ''), OUTLINE_LIMITS.maxQuoteChars),
        after: '',
      }
    }
    return anchor
  }

  // textRange
  const fragments: OutlineRangeFragment[] = spec.fragments.map((frag, i) => {
    const ref = index.get(frag.blockId)
    if (!ref) throw new Error(`fragments[${i}]: 找不到区块 blockId=${frag.blockId}`)
    if (!ref.node.isTextblock) {
      throw new Error(`fragments[${i}]: blockId=${frag.blockId} 不是文本区块（请使用段落/标题等 blockId）`)
    }
    const { from: cFrom, to: cTo } = blockContentRange(ref)
    const size = cTo - cFrom
    if (!Number.isInteger(frag.from) || !Number.isInteger(frag.to)
      || frag.from < 0 || frag.to > size || frag.from >= frag.to) {
      throw new Error(`fragments[${i}]: 偏移越界（区块文本长度 ${size}）`)
    }
    const from = cFrom + frag.from
    const to = cFrom + frag.to
    return {
      blockId: frag.blockId,
      from,
      to,
      fromOffset: frag.from,
      toOffset: frag.to,
      text: doc.textBetween(from, to, ' ', ' '),
    }
  })

  // 引用原文：首片段向前、末片段向后各取 maxContextChars，均不跨出所在区块
  const firstRef = index.get(fragments[0].blockId)!
  const lastRef = index.get(fragments[fragments.length - 1].blockId)!
  const ctx = OUTLINE_LIMITS.maxContextChars
  const firstRange = blockContentRange(firstRef)
  const lastRange = blockContentRange(lastRef)
  const before = doc.textBetween(Math.max(firstRange.from, fragments[0].from - ctx), fragments[0].from, ' ', ' ')
  const after = doc.textBetween(fragments[fragments.length - 1].to, Math.min(lastRange.to, fragments[fragments.length - 1].to + ctx), ' ', ' ')
  const text = fragments.map(f => f.text).join('\n')

  return {
    kind: 'textRange',
    fragments,
    quote: { before, text: excerpt(text, OUTLINE_LIMITS.maxQuoteChars), after },
    createdContentVersion: contentVersion,
  }
}

// 把线程锚点映射过一次整体 transform（mapping 为 tr.mapping）。
// newDoc 为变换后的文档。返回是否有线程状态被改变（detached 变化或位置更新）。
export function mapThreads(threads: OutlineThread[], mapping: Mapping, newDoc: PMNode): boolean {
  const index = blockIndex(newDoc)
  let changed = false

  for (const thread of threads) {
    const anchor = thread.anchor
    if (anchor.kind === 'document') continue

    if (anchor.kind === 'block' || anchor.kind === 'image') {
      if (thread.detached) continue
      const ref = anchor.blockId ? index.get(anchor.blockId) : undefined
      if (!ref) {
        thread.detached = true
        changed = true
      }
      else if (anchor.pos !== ref.pos) {
        anchor.pos = ref.pos
        changed = true
      }
      continue
    }

    if (anchor.kind !== 'textRange' || !anchor.fragments) continue
    if (thread.detached) continue

    let live = 0
    for (const frag of anchor.fragments) {
      if (frag.detached) continue
      if (mapFragment(frag, mapping, index, newDoc)) live++
      else {
        frag.detached = true
        changed = true
      }
    }
    if (live === 0 && !thread.detached) {
      thread.detached = true
      changed = true
    }
  }
  return changed
}

// 单个片段：先用 StepMap 映射位置，并要求映射后仍在同一 blockId 区块内容内；
// 失败时在原 blockId 内按存储偏移+引用原文做有限恢复（覆盖区块整体移动场景）。
function mapFragment(
  frag: OutlineRangeFragment,
  mapping: Mapping,
  index: Map<string, BlockRef>,
  newDoc: PMNode,
): boolean {
  const fRes = mapping.mapResult(frag.from, 1)
  const tRes = mapping.mapResult(frag.to, -1)
  const ref = index.get(frag.blockId)

  if (!fRes.deleted && !tRes.deleted && fRes.pos < tRes.pos && ref && ref.node.isTextblock) {
    const { from: cFrom, to: cTo } = blockContentRange(ref)
    if (fRes.pos >= cFrom && tRes.pos <= cTo) {
      frag.from = fRes.pos
      frag.to = tRes.pos
      frag.fromOffset = frag.from - cFrom
      frag.toOffset = frag.to - cFrom
      frag.text = newDoc.textBetween(frag.from, frag.to, ' ', ' ')
      return true
    }
  }

  // 受限恢复：仅当同一 blockId 仍存在、原文在当前存储偏移处完整保留时重挂。
  // 不搜索其他区块/相似文本，确保不会把批注绑到错误原文。
  if (ref && ref.node.isTextblock) {
    const { from: cFrom, to: cTo } = blockContentRange(ref)
    const from = cFrom + frag.fromOffset
    const to = cFrom + frag.toOffset
    if (to > from && to <= cTo && newDoc.textBetween(from, to, ' ', ' ') === frag.text) {
      frag.from = from
      frag.to = to
      return true
    }
  }
  return false
}
