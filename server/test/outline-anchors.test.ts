// 大纲批注锚点的纯模型测试：同一共享 schema/transform 下的
// 位置映射、失效判定与安全恢复（不启动服务，不依赖 DOM）。
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'

import type { OutlineAnchorSpec, OutlineThread } from '../../src/types/outline'
import { blockIndex, createAnchor, mapThreads } from '../../src/utils/outline/anchors'
import { normalizeBlockIdsJson, outlineSchema } from '../../src/utils/outline/schema'
import { applyContentOps } from '../src/outline/ops'

let seq = 0
const genId = () => `n${(++seq).toString(36)}`

function docNode(json: unknown): PMNode {
  const cloned = JSON.parse(JSON.stringify(json))
  normalizeBlockIdsJson(cloned, genId)
  return outlineSchema.nodeFromJSON(cloned)
}

function para(id: string, text: string) {
  return { type: 'paragraph', attrs: { blockId: id }, content: [{ type: 'text', text }] }
}

function threadWith(doc: PMNode, spec: OutlineAnchorSpec): OutlineThread {
  return {
    id: 't1',
    status: 'open',
    detached: false,
    anchor: createAnchor(doc, spec, 1),
    messages: [{ id: 'm1', author: 'user', content: '看看这里', createdAt: 1 }],
    createdAt: 1,
  }
}

// 应用一次 transform（JSON 归一化）后映射线程锚点
function applyAndMap(json: unknown, threads: OutlineThread[], edit: (tr: Transform) => void): { doc: PMNode, threads: OutlineThread[] } {
  const doc = docNode(json)
  const tr = new Transform(doc)
  edit(tr)
  const outJson = tr.doc.toJSON()
  normalizeBlockIdsJson(outJson, genId)
  const newDoc = outlineSchema.nodeFromJSON(outJson)
  const next = JSON.parse(JSON.stringify(threads)) as OutlineThread[]
  mapThreads(next, tr.mapping, newDoc)
  return { doc: newDoc, threads: next }
}

function rangeThread(doc: PMNode, blockId: string, from: number, to: number): OutlineThread {
  return threadWith(doc, { kind: 'textRange', fragments: [{ blockId, from, to }] })
}

describe('大纲锚点映射', () => {
  it('在选区前插入文字：范围后移且原文保留', () => {
    const json = { type: 'doc', content: [para('b1', 'hello world')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 6, 11) // "world"
    const { threads } = applyAndMap(json, [t], tr => tr.insert(1, outlineSchema.text('>> ')))
    const frag = threads[0].anchor.fragments![0]
    expect(threads[0].detached).toBe(false)
    expect(frag.text).toBe('world')
    expect(frag.fromOffset).toBe(9)
  })

  it('在选区内插入文字：范围扩展，引用文本更新', () => {
    const json = { type: 'doc', content: [para('b1', 'abcd')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 1, 3) // "bc"
    // doc 位置 3 = 区块内容偏移 2，插在 "b|c" 之间
    const { threads } = applyAndMap(json, [t], tr => tr.insert(3, outlineSchema.text('XY')))
    const frag = threads[0].anchor.fragments![0]
    expect(threads[0].detached).toBe(false)
    expect(frag.text).toBe('bXYc')
  })

  it('删除选区内部分文字：范围收缩', () => {
    const json = { type: 'doc', content: [para('b1', 'abcdef')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 0, 6)
    const { threads } = applyAndMap(json, [t], tr => tr.delete(3, 5)) // 删除 "cd"
    const frag = threads[0].anchor.fragments![0]
    expect(threads[0].detached).toBe(false)
    expect(frag.text).toBe('abef')
    expect(frag.toOffset).toBe(4)
  })

  it('选区原文被整体删除：标记 detached 且保留引用原文', () => {
    const json = { type: 'doc', content: [para('b1', 'abcdef')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 1, 4)
    t.anchor.quote = { before: 'a', text: 'bcd', after: 'ef' }
    const { threads } = applyAndMap(json, [t], tr => tr.delete(2, 5))
    expect(threads[0].detached).toBe(true)
    expect(threads[0].anchor.quote?.text).toBe('bcd')
    expect(threads[0].messages[0].content).toBe('看看这里')
  })

  it('选区所在区块被删除：detached，不做相似度重绑', () => {
    const json = { type: 'doc', content: [para('b1', 'same text'), para('b2', 'same text')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b2', 0, 4)
    const { doc: newDoc, threads } = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('b2')!
      tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
    })
    expect(threads[0].detached).toBe(true)
    // 另一个同文区块仍在，但批注不会绑过去
    expect(blockIndex(newDoc).has('b1')).toBe(true)
  })

  it('区块内拆分片段：跨块后范围失效（保守 detached）', () => {
    const json = { type: 'doc', content: [para('b1', 'aabb')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 0, 4)
    const { threads } = applyAndMap(json, [t], tr => tr.split(3)) // 在 "aa|bb" 中间拆段
    expect(threads[0].detached).toBe(true)
  })

  it('moveBlock 整体移动：textRange 锚点按同一 blockId 安全重挂', () => {
    const json = { type: 'doc', content: [para('b1', 'first'), para('b2', 'anchor me'), para('b3', 'last')] }
    const doc = docNode(json)
    const t = rangeThread(doc, 'b2', 0, 6)
    const { doc: newDoc, threads } = applyAndMap(json, [t], tr => {
      const moved = applyContentOps(tr.doc, [{ op: 'moveBlock', blockId: 'b2', after: 'b3' }])
      for (const step of moved.steps) tr.step(step)
    })
    const frag = threads[0].anchor.fragments![0]
    expect(threads[0].detached).toBe(false)
    expect(frag.text).toBe('anchor')
    const ref = blockIndex(newDoc).get('b2')!
    expect(frag.from).toBe(ref.pos + 1)
  })

  it('block 锚点：区块移动保持绑定，删除后 detached', () => {
    const json = { type: 'doc', content: [para('b1', 'x'), para('b2', 'y'), para('b3', 'z')] }
    const doc = docNode(json)
    const t = threadWith(doc, { kind: 'block', blockId: 'b2' })
    const moved = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('b2')!
      const node = ref.node
      tr.delete(ref.pos, ref.pos + node.nodeSize)
      tr.insert(tr.doc.content.size, node)
    })
    expect(moved.threads[0].detached).toBe(false)
    expect(moved.threads[0].anchor.pos).toBe(blockIndex(moved.doc).get('b2')!.pos)

    const deleted = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('b2')!
      tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
    })
    expect(deleted.threads[0].detached).toBe(true)
  })

  it('image 锚点：绑定图片区块，删除即 detached', () => {
    const img = { type: 'image', attrs: { blockId: 'im', src: '/assets/abc.png', alt: '', caption: '图', usage: 'reference', usageDescription: '' } }
    const json = { type: 'doc', content: [para('b1', 'x'), img] }
    const doc = docNode(json)
    const t = threadWith(doc, { kind: 'image', blockId: 'im' })
    expect(t.anchor.quote?.text).toBe('图')
    const { threads } = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('im')!
      tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
    })
    expect(threads[0].detached).toBe(true)
  })

  it('emoji/代理对按编辑器位置语义处理', () => {
    const json = { type: 'doc', content: [para('b1', 'a😀bc')] } // 😀 占 2 个位置单位
    const doc = docNode(json)
    const t = rangeThread(doc, 'b1', 1, 4) // "😀b"（内容偏移 1~3）
    expect(t.anchor.fragments![0].text).toBe('😀b')
    const { threads } = applyAndMap(json, [t], tr => tr.insert(1, outlineSchema.text('🚀')))
    const frag = threads[0].anchor.fragments![0]
    expect(threads[0].detached).toBe(false)
    expect(frag.text).toBe('😀b')
    expect(frag.fromOffset).toBe(3) // "🚀"(2) + "a"(1)
  })

  it('嵌套列表项中的锚点可定位并映射', () => {
    const json = {
      type: 'doc',
      content: [{
        type: 'bullet_list',
        attrs: { blockId: 'l1' },
        content: [
          { type: 'list_item', attrs: { blockId: 'li1' }, content: [para('p1', 'outer')] },
          {
            type: 'list_item',
            attrs: { blockId: 'li2' },
            content: [
              para('p2', 'inner'),
              { type: 'bullet_list', attrs: { blockId: 'l2' }, content: [{ type: 'list_item', attrs: { blockId: 'li3' }, content: [para('p3', 'deep text')] }] },
            ],
          },
        ],
      }],
    }
    const doc = docNode(json)
    const t = rangeThread(doc, 'p3', 0, 4)
    expect(t.anchor.fragments![0].text).toBe('deep')
    const { threads } = applyAndMap(json, [t], tr => tr.insert(1, outlineSchema.text('prefix ')))
    expect(threads[0].detached).toBe(false)
    expect(threads[0].anchor.fragments![0].text).toBe('deep')
  })

  it('跨块选区：删除其中一块时其余片段仍保留', () => {
    const json = { type: 'doc', content: [para('b1', 'first para'), para('b2', 'second para')] }
    const doc = docNode(json)
    const t = threadWith(doc, {
      kind: 'textRange',
      fragments: [
        { blockId: 'b1', from: 6, to: 10 },
        { blockId: 'b2', from: 0, to: 6 },
      ],
    })
    const { threads } = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('b1')!
      tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
    })
    expect(threads[0].detached).toBe(false)
    expect(threads[0].anchor.fragments![0].detached).toBe(true)
    expect(threads[0].anchor.fragments![1].detached).toBeUndefined()
    expect(threads[0].anchor.fragments![1].text).toBe('second')
  })

  it('document 锚点不受任何正文修改影响', () => {
    const json = { type: 'doc', content: [para('b1', 'abc'), para('b2', 'x')] }
    const doc = docNode(json)
    const t = threadWith(doc, { kind: 'document' })
    const { threads } = applyAndMap(json, [t], tr => {
      const ref = blockIndex(tr.doc).get('b2')!
      tr.delete(ref.pos, ref.pos + ref.node.nodeSize)
    })
    expect(threads[0].detached).toBe(false)
  })

  it('重叠选区互不影响', () => {
    const json = { type: 'doc', content: [para('b1', 'abcdefgh')] }
    const doc = docNode(json)
    const t1 = rangeThread(doc, 'b1', 0, 4)
    const t2 = rangeThread(doc, 'b1', 2, 6)
    const { threads } = applyAndMap(json, [t1, t2], tr => tr.insert(4, outlineSchema.text('ZZ')))
    expect(threads.every(t => !t.detached)).toBe(true)
    expect(threads[0].anchor.fragments![0].text).toBe('abcZZd')
    expect(threads[1].anchor.fragments![0].text).toBe('cZZdef')
  })

  it('复制产生的重复 blockId 被重新生成', () => {
    const json = { type: 'doc', content: [para('dup', 'one'), para('dup', 'two')] }
    const doc = docNode(json)
    const ids = [...blockIndex(doc).keys()]
    expect(ids).toContain('dup')
    expect(ids.length).toBe(2)
  })
})
