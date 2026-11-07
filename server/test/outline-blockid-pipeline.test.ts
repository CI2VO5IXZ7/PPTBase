// 客户端 steps → 服务端重放的 blockId 一致性回归：
// appendTransaction 补的 blockId 修正必须并入同步队列（生产 createBlockIdPlugin sink），
// 否则服务端 Step.fromJSON 重放后 id 分叉，要等下一次 GET 才收敛。
import { describe, expect, it } from 'vitest'
import { EditorState, PluginKey, TextSelection, type Transaction } from 'prosemirror-state'
import { Step } from 'prosemirror-transform'
import type { Node as PMNode } from 'prosemirror-model'
import { wrapInList } from 'prosemirror-schema-list'
import { createBlockIdPlugin } from '../../src/utils/outline/blockIds'
import { outlineViewSchema as S } from '../../src/utils/outline/viewSchema'
import { outlineSchema } from '../../src/utils/outline/schema'

const key = new PluginKey('bidTest')
const para = (id: string, text: string) => S.nodes.paragraph.create({ blockId: id }, S.text(text))
const blockIds = (doc: { descendants: (cb: (n: { attrs: Record<string, unknown>, isBlock: boolean, type: { name: string } }) => boolean) => void }) => {
  const ids: string[] = []
  doc.descendants(n => {
    if (n.isBlock && n.type.name !== 'doc') ids.push(String(n.attrs.blockId))
    return true
  })
  return ids
}

// 客户端侧：真实插件应用事务，收集 原始 steps + 追加 steps（与 dispatchTransaction 同序）
function clientApply(state: EditorState, tr: Transaction) {
  const appended: Step[] = []
  const plugin = createBlockIdPlugin(key, st => appended.push(...st))
  const withPlugin = EditorState.create({ schema: S, doc: state.doc, plugins: [plugin] })
  const next = withPlugin.apply(tr)
  const all = [...tr.steps, ...appended].map(s => s.toJSON())
  return { state: next, allStepsJson: all }
}

// 服务端侧：与 service.applySteps 相同的 Step.fromJSON + 顺序应用
function serverReplay(baseDoc: PMNode, stepsJson: Record<string, unknown>[]) {
  let doc = baseDoc
  for (const raw of stepsJson) {
    const step = Step.fromJSON(outlineSchema, raw)
    const res = step.apply(doc)
    if (res.failed) throw new Error(`step apply failed: ${res.failed}`)
    doc = res.doc!
  }
  return doc
}

// 服务端存储用 outlineSchema；与视图 schema 节点名/attrs 完全一致，文档 JSON 可直接互用
const serverDocOf = (json: ReturnType<PMNode['toJSON']>) =>
  outlineSchema.nodeFromJSON(json)

describe('blockId 步骤管线（客户端追加 steps → 服务端重放同 id）', () => {
  it('Enter 拆分产生新块：追加的 blockId 修正随队列发送，重放后 id 一致', () => {
    const doc = S.nodes.doc.create(null, [para('p1', '第一段'), para('p2', '第二段')])
    const state = EditorState.create({ schema: S, doc, plugins: [createBlockIdPlugin(key)] })
    // 用户在 pos3 回车拆分 p1 → 新块复制 blockId='p1'（重复）→ appendTransaction 重新生成
    const { state: next, allStepsJson } = clientApply(state, state.tr.split(3))
    expect(allStepsJson.length).toBeGreaterThan(1) // 原始 split step + 追加 setNodeMarkup
    const replayed = serverReplay(serverDocOf(doc.toJSON()), allStepsJson)
    expect(blockIds(replayed)).toEqual(blockIds(next.doc))
    // 重复 id 已被修正为唯一
    expect(new Set(blockIds(next.doc)).size).toBe(blockIds(next.doc).length)
  })

  it('列表包裹产生新 list/list_item：缺省 id 补齐并可被服务端重放', () => {
    const doc = S.nodes.doc.create(null, [para('p1', '列表内容'), para('p2', '保留段')])
    let state = EditorState.create({ schema: S, doc, plugins: [createBlockIdPlugin(key)] })
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
    let tr2: Transaction | null = null
    wrapInList(S.nodes.bullet_list)(state, t => {
      tr2 = t
    })
    expect(tr2).toBeTruthy()
    const { state: next, allStepsJson } = clientApply(state, tr2!)
    const replayed = serverReplay(serverDocOf(doc.toJSON()), allStepsJson)
    expect(blockIds(replayed)).toEqual(blockIds(next.doc))
    // 新 list/list_item 都拿到了 blockId（非空）
    expect(blockIds(next.doc).every(id => id.length > 0)).toBe(true)
  })

  it('模拟粘贴同 id 两块：去重后重放一致，随后批注锚点可用该 id 定位', () => {
    const doc = S.nodes.doc.create(null, [para('p1', '首段'), para('p2', '尾段')])
    const state = EditorState.create({ schema: S, doc, plugins: [createBlockIdPlugin(key)] })
    // 粘贴效果：插入一个复制了 blockId='p1' 的段落
    const dup = para('p1', '粘贴段')
    const tr = state.tr.insert(1, dup)
    const { state: next, allStepsJson } = clientApply(state, tr)
    const replayed = serverReplay(serverDocOf(doc.toJSON()), allStepsJson)
    const ids = blockIds(next.doc)
    expect(new Set(ids).size).toBe(ids.length) // 客户端已去重
    expect(blockIds(replayed)).toEqual(ids) // 服务端重放同 id
    // 批注锚点用新生成的 id：在重放文档上同样可定位
    const newId = ids[1]
    let found = -1
    replayed.descendants((n, pos) => {
      if (n.attrs.blockId === newId) {
        found = pos; return false
      }
      return true
    })
    expect(found).toBeGreaterThanOrEqual(0)
  })
})
