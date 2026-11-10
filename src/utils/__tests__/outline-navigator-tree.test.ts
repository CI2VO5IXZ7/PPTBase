import test from 'node:test'
import assert from 'node:assert/strict'
import { navigatorTree, topLevelBlockIds } from '../outline/navigatorTree.ts'

const sample = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { blockId: 'h1', level: 1 }, content: [{ type: 'text', text: '引言' }] },
    { type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: '正文' }] },
    {
      type: 'bullet_list',
      attrs: { blockId: 'list1' },
      content: [
        { type: 'list_item', attrs: { blockId: 'li1' }, content: [{ type: 'paragraph', attrs: { blockId: 'p2' }, content: [{ type: 'text', text: '项' }] }] },
      ],
    },
  ],
}

test('navigatorTree 产出带标签的顶层与子项', () => {
  const tree = navigatorTree(sample)
  assert.ok(tree.some(n => n.blockId === 'h1' && n.label.includes('引言')))
  assert.ok(tree.some(n => n.blockId === 'list1'))
})

test('topLevelBlockIds 仅 doc 直接子级', () => {
  const ids = topLevelBlockIds(sample)
  assert.deepEqual(ids, ['h1', 'p1', 'list1'])
})
