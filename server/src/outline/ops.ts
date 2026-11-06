// 结构化区块操作 → ProseMirror transforms。
// Agent 的稳定 blockId 操作与网页 steps 走同一套 transform/锚点映射语义，
// 避免两套更新行为；任何一步失败整体不写入。

import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'

import type { OutlineOp } from '../../../src/types/outline'
import { blockIndex } from '../../../src/utils/outline/anchors'
import { outlineSchema } from '../../../src/utils/outline/schema'
import { AppError } from '../errors'
import { validateJsonAttrs } from './schema'

// 允许通过 updateBlockAttrs 修改的属性（blockId 不可变）
const ATTR_WHITELIST: Record<string, Set<string>> = {
  heading: new Set(['level']),
  ordered_list: new Set(['order']),
  image: new Set(['src', 'alt', 'caption', 'usage', 'usageDescription']),
}

function where(index: number): string {
  return `ops[${index}]`
}

function nodeFromJson(input: unknown, what: string): PMNode {
  try {
    validateJsonAttrs(input as never)
    return outlineSchema.nodeFromJSON(input)
  }
  catch (err) {
    if (err instanceof AppError) throw err
    throw AppError.validation(`${what}不是合法的大纲节点: ${(err as Error).message}`)
  }
}

function requireBlock(doc: PMNode, blockId: string, what: string) {
  const ref = blockIndex(doc).get(blockId)
  if (!ref) throw AppError.validation(`${what}: 找不到区块 blockId=${blockId}`)
  return ref
}

// 把内容类 op 依次编译进同一个 Transform；线程类 op 由 service 在锚点映射后处理
export function isContentOp(op: OutlineOp): boolean {
  return op.op !== 'addComment' && op.op !== 'replyComment' && op.op !== 'setThreadStatus'
}

export interface ContentOpsResult {
  tr: Transform
  // 本批次中被改写/删除的 blockId（删除含子树内全部 blockId）。
  // 同批次对这些区块新建批注会产生歧义，须拒绝
  modifiedIds: Set<string>
}

function collectSubtreeIds(node: PMNode, out: Set<string>): void {
  const id = node.attrs.blockId
  if (typeof id === 'string' && id) out.add(id)
  node.forEach(child => collectSubtreeIds(child, out))
}

export function applyContentOps(doc: PMNode, ops: OutlineOp[]): ContentOpsResult {
  const tr = new Transform(doc)
  const modifiedIds = new Set<string>()
  ops.forEach((op, i) => {
    if (!isContentOp(op)) return
    try {
      applyContentOp(tr, op, i, modifiedIds)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      throw AppError.validation(`ops[${i}]: ${(err as Error).message}`)
    }
  })
  return { tr, modifiedIds }
}

function applyContentOp(tr: Transform, op: OutlineOp, i: number, modifiedIds: Set<string>): void {
  const w = where(i)
  const doc = tr.doc

  switch (op.op) {
    case 'insertBlocks': {
      if (op.before && op.after) throw AppError.validation(`${w}: before 与 after 只能提供一个`)
      const nodes = op.blocks.map((b, j) => nodeFromJson(b, `${w}.blocks[${j}]`))
      let pos = doc.content.size
      if (op.before) pos = requireBlock(doc, op.before, w).pos
      else if (op.after) {
        const ref = requireBlock(doc, op.after, w)
        pos = ref.pos + ref.node.nodeSize
      }
      try {
        tr.insert(pos, nodes)
      }
      catch (err) {
        throw AppError.validation(`${w}: 无法在指定位置插入区块: ${(err as Error).message}`)
      }
      return
    }

    case 'replaceBlock': {
      const ref = requireBlock(doc, op.blockId, w)
      const node = nodeFromJson(op.block, `${w}.block`)
      modifiedIds.add(ref.blockId)
      try {
        tr.replace(ref.pos, ref.pos + ref.node.nodeSize, new Slice(Fragment.from(node), 0, 0))
      }
      catch (err) {
        throw AppError.validation(`${w}: 替换区块失败: ${(err as Error).message}`)
      }
      return
    }

    case 'updateBlockAttrs': {
      const ref = requireBlock(doc, op.blockId, w)
      const allowed = ATTR_WHITELIST[ref.node.type.name]
      if (!allowed) throw AppError.validation(`${w}: ${ref.node.type.name} 不支持更新属性`)
      const attrs = op.attrs ?? {}
      const keys = Object.keys(attrs)
      if (!keys.length) throw AppError.validation(`${w}: attrs 不能为空`)
      for (const key of keys) {
        if (!allowed.has(key)) throw AppError.validation(`${w}: 属性 ${key} 不允许修改`)
      }
      modifiedIds.add(ref.blockId)
      try {
        tr.setNodeMarkup(ref.pos, undefined, { ...ref.node.attrs, ...attrs })
      }
      catch (err) {
        throw AppError.validation(`${w}: 更新属性失败: ${(err as Error).message}`)
      }
      return
    }

    case 'deleteBlocks': {
      // 重复 id：第二次删除会落在位移后的错误内容上，拒绝
      if (new Set(op.blockIds).size !== op.blockIds.length) {
        throw AppError.validation(`${w}: blockIds 存在重复`)
      }
      const refs = op.blockIds.map(id => requireBlock(doc, id, w))
      // 祖先+后代同一批删除：目标互相嵌套，范围语义歧义，拒绝
      for (const outer of refs) {
        for (const inner of refs) {
          if (outer === inner) continue
          if (outer.pos < inner.pos && inner.pos + inner.node.nodeSize <= outer.pos + outer.node.nodeSize) {
            throw AppError.validation(`${w}: 不能同时删除区块及其子区块（${outer.blockId} 包含 ${inner.blockId}）`)
          }
        }
      }
      // 自后向前删除，避免位置位移影响后续删除
      const sorted = [...refs].sort((a, b) => b.pos - a.pos)
      for (const ref of sorted) {
        tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
        collectSubtreeIds(ref.node, modifiedIds)
      }
      if (!tr.doc.childCount) {
        throw AppError.validation(`${w}: 不能删除全部区块，大纲至少保留一个区块`)
      }
      return
    }

    case 'moveBlock': {
      if (op.before && op.after) throw AppError.validation(`${w}: before 与 after 只能提供一个`)
      if (op.before === op.blockId || op.after === op.blockId) {
        throw AppError.validation(`${w}: 目标位置不能是被移动区块自身`)
      }
      const ref = requireBlock(doc, op.blockId, w)
      // 先删除原区块，再在变换后的文档里解析目标锚点位置（自动处理位移）
      const moving = ref.node
      tr.delete(ref.pos, ref.pos + moving.nodeSize)
      let pos = tr.doc.content.size
      if (op.before) pos = requireBlock(tr.doc, op.before, w).pos
      else if (op.after) {
        const target = requireBlock(tr.doc, op.after, w)
        pos = target.pos + target.node.nodeSize
      }
      try {
        tr.insert(pos, moving)
      }
      catch (err) {
        throw AppError.validation(`${w}: 移动区块失败: ${(err as Error).message}`)
      }
      return
    }

    default:
      throw AppError.validation(`${w}: 未知操作 ${JSON.stringify((op as { op?: string }).op)}`)
  }
}
