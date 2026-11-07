// 仅浏览器使用的视图 schema：在共享 DOM 无关 schema 的 node/mark spec 上
// 叠加 toDOM/parseDOM，供 EditorView 渲染与粘贴解析；不影响服务端共享语义。
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { IMAGE_USAGES, outlineSchema } from './schema'

const BID = 'data-block-id'
// parseDOM 回调不直接引用 DOM lib 类型（服务端无 DOM 类型也可编译）；入参 unknown + 结构化断言
interface DomEl {
  getAttribute: (k: string) => string | null
  querySelector: (s: string) => DomEl | null
  textContent: string | null
}
const dom = (d: unknown) => d as DomEl
// 只允许本站资产地址进入文档（防外链/追踪像素/js 协议）
const SAFE_ASSET_SRC = /^\/assets\/[\w-]+\.[a-z0-9]+$/i
const assetIdFromSrc = (src: string) => src.match(/^\/assets\/([\w-]+)\.[a-z0-9]+$/i)?.[1] ?? ''

const NODE_DOM: Record<string, { toDOM: NodeSpec['toDOM'], parseDOM?: NodeSpec['parseDOM'] }> = {
  doc: { toDOM: () => ['div', { class: 'outline-doc' }, 0] },
  paragraph: {
    toDOM: n => ['p', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'p', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '' }) }],
  },
  heading: {
    toDOM: n => [`h${n.attrs.level}`, { [BID]: n.attrs.blockId }, 0] as DOMOutputSpec,
    parseDOM: [1, 2, 3].map(l => ({
      tag: `h${l}`,
      getAttrs: d => ({ level: l, blockId: dom(d).getAttribute(BID) ?? '' }),
    })) as NodeSpec['parseDOM'],
  },
  blockquote: {
    toDOM: n => ['blockquote', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'blockquote', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '' }) }],
  },
  bullet_list: {
    toDOM: n => ['ul', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'ul', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '' }) }],
  },
  ordered_list: {
    toDOM: n => ['ol', { [BID]: n.attrs.blockId, ...(n.attrs.order !== 1 ? { start: n.attrs.order } : {}) }, 0] as DOMOutputSpec,
    parseDOM: [{ tag: 'ol', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '', order: +((d as { start?: string | number }).start ?? 1) || 1 }) }],
  },
  list_item: {
    toDOM: n => ['li', { [BID]: n.attrs.blockId }, 0],
    parseDOM: [{ tag: 'li', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '' }) }],
  },
  image: {
    toDOM: n => ['figure', { [BID]: n.attrs.blockId, class: 'outline-image', 'data-usage': n.attrs.usage, 'data-usage-desc': n.attrs.usageDescription, 'data-caption': n.attrs.caption, 'data-asset-id': n.attrs.assetId },
      ['img', { src: n.attrs.src, alt: n.attrs.alt }],
      ['figcaption', {}, n.attrs.caption || n.attrs.usageDescription || n.attrs.usage],
    ],
    parseDOM: [
      {
        tag: 'figure',
        getAttrs: (d: unknown) => {
          const img = dom(d).querySelector('img')
          const src = img?.getAttribute('src') ?? ''
          // 空 src/外链一律拒绝：空 src 会生成服务端拒收的 image 节点并卡死保存队列
          if (!SAFE_ASSET_SRC.test(src)) return false
          const dataCaption = dom(d).getAttribute('data-caption')
          const usageAttr = dom(d).getAttribute('data-usage')
          return {
            blockId: dom(d).getAttribute(BID) ?? '',
            src,
            alt: img?.getAttribute('alt') ?? '',
            caption: dataCaption ?? dom(d).querySelector('figcaption')?.textContent ?? '',
            // 非法 usage 回退 reference（不信任粘贴属性；抛 RangeError 会炸掉整个粘贴）
            usage: IMAGE_USAGES.includes(usageAttr as 'include' | 'reference') ? usageAttr as 'include' | 'reference' : 'reference',
            usageDescription: (dom(d).getAttribute('data-usage-desc') ?? '').slice(0, 200),
            // assetId 只从 src 推导，不信任粘贴的 data-asset-id（服务端仍做属主校验）
            assetId: assetIdFromSrc(src),
          }
        },
      },
      // 直接粘贴 <img>（无 figure 包裹）：仅接受本站 /assets/ 同源地址，外链一律拒绝
      {
        tag: 'img[src]',
        getAttrs: (d: unknown) => {
          const src = dom(d).getAttribute('src') ?? ''
          if (!SAFE_ASSET_SRC.test(src)) return false
          return { blockId: '', src, alt: dom(d).getAttribute('alt') ?? '', caption: '', usage: 'reference', usageDescription: '', assetId: assetIdFromSrc(src) }
        },
      },
    ],
  },
  horizontal_rule: {
    toDOM: n => ['hr', { [BID]: n.attrs.blockId }],
    parseDOM: [{ tag: 'hr', getAttrs: d => ({ blockId: dom(d).getAttribute(BID) ?? '' }) }],
  },
  text: { toDOM: undefined as never },
  hard_break: { toDOM: () => ['br'], parseDOM: [{ tag: 'br' }] },
}

const MARK_DOM: Record<string, { toDOM: MarkSpec['toDOM'], parseDOM?: MarkSpec['parseDOM'] }> = {
  strong: { toDOM: () => ['strong', 0], parseDOM: [{ tag: 'strong' }, { tag: 'b' }] },
  em: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  link: {
    toDOM: m => ['a', { href: m.attrs.href, ...(m.attrs.title ? { title: m.attrs.title } : {}), rel: 'noopener noreferrer' }, 0],
    parseDOM: [{ tag: 'a[href]', getAttrs: d => ({ href: dom(d).getAttribute('href') ?? '', title: dom(d).getAttribute('title') ?? '' }) }],
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
