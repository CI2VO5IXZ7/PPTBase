// 仅浏览器使用的视图 schema：在共享 DOM 无关 schema 的 node/mark spec 上
// 叠加 toDOM/parseDOM，供 EditorView 渲染与粘贴解析；不影响服务端共享语义。
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { outlineSchema } from './schema'

const BID = 'data-block-id'

const NODE_DOM: Record<string, { toDOM: NodeSpec['toDOM'], parseDOM?: NodeSpec['parseDOM'] }> = {
  doc: { toDOM: () => ['div', { class: 'outline-doc' }, 0] },
  paragraph: {
    toDOM: n => ['p', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'p', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  heading: {
    toDOM: n => [`h${n.attrs.level}`, { [BID]: n.attrs.blockId }, 0] as DOMOutputSpec,
    parseDOM: [1, 2, 3].map(l => ({
      tag: `h${l}`,
      getAttrs: d => ({ level: l, blockId: (d as HTMLElement).getAttribute(BID) ?? '' }),
    })) as NodeSpec['parseDOM'],
  },
  blockquote: {
    toDOM: n => ['blockquote', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'blockquote', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  bullet_list: {
    toDOM: n => ['ul', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'ul', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  ordered_list: {
    toDOM: n => ['ol', { [BID]: n.attrs.blockId, ...(n.attrs.order !== 1 ? { start: n.attrs.order } : {}) }, 0] as DOMOutputSpec,
    parseDOM: [{ tag: 'ol', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '', order: +(d as HTMLOListElement).start || 1 }) }],
  },
  list_item: {
    toDOM: n => ['li', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'li', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  image: {
    toDOM: n => ['figure', { [BID]: n.attrs.blockId, class: 'outline-image' },
      ['img', { src: n.attrs.src, alt: n.attrs.alt }],
      ['figcaption', {}, n.attrs.caption || n.attrs.usageDescription || n.attrs.usage],
    ],
    parseDOM: [{ tag: 'figure', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  horizontal_rule: {
    toDOM: n => ['hr', { [BID]: n.attrs.blockId }],
    parseDOM: [{ tag: 'hr', getAttrs: d => ({ blockId: (d as HTMLElement).getAttribute(BID) ?? '' }) }],
  },
  text: { toDOM: undefined as never },
  hard_break: { toDOM: () => ['br'], parseDOM: [{ tag: 'br' }] },
}

const MARK_DOM: Record<string, { toDOM: MarkSpec['toDOM'], parseDOM?: MarkSpec['parseDOM'] }> = {
  strong: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
  em: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  link: {
    toDOM: m => ['a', { href: m.attrs.href, ...(m.attrs.title ? { title: m.attrs.title } : {}), rel: 'noopener noreferrer' }, 0],
    parseDOM: [{ tag: 'a[href]', getAttrs: d => ({ href: (d as HTMLAnchorElement).getAttribute('href') ?? '', title: (d as HTMLAnchorElement).getAttribute('title') ?? '' }) }],
  },
}

const nodes: Record<string, NodeSpec> = {}
for (const name of Object.keys(outlineSchema.nodes)) {
  const spec = { ...outlineSchema.nodes[name].spec }
  const dom = NODE_DOM[name]
  if (dom?.toDOM) spec.toDOM = dom.toDOM
  if (dom?.parseDOM) spec.parseDOM = dom.parseDOM
  nodes[name] = spec
}
const marks: Record<string, MarkSpec> = {}
for (const name of Object.keys(outlineSchema.marks)) {
  const spec = { ...outlineSchema.marks[name].spec }
  const dom = MARK_DOM[name]
  if (dom?.toDOM) spec.toDOM = dom.toDOM
  if (dom?.parseDOM) spec.parseDOM = dom.parseDOM
  marks[name] = spec
}

export const outlineViewSchema = new Schema({ nodes, marks })
