// 前端选区适配器 vs 服务端真实 createAnchor（共享模块真实语义，不复制假实现）
import { describe, expect, it } from 'vitest'

import { NodeSelection, TextSelection } from 'prosemirror-state'
import { selectionToAnchorSpec } from '../../src/utils/outline/anchorSpec'
import { createAnchor } from '../../src/utils/outline/anchors'
import { outlineSchema } from '../../src/utils/outline/schema'

const para = (id: string, text: string) => outlineSchema.nodes.paragraph.create({ blockId: id }, outlineSchema.text(text))
const doc = outlineSchema.nodes.doc.create(null, [
  para('p1', '目标语句需要批注'),
  para('p2', '第二段文字'),
  outlineSchema.nodes.bullet_list.create({ blockId: 'L1' },
    outlineSchema.nodes.list_item.create({ blockId: 'I1' },
      para('p3', '列表项内容'))),
])

const sel = (from: number, to: number) => TextSelection.create(doc, from, to)

describe('selectionToAnchorSpec → createAnchor（真实链路）', () => {
  it('跨块 textRange：块相对偏移 + 每 textblock 一个片段', () => {
    const spec = selectionToAnchorSpec(doc, sel(3, doc.nodeSize - 3))
    expect(spec.kind).toBe('textRange')
    const frags = (spec as { fragments: { blockId: string, from: number, to: number }[] }).fragments
    expect(frags[0]).toEqual({ blockId: 'p1', from: 2, to: 8 }) // 块相对：sel.from3 - contentStart1
    expect(frags.length).toBe(3) // p1 + p2 + 列表项内 p3（容器不算）
    const anchor = createAnchor(doc, spec, 5)
    expect(anchor.kind).toBe('textRange')
    expect(anchor.fragments![0].text).toBe('语句需要批注')
  })

  it('折叠光标 → block 锚点；image 节点选区 → image 锚点', () => {
    const spec = selectionToAnchorSpec(doc, sel(1, 1))
    expect(spec).toEqual({ kind: 'block', blockId: 'p1' })
    const anchor = createAnchor(doc, spec, 1)
    expect(anchor.kind).toBe('block')
    expect(anchor.blockId).toBe('p1')
  })

  it('图片 NodeSelection → image 锚点（真实 NodeSelection 对象）', () => {
    const imgDoc = outlineSchema.nodes.doc.create(null, [
      para('pA', '前文'),
      outlineSchema.nodes.image.create({ blockId: 'img1', src: '/assets/x.png', assetId: 'x' }),
    ])
    const imgPos = para('pA', '前文').nodeSize // 文档内 pA 之后即为图片节点起始位置
    const ns = NodeSelection.create(imgDoc, imgPos)
    expect(ns.node?.type.name).toBe('image')
    const spec = selectionToAnchorSpec(imgDoc, ns)
    expect(spec).toEqual({ kind: 'image', blockId: 'img1' })
    const anchor = createAnchor(imgDoc, spec, 1)
    expect(anchor.kind).toBe('image')
    expect(anchor.blockId).toBe('img1')
  })

  it('选区完全在列表项文字内：fragment 指向 textblock p3 而非容器', () => {
    const pos3 = doc.nodeSize - 4 // p3 内部
    const spec = selectionToAnchorSpec(doc, sel(pos3 - 2, pos3))
    expect(spec.kind).toBe('textRange')
    const frags = (spec as { fragments: { blockId: string }[] }).fragments
    expect(frags.every(f => f.blockId === 'p3')).toBe(true)
  })
})
