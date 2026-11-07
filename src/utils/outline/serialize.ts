// 由大纲 ProseMirror JSON 派生：Agent 可读文本（带区块 ID）、
// 图片素材清单、版本间变更摘要。纯函数，DOM 无关；
// 可读文本仅由 JSON 生成，不会反向作为 HTML 注入。

import type { Node as PMNode } from 'prosemirror-model'

import type { OutlineAssetRef } from '../../types/outline'
import { hasBlockId } from './schema'

export interface OutlineBlockInfo {
  blockId: string
  pos: number
  depth: number
  type: string
  text: string
}

const ASSET_SRC = /^\/assets\/([A-Za-z0-9_-]+)\.(png|jpe?g|gif|webp)$/i

export function assetIdFromSrc(src: string): string | undefined {
  const m = ASSET_SRC.exec(src)
  return m ? m[1] : undefined
}

function nodeText(node: PMNode): string {
  let text = ''
  node.descendants(child => {
    if (child.isText) text += child.text
    else if (child.type.name === 'hard_break') text += '\n'
    return !child.isText
  })
  return text
}

// 区块自身行内文本：textblock 取全部；list_item 只取首个段落（嵌套列表单独成行）
function ownText(node: PMNode): string {
  if (node.isTextblock) return nodeText(node)
  if (node.type.name === 'list_item' && node.childCount && node.child(0).isTextblock) {
    return nodeText(node.child(0))
  }
  return ''
}

// 文档顺序的可读区块清单（含嵌套），每个可定位区块一行
export function blockList(doc: PMNode): OutlineBlockInfo[] {
  const blocks: OutlineBlockInfo[] = []
  doc.descendants((node, pos) => {
    if (node.attrs.blockId) {
      blocks.push({
        blockId: String(node.attrs.blockId),
        pos,
        depth: doc.resolve(pos).depth,
        type: node.type.name,
        text: ownText(node),
      })
    }
    return true
  })
  return blocks
}

// Agent 可读形式：每行「[blockId] 文本」，列表项/标题/图片附结构提示
export function readableText(doc: PMNode): string {
  const lines: string[] = []
  doc.descendants((node, pos) => {
    if (!node.attrs.blockId) return true
    const depth = doc.resolve(pos).depth
    const indent = '  '.repeat(depth)
    const id = `[${node.attrs.blockId}]`
    switch (node.type.name) {
      case 'heading':
        lines.push(`${indent}${'#'.repeat(node.attrs.level)} ${id} ${nodeText(node)}`)
        break
      case 'paragraph':
        lines.push(`${indent}${id} ${nodeText(node)}`)
        break
      case 'list_item':
        lines.push(`${indent}- ${id} ${ownText(node)}`)
        break
      case 'blockquote':
        lines.push(`${indent}> ${id}`)
        break
      case 'image': {
        const a = node.attrs
        lines.push(`${indent}${id} ![image](${a.src}) caption="${a.caption}" usage=${a.usage}${a.usageDescription ? ` "${a.usageDescription}"` : ''}`)
        break
      }
      case 'horizontal_rule':
        lines.push(`${indent}${id} ---`)
        break
      default:
        lines.push(`${indent}${id} <${node.type.name}>`)
    }
    return true
  })
  return lines.join('\n')
}

// 图片素材清单：区块、地址、用途、说明；/assets/ 引用解析出 assetId
export function assetManifest(doc: PMNode): OutlineAssetRef[] {
  const refs: OutlineAssetRef[] = []
  doc.descendants(node => {
    if (node.type.name !== 'image') return true
    const a = node.attrs
    const src = String(a.src ?? '')
    refs.push({
      blockId: String(a.blockId ?? ''),
      src,
      assetId: assetIdFromSrc(src),
      caption: String(a.caption ?? ''),
      usage: a.usage === 'include' ? 'include' : 'reference',
      usageDescription: String(a.usageDescription ?? ''),
      external: /^https?:\/\//i.test(src),
    })
    return false
  })
  return refs
}

function topLevelIds(doc: PMNode): string[] {
  const ids: string[] = []
  doc.forEach(node => {
    if (hasBlockId(node)) ids.push(String(node.attrs.blockId))
  })
  return ids
}

function allBlockTextMap(doc: PMNode): Map<string, string> {
  const map = new Map<string, string>()
  doc.descendants(node => {
    if (node.attrs.blockId) map.set(String(node.attrs.blockId), `${node.type.name}:${nodeText(node)}`)
    return true
  })
  return map
}

// 两个正文版本之间的变更摘要（写入修订，给历史/通知用）
export function changeSummary(prev: PMNode, next: PMNode): string[] {
  const prevMap = allBlockTextMap(prev)
  const nextMap = allBlockTextMap(next)
  let added = 0
  let removed = 0
  let updated = 0
  for (const [id, sig] of nextMap) {
    if (!prevMap.has(id)) added++
    else if (prevMap.get(id) !== sig) updated++
  }
  for (const id of prevMap.keys()) if (!nextMap.has(id)) removed++

  const prevTop = topLevelIds(prev)
  const nextTopKept = topLevelIds(next).filter(id => prevMap.has(id))
  const prevTopKept = prevTop.filter(id => nextTopKept.includes(id))
  const moved = prevTopKept.length === nextTopKept.length && prevTopKept.length > 0
    && prevTopKept.some((id, i) => id !== nextTopKept[i])

  const out: string[] = []
  if (added) out.push(`新增 ${added} 个区块`)
  if (updated) out.push(`修改 ${updated} 个区块`)
  if (removed) out.push(`删除 ${removed} 个区块`)
  if (moved) out.push('调整区块顺序')
  return out.length ? out : ['正文微调']
}
