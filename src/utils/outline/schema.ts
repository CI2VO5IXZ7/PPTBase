// 大纲的受限 ProseMirror schema：DOM 无关（不引用 window/document、
// 不提供 parseDOM/toDOM），浏览器与服务端共用同一份节点/marks/锚点规则。
// 不扩展现有 PPT 文本框 schema，两者互不混入。

import { Schema, type Node as PMNode } from 'prosemirror-model'

export const BLOCK_ID_ATTR = 'blockId'

// 资源/锚点/大小预算上限（服务端强制，客户端可据此提前提示）
export const OUTLINE_LIMITS = {
  maxBlocks: 2000,
  maxDepth: 8,
  maxTextChars: 200_000,
  maxStepsPerRequest: 200,
  maxOpsPerRequest: 50,
  maxBlocksPerOp: 50,
  maxThreads: 500,
  maxMessagesPerThread: 50,
  maxCommentChars: 2_000,
  maxQuoteChars: 2_000,
  maxContextChars: 80,
  maxLinkChars: 2_000,
  maxCaptionChars: 500,
  maxAltChars: 500,
  maxUsageDescChars: 2_000,
  maxImageSrcChars: 2_000,
  maxNoteChars: 2_000,
} as const

export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const IMAGE_USAGES = ['reference', 'include'] as const

const blockId = { default: '' }

// 只有这些节点携带稳定 blockId，可被选区/批注定位
export const outlineSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId },
      defining: true,
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1, validate: (v: unknown) => {
        if (v !== 1 && v !== 2 && v !== 3) throw new RangeError('heading level 必须是 1~3') 
      } }, blockId },
      defining: true,
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      attrs: { blockId },
      defining: true,
    },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { blockId },
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { blockId, order: { default: 1, validate: (v: unknown) => {
        if (!Number.isInteger(v) || (v as number) < 1) throw new RangeError('order 必须是正整数') 
      } } },
    },
    list_item: {
      content: 'paragraph block*',
      attrs: { blockId },
      defining: true,
    },
    image: {
      group: 'block',
      atom: true,
      attrs: {
        blockId,
        src: { default: '' },
        alt: { default: '' },
        caption: { default: '' },
        usage: { default: 'reference', validate: (v: unknown) => {
          if (!IMAGE_USAGES.includes(v as never)) throw new RangeError('usage 必须是 reference|include') 
        } },
        usageDescription: { default: '' },
      },
      defining: true,
      selectable: true,
    },
    horizontal_rule: {
      group: 'block',
      attrs: { blockId },
      selectable: true,
    },
    text: { group: 'inline' },
    hard_break: { group: 'inline', inline: true, selectable: false },
  },
  marks: {
    strong: {},
    em: {},
    link: {
      attrs: { href: { default: '' }, title: { default: '' } },
      inclusive: false,
    },
  },
})

export type OutlineDocNode = PMNode

// 节点类型是否可携带 blockId（由 schema 属性声明决定，而非硬编码名单）
export function hasBlockId(node: OutlineDocNode): boolean {
  return typeof node.attrs[BLOCK_ID_ATTR] === 'string' && node.attrs[BLOCK_ID_ATTR] !== ''
}

export function defaultOutlineDocJson() {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { blockId: '' } }],
  }
}

// JSON 层面的 blockId 归一化：缺失/非法/重复的 blockId 重新生成。
// 移动/拆分保留已有 id；复制产生的重复 id 给后出现者换新。返回是否有改动
export function normalizeBlockIdsJson(
  json: { type: string, attrs?: Record<string, unknown>, content?: unknown[] },
  genId: () => string,
): boolean {
  const seen = new Set<string>()
  let changed = false

  const visit = (node: { type: string, attrs?: Record<string, unknown>, content?: unknown[] }): void => {
    const type = outlineSchema.nodes[node.type]
    if (!type) return
    if (type.spec.attrs && type.spec.attrs.blockId !== undefined) {
      const current = node.attrs?.blockId
      if (typeof current === 'string' && BLOCK_ID_PATTERN.test(current) && !seen.has(current)) {
        seen.add(current)
      }
      else {
        let id = genId()
        while (seen.has(id)) id = genId()
        seen.add(id)
        node.attrs = { ...(node.attrs ?? {}), blockId: id }
        changed = true
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (child && typeof child === 'object') visit(child as typeof node)
      }
    }
  }
  visit(json)
  return changed
}
