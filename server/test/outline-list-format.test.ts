// 列表包裹/输入/嵌套/撤销的纯 ProseMirror 回归（不依赖浏览器视图）
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { history, undo } from 'prosemirror-history'
import { outlineViewSchema as S } from '../../src/utils/outline/viewSchema'

const para = (id: string, text: string) => S.nodes.paragraph.create({ blockId: id }, S.text(text))

const apply = (state: EditorState, cmd: Command) => {
  let next = state
  const ok = cmd(state, (tr: Transaction) => {
    next = state.apply(tr)
  })
  return { ok, state: next }
}

describe('列表格式化不丢内容', () => {
  it('段落 → 无序列表：文字保留、光标在列表项内', () => {
    let state = EditorState.create({
      schema: S,
      doc: S.nodes.doc.create(null, para('p1', '列表项一')),
    })
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
    const r = apply(state, wrapInList(S.nodes.bullet_list))
    expect(r.ok).toBe(true)
    expect(r.state.doc.firstChild?.type.name).toBe('bullet_list')
    expect(r.state.doc.textContent).toBe('列表项一')
    // 包裹后继续输入落在列表项内
    const typed = r.state.apply(r.state.tr.insertText('新增'))
    expect(typed.doc.textContent).toContain('列表项一新增')
  })

  it('换行拆项 + sink 产生嵌套列表', () => {
    let state = EditorState.create({
      schema: S,
      doc: S.nodes.doc.create(null, para('p1', '第一项')),
    })
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
    state = apply(state, wrapInList(S.nodes.bullet_list)).state
    // Enter 拆出第二项
    state = apply(state, splitListItem(S.nodes.list_item)).state
    state = state.apply(state.tr.insertText('第二项'))
    // sink 第二项 → 嵌套
    const r = apply(state, sinkListItem(S.nodes.list_item))
    expect(r.ok).toBe(true)
    let nested = false
    r.state.doc.descendants(n => {
      if (n.type.name === 'list_item') {
        n.forEach(c => {
          if (c.type.name === 'bullet_list') nested = true
        })
      }
      return true
    })
    expect(nested).toBe(true)
    expect(r.state.doc.textContent).toContain('第二项')
  })

  it('history undo 恢复包裹前段落', () => {
    let state = EditorState.create({
      schema: S,
      doc: S.nodes.doc.create(null, para('p1', '原段落')),
      plugins: [history()],
    })
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
    state = apply(state, wrapInList(S.nodes.bullet_list)).state
    expect(state.doc.firstChild?.type.name).toBe('bullet_list')
    const r = apply(state, undo)
    expect(r.ok).toBe(true)
    expect(r.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(r.state.doc.textContent).toBe('原段落')
  })
})
