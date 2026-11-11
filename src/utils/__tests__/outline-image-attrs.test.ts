import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'

import { imageAttrsTr, imageBlockPos, remapImageSel } from '../outline/imageOps.ts'
import { outlineSchema as S } from '../outline/schema.ts'

const para = (id: string, value: string) => S.nodes.paragraph.create({ blockId: id }, S.text(value))
const image = (id: string, caption = '') => S.nodes.image.create({
  blockId: id,
  src: '/assets/a.png',
  alt: id,
  caption,
  usage: 'reference',
  usageDescription: '',
})

const patch = { caption: 'new', usage: 'include', usageDescription: 'for-agent' }

function blockPos(doc: PMNode, id: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (node.attrs.blockId === id) found = pos
  })
  assert.ok(found >= 0, id)
  return found
}

test('旧 pos 已是另一张图时不得写入', () => {
  const before = S.nodes.doc.create(null, [image('A', 'cap-a'), image('B', 'cap-b')])
  const stalePos = blockPos(before, 'A')
  const swapped = S.nodes.doc.create(null, [image('B', 'cap-b'), image('A', 'cap-a')])
  assert.equal(swapped.nodeAt(stalePos)?.attrs.blockId, 'B')
  assert.notEqual(imageBlockPos(swapped, 'A'), stalePos)

  const state = EditorState.create({ schema: S, doc: swapped })
  const tr = imageAttrsTr(state, 'A', patch)
  assert.ok(tr)
  const next = state.apply(tr)
  const posA = imageBlockPos(next.doc, 'A')
  const posB = imageBlockPos(next.doc, 'B')
  assert.ok(posA != null && posB != null)
  assert.equal(posB, stalePos)
  assert.equal(next.doc.nodeAt(posA)?.attrs.blockId, 'A')
  assert.equal(next.doc.nodeAt(posA)?.attrs.caption, 'new')
  assert.equal(next.doc.nodeAt(posA)?.attrs.usage, 'include')
  assert.equal(next.doc.nodeAt(posA)?.attrs.usageDescription, 'for-agent')
  assert.equal(next.doc.nodeAt(posB)?.attrs.blockId, 'B')
  assert.equal(next.doc.nodeAt(posB)?.attrs.caption, 'cap-b')
  assert.equal(next.doc.nodeAt(posB)?.attrs.usage, 'reference')
})

test('按 blockId 重映射到新 pos 后可以更新正确的图', () => {
  const before = S.nodes.doc.create(null, [image('A', 'cap-a'), image('B', 'cap-b')])
  const stale = {
    pos: blockPos(before, 'A'),
    blockId: 'A',
    caption: 'cap-a',
    usage: 'reference',
    usageDescription: '',
  }
  const moved = S.nodes.doc.create(null, [para('p0', '前面插入'), image('A', 'cap-a'), image('B', 'cap-b')])
  const remapped = remapImageSel(moved, stale)
  assert.ok(remapped)
  assert.equal(remapped.blockId, 'A')
  assert.notEqual(remapped.pos, stale.pos)
  assert.equal(moved.nodeAt(remapped.pos)?.attrs.blockId, 'A')
  assert.notEqual(moved.nodeAt(stale.pos)?.attrs.blockId, 'A')

  const state = EditorState.create({ schema: S, doc: moved })
  const tr = imageAttrsTr(state, remapped.blockId, patch)
  assert.ok(tr)
  const next = state.apply(tr)
  assert.equal(next.doc.nodeAt(remapped.pos)?.attrs.blockId, 'A')
  assert.equal(next.doc.nodeAt(remapped.pos)?.attrs.caption, 'new')
  assert.equal(next.doc.nodeAt(imageBlockPos(next.doc, 'B')!)?.attrs.caption, 'cap-b')
})

test('目标 blockId 消失时返回 null', () => {
  const doc = S.nodes.doc.create(null, [image('A', 'cap-a'), image('B', 'cap-b')])
  const open = { pos: blockPos(doc, 'A'), blockId: 'A' }
  const state = EditorState.create({ schema: S, doc })
  assert.equal(imageAttrsTr(state, 'gone', patch), null)
  assert.equal(imageBlockPos(doc, 'gone'), null)
  assert.equal(remapImageSel(doc, { ...open, blockId: 'gone' }), null)

  const replaced = S.nodes.doc.create(null, [para('A', '不再是图片'), image('B', 'cap-b')])
  const state2 = EditorState.create({ schema: S, doc: replaced })
  assert.equal(imageBlockPos(replaced, 'A'), null)
  assert.equal(imageAttrsTr(state2, 'A', patch), null)
  assert.equal(remapImageSel(replaced, open), null)
  assert.equal(replaced.nodeAt(imageBlockPos(replaced, 'B')!)?.attrs.caption, 'cap-b')
})
