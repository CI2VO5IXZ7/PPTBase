// 图片节点 DOM 序列化/解析回环：assetId、精确 caption、安全 src 白名单、粘贴行为
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { outlineViewSchema as S } from '../../src/utils/outline/viewSchema'

const spec = S.nodes.image.spec
const toDOM = spec.toDOM as (n: PMNode) => unknown[]
const figureRule = spec.parseDOM![0]
const imgRule = spec.parseDOM![1]

const el = (attrs: Record<string, string>, imgSrc = '', imgAlt = '', figText = '') => ({
  getAttribute: (k: string) => attrs[k] ?? null,
  querySelector: (sel: string) => {
    if (sel === 'img') return imgSrc ? { getAttribute: (k: string) => (k === 'src' ? imgSrc : k === 'alt' ? imgAlt : null) } : null
    if (sel === 'figcaption') return { textContent: figText }
    return null
  },
}) as unknown as never

describe('image toDOM/parseDOM', () => {
  it('toDOM 输出 assetId/caption/usage 数据属性', () => {
    const n = S.nodes.image.create({ blockId: 'b1', src: '/assets/abc.png', alt: 'x', caption: 'cap', usage: 'include', usageDescription: 'd', assetId: 'abc' })
    const dom = toDOM(n)
    const attrs = (dom as unknown[])[1] as Record<string, string>
    expect(attrs['data-asset-id']).toBe('abc')
    expect(attrs['data-caption']).toBe('cap')
    expect(attrs['data-usage']).toBe('include')
    expect(attrs['data-usage-desc']).toBe('d')
  })

  it('parseDOM figure：assetId 保留、空 caption 不回退成 usage 文案', () => {
    const attrs = figureRule.getAttrs!(el(
      { 'data-block-id': 'b9', 'data-caption': '', 'data-usage': 'include', 'data-usage-desc': 'desc', 'data-asset-id': 'abc' },
      '/assets/abc.png', 'a', '展示文案',
    ) as never) as Record<string, string>
    expect(attrs.assetId).toBe('abc')
    expect(attrs.caption).toBe('')
    expect(attrs.usage).toBe('include')
  })

  it('无 data-asset-id 时从 src 推导；非法 src 拒绝', () => {
    const derived = figureRule.getAttrs!(el({ 'data-block-id': 'b1' }, '/assets/xyz.png') as never) as Record<string, string>
    expect(derived.assetId).toBe('xyz')
    const bad = figureRule.getAttrs!(el({ 'data-block-id': 'b1' }, 'https://evil.com/x.png') as never)
    expect(bad).toBe(false)
  })

  it('裸 <img> 粘贴：只接受 /assets/ 同源，外链拒绝', () => {
    const ok = imgRule.getAttrs!({ getAttribute: (k: string) => (k === 'src' ? '/assets/p.png' : null) } as never) as Record<string, string>
    expect(ok.src).toBe('/assets/p.png')
    expect(ok.assetId).toBe('p')
    expect(ok.usage).toBe('reference')
    const bad = imgRule.getAttrs!({ getAttribute: (k: string) => (k === 'src' ? 'javascript:alert(1)' : null) } as never)
    expect(bad).toBe(false)
  })
})
