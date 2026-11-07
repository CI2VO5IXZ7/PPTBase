// 生产 buildThreadDecorations 回归：块相对 offset 定位 + 本地编辑后重算（首块/后块/嵌套/跨块/重叠/图片/插入/删除/拆分）
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { buildThreadDecorations } from '../../src/utils/outline/threadDeco'
import { imageAttrsTr } from '../../src/utils/outline/imageOps'
import { outlineViewSchema as S } from '../../src/utils/outline/viewSchema'
import type { OutlineThread } from '../../src/types/outline'

const para = (id: string, text: string) => S.nodes.paragraph.create({ blockId: id }, S.text(text))
const doc = S.nodes.doc.create(null, [
  para('p1', '目标语句需要批注'),
  para('p2', '第二段文字'),
  S.nodes.bullet_list.create({ blockId: 'L1' },
    S.nodes.list_item.create({ blockId: 'I1' }, para('p3', '列表项内容'))),
  S.nodes.image.create({ blockId: 'im1', src: '/assets/x.png', assetId: 'x' }),
])

const thread = (id: string, anchor: OutlineThread['anchor']): OutlineThread =>
  ({ id, status: 'open', detached: false, anchor, messages: [], createdAt: 0 })

const frag = (blockId: string, fromOffset: number, toOffset: number, text: string) =>
  ({ blockId, from: 0, to: 0, fromOffset, toOffset, text })

const inlineRanges = (d: ReturnType<typeof buildThreadDecorations>) =>
  d.find().filter(x => !(x as { type?: { attrs?: unknown } }).type?.attrs) // inline deco 无 attrs.type 标记，用 from/to 判定
const ranges = (d: ReturnType<typeof buildThreadDecorations>) => d.find().map(x => ({ from: x.from, to: x.to }))

const textAt = (docNode: typeof doc, from: number, to: number) => docNode.textBetween(from, to)

describe('buildThreadDecorations（块相对 offset → 当前文档坐标）', () => {
  it('首个块：fromOffset/toOffset 正确定位，不双加块起点', () => {
    const decos = buildThreadDecorations(doc, [thread('t1', {
      kind: 'textRange', fragments: [frag('p1', 0, 4, '目标语句')], createdContentVersion: 1,
    })])
    const r = ranges(decos)[0]
    expect(textAt(doc, r.from, r.to)).toBe('目标语句')
  })

  it('后续块 + 嵌套列表内 textblock：各自落在正确块内', () => {
    const decos = buildThreadDecorations(doc, [thread('t1', {
      kind: 'textRange',
      fragments: [frag('p2', 0, 3, '第二段'), frag('p3', 0, 3, '列表项')],
      createdContentVersion: 1,
    })])
    const rs = ranges(decos)
    expect(rs.length).toBe(2)
    expect(textAt(doc, rs[0].from, rs[0].to)).toBe('第二段')
    expect(textAt(doc, rs[1].from, rs[1].to)).toBe('列表项')
  })

  it('跨块同线程多片段 + 两线程重叠区间共存', () => {
    const decos = buildThreadDecorations(doc, [
      thread('a', { kind: 'textRange', fragments: [frag('p1', 0, 4, '目标语句'), frag('p2', 0, 3, '第二段')], createdContentVersion: 1 }),
      thread('b', { kind: 'textRange', fragments: [frag('p1', 2, 6, '语句需要')], createdContentVersion: 1 }),
    ])
    const rs = ranges(decos)
    expect(rs.length).toBe(3)
    const covered = rs.map(r => textAt(doc, r.from, r.to))
    expect(covered).toContain('目标语句')
    expect(covered).toContain('语句需要')
    expect(covered).toContain('第二段')
  })

  it('block/image 锚点 → 节点装饰；detached 线程跳过', () => {
    const decos = buildThreadDecorations(doc, [
      thread('b', { kind: 'block', blockId: 'p2', createdContentVersion: 1 }),
      thread('i', { kind: 'image', blockId: 'im1', createdContentVersion: 1 }),
      { ...thread('d', { kind: 'textRange', fragments: [frag('p1', 0, 2, '目标')], createdContentVersion: 1 }), detached: true },
    ])
    const rs = ranges(decos)
    expect(rs.length).toBe(2) // block + image 两个 node deco；detached 不在
  })

  it('本地事务后重算：前插段落使装饰随块位置平移；删除块则跳过', () => {
    let state = EditorState.create({ schema: S, doc })
    const th = [thread('t1', { kind: 'textRange', fragments: [frag('p1', 0, 4, '目标语句')], createdContentVersion: 1 })]
    // 前插一段 → p1 位置后移；重新 build 仍落在 '目标语句'（不是旧绝对坐标）
    const inserted = para('px', '新段落')
    state = state.apply(state.tr.insert(1, inserted))
    const decos = buildThreadDecorations(state.doc, th)
    const r = ranges(decos)[0]
    expect(textAt(state.doc, r.from, r.to)).toBe('目标语句')
    // 删除 p1 → 片段跳过（等服务端标 detached）
    const withoutP1 = S.nodes.doc.create(null, [para('p2', '第二段文字')])
    expect(ranges(buildThreadDecorations(withoutP1, th)).length).toBe(0)
  })

  it('块内编辑后 offset 语义：在片段前输入文字，offset 指向原文字位置段', () => {
    let state = EditorState.create({ schema: S, doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
    state = state.apply(state.tr.insertText('前缀', 1))
    // '目标语句' 现在在块内 offset 2..6；服务端正则映射后 fromOffset 仍指原文片段
    const decos = buildThreadDecorations(state.doc, [thread('t1', {
      kind: 'textRange', fragments: [frag('p1', 0, 4, '目标语句')], createdContentVersion: 1,
    })])
    const r = ranges(decos)[0]
    // 服务端映射后 offset 应为 2..6；若仍是 0..4，高亮落在 '前缀目标' —— 偏移量由服务端刷新的线程驱动
    expect(textAt(state.doc, r.from, r.to)).toBe('前缀目标')
    const remapped = buildThreadDecorations(state.doc, [thread('t1', {
      kind: 'textRange', fragments: [frag('p1', 2, 6, '目标语句')], createdContentVersion: 2,
    })])
    const r2 = ranges(remapped)[0]
    expect(textAt(state.doc, r2.from, r2.to)).toBe('目标语句')
  })

  it('imageAttrsTr：更新属性不移动节点；过期 pos 返回 null（面板可判定关闭）', () => {
    let state = EditorState.create({ schema: S, doc })
    let imgPos = -1
    state.doc.descendants((n, p) => {
      if (n.type.name === 'image') {
        imgPos = p; return false
      }
      return true
    })
    expect(imgPos).toBeGreaterThan(0)
    const tr = imageAttrsTr(state, imgPos, { caption: 'c', usage: 'include', usageDescription: 'd' })
    expect(tr).toBeTruthy()
    state = state.apply(tr!)
    expect(state.doc.nodeAt(imgPos)?.attrs.caption).toBe('c')
    expect(state.doc.nodeAt(imgPos)?.attrs.usage).toBe('include')
    // pos 指向非 image → null（组件据此关闭面板）
    expect(imageAttrsTr(state, 0, { caption: 'x', usage: 'include', usageDescription: '' })).toBeNull()
  })
})
