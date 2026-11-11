import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import { outlineSchema as S } from '../outline/schema.ts'
import { textRangeFragmentTexts } from '../outline/anchors.ts'
import { selectionToAnchorSpec } from '../outline/anchorSpec.ts'
import { blockAtSelection, selectionForBlock, selectionKeepingBlock } from '../outline/selectionMeta.ts'
import { textsEqual, unchangedLinkRange, conflictRefreshAllowed, navigationNeedsLeave, commentRevisionCurrent, reviewedVersionCurrent, sameDraftBody } from '../outline/editorGuards.ts'
import { normalizeHttpsHref } from '../outline/linkHref.ts'

const text = (value: string) => S.text(value)
const para = (id: string, value: string) => S.nodes.paragraph.create({ blockId: id }, value ? text(value) : null)
const image = (id: string) => S.nodes.image.create({ blockId: id, src: '/assets/a.png', alt: id })
const hr = (id: string) => S.nodes.horizontal_rule.create({ blockId: id })

test('图片节点选区不被前一段落抢走', () => {
  const doc = S.nodes.doc.create(null, [para('p1', '前文'), image('img1')])
  const img = blockPos(doc, 'img1')
  const sel = NodeSelection.create(doc, img)
  const hit = blockAtSelection(doc, sel)
  assert.equal(hit.blockId, 'img1')
  assert.equal(hit.topLevel, true)
})

test('右开边界：光标在段末仍属于该段', () => {
  const doc = S.nodes.doc.create(null, [para('p1', 'AB'), para('p2', 'CD')])
  const p1 = blockPos(doc, 'p1')
  const end = p1 + doc.nodeAt(p1)!.nodeSize - 1
  const hit = blockAtSelection(doc, TextSelection.create(doc, end))
  assert.equal(hit.blockId, 'p1')
  assert.equal(hit.topLevel, true)
})

test('嵌套列表光标命中最近的带 blockId 祖先，不取外层列表', () => {
  const inner = para('p2', '项')
  const item = S.nodes.list_item.create({ blockId: 'li1' }, inner)
  const list = S.nodes.bullet_list.create({ blockId: 'list1' }, item)
  const doc = S.nodes.doc.create(null, [para('p1', '标题'), list])
  const p2 = blockPos(doc, 'p2')
  const hit = blockAtSelection(doc, TextSelection.create(doc, p2 + 1))
  assert.equal(hit.blockId, 'p2')
  assert.equal(hit.topLevel, false)
  const listSel = blockAtSelection(doc, NodeSelection.create(doc, blockPos(doc, 'list1')))
  assert.equal(listSel.blockId, 'list1')
  assert.equal(listSel.topLevel, true)
})

test('内层没有 blockId 时继续向外找到最近的 list_item', () => {
  const inner = S.nodes.paragraph.create({ blockId: '' }, text('项'))
  const item = S.nodes.list_item.create({ blockId: 'li1' }, inner)
  const list = S.nodes.bullet_list.create({ blockId: 'list1' }, item)
  const doc = S.nodes.doc.create(null, [list])
  let pos = -1
  doc.descendants((node, nodePos) => {
    if (node.isText && node.text === '项') pos = nodePos
  })
  const hit = blockAtSelection(doc, TextSelection.create(doc, pos))
  assert.equal(hit.blockId, 'li1')
  assert.equal(hit.topLevel, false)
})

test('滚动到图片和分隔线用节点选区，列表落到内部文本', () => {
  const item = S.nodes.list_item.create({ blockId: 'li1' }, para('p2', '项'))
  const doc = S.nodes.doc.create(null, [
    para('p1', '前文'),
    image('img1'),
    hr('hr1'),
    S.nodes.bullet_list.create({ blockId: 'list1' }, item),
    S.nodes.blockquote.create({ blockId: 'q1' }, para('p3', '引用')),
  ])
  const imgSel = selectionForBlock(doc, 'img1')
  assert.ok(imgSel instanceof NodeSelection)
  assert.equal((imgSel as NodeSelection).node.attrs.blockId, 'img1')
  const hrSel = selectionForBlock(doc, 'hr1')
  assert.ok(hrSel instanceof NodeSelection)
  assert.equal((hrSel as NodeSelection).node.attrs.blockId, 'hr1')
  for (const id of ['list1', 'q1', 'p1']) {
    const sel = selectionForBlock(doc, id)
    assert.ok(sel instanceof TextSelection)
    assert.equal(sel!.$from.parent.inlineContent, true)
  }
  const oldImageCursor = TextSelection.create(doc, blockPos(doc, 'img1') + 1)
  assert.equal(oldImageCursor.$from.parent.inlineContent, false)
})

test('同一文本块前插入文字后，旧 textRange 片段原文对不上', () => {
  const before = S.nodes.doc.create(null, [para('p1', 'ABCDEF')])
  const from = blockPos(before, 'p1') + 1
  const spec = selectionToAnchorSpec(before, TextSelection.create(before, from, from + 3))
  const expected = textRangeFragmentTexts(before, spec)
  assert.deepEqual(expected, ['ABC'])
  const shifted = S.nodes.doc.create(null, [para('p1', 'XXABCDEF')])
  assert.equal(textsEqual(expected, textRangeFragmentTexts(shifted, spec)), false)
  const otherBlock = S.nodes.doc.create(null, [para('p0', '前面一段'), para('p1', 'ABCDEF')])
  assert.equal(textsEqual(expected, textRangeFragmentTexts(otherBlock, spec)), true)
})

test('远端替换后按 blockId 放回原区块，节点选区保持节点选区', () => {
  const doc = S.nodes.doc.create(null, [para('A', '甲'), para('B', '乙'), image('img')])
  const textSel = selectionKeepingBlock(doc, 'B', false)
  assert.ok(textSel instanceof TextSelection)
  assert.equal(blockAtSelection(doc, textSel!).blockId, 'B')
  const nodeSel = selectionKeepingBlock(doc, 'img', true)
  assert.ok(nodeSel instanceof NodeSelection)
  assert.equal((nodeSel as NodeSelection).node.attrs.blockId, 'img')
  assert.equal(selectionKeepingBlock(doc, 'missing', false), null)
  const before = S.nodes.doc.create(null, [para('A', '甲'), para('B', '乙'), para('C', '丙')])
  const moved = S.nodes.doc.create(null, [para('A', '甲'), para('C', '丙'), para('B', '乙')])
  const kept = selectionKeepingBlock(moved, 'B', false)
  assert.equal(blockAtSelection(moved, kept!).blockId, 'B')
  assert.notEqual(blockAtSelection(moved, TextSelection.atStart(moved)).blockId, 'B')
  assert.equal(blockAtSelection(before, TextSelection.create(before, blockPos(before, 'B') + 1)).blockId, 'B')
})

test('https 前缀不区分大小写；http 仍拒绝；复制后的草稿必须仍是同一份', () => {
  const https = normalizeHttpsHref('HTTPS://example.com/path')
  assert.equal(https.ok, true)
  if (https.ok) {
    assert.equal(https.href, 'HTTPS://example.com/path')
    assert.equal(new URL(https.href).hostname, 'example.com')
  }
  assert.deepEqual(normalizeHttpsHref('Http://example.com'), { ok: false, error: '请使用 https:// 链接' })
  assert.equal(normalizeHttpsHref('example.com/a').ok && normalizeHttpsHref('example.com/a').href, 'https://example.com/a')
  assert.equal(textsEqual(['ABC'], ['ABC']), true)
  assert.equal(commentRevisionCurrent(1, 1), true)
  assert.equal(commentRevisionCurrent(1, 2), false)
  assert.equal(reviewedVersionCurrent(10, 10), true)
  assert.equal(reviewedVersionCurrent(10, 11), false)
  const body = { content: { type: 'doc' }, steps: [{ a: 1 }] }
  assert.equal(sameDraftBody(body, { content: { type: 'doc' }, steps: [{ a: 1 }] }), true)
  assert.equal(sameDraftBody(body, { content: { type: 'doc', changed: true }, steps: [{ a: 1 }] }), false)
})

test('链接选区只在正文修订号未变时沿用；冲突刷新在无草稿时放行；导航看 drain 之后的状态', () => {
  assert.deepEqual(unchangedLinkRange({ from: 1, to: 4, docRev: 2 }, 2), { from: 1, to: 4 })
  assert.equal(unchangedLinkRange({ from: 1, to: 4, docRev: 2 }, 3), null)
  assert.equal(conflictRefreshAllowed(false, true), false)
  assert.equal(conflictRefreshAllowed(true, true), true)
  assert.equal(conflictRefreshAllowed(false, false), true)
  assert.equal(navigationNeedsLeave(true, false, 'saved'), false)
  assert.equal(navigationNeedsLeave(true, false, 'saving'), false)
  assert.equal(navigationNeedsLeave(true, true, 'saved'), true)
  assert.equal(navigationNeedsLeave(false, false, 'saved'), true)
  assert.equal(navigationNeedsLeave(true, false, 'conflict'), true)
})

function blockPos(doc: import('prosemirror-model').Node, id: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (node.attrs.blockId === id) found = pos
  })
  assert.ok(found >= 0, id)
  return found
}
