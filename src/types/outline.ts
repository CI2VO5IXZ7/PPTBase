// 制作前大纲（自由文档）的共享类型定义。
// 正文唯一真相源是受限 ProseMirror JSON（见 src/utils/outline/schema.ts），
// 与幻灯片 Slide schema / PPT 文本框 schema 完全独立，
// 也不是 get_presentation(view="outline") 的幻灯片压缩视图。

export type OutlineAuthor = 'agent' | 'user'

export type OutlineAnchorKind = 'document' | 'block' | 'image' | 'textRange'

// textRange 选区在单个可定位区块内的片段。
// from/to 是当前 ProseMirror 文档位置（编辑器位置语义，非字节数）；
// fromOffset/toOffset 是相对该区块文本内容起点的偏移（同样按编辑器位置计），
// 用于区块整体移动等位置映射失效场景下在同一 blockId 内安全重挂。
export interface OutlineRangeFragment {
  blockId: string
  from: number
  to: number
  fromOffset: number
  toOffset: number
  text: string
  detached?: boolean
}

export interface OutlineAnchor {
  kind: OutlineAnchorKind
  // block/image 锚点目标区块
  blockId?: string
  // block/image 节点在当前文档中的位置，每次内容写入后刷新
  pos?: number
  // textRange 覆盖的一个或多个区块片段
  fragments?: OutlineRangeFragment[]
  // 创建时引用的原文与前后文；锚点失效后仍保留供阅读
  quote?: { before: string, text: string, after: string }
  createdContentVersion: number
}

export interface OutlineThreadMessage {
  id: string
  author: OutlineAuthor
  content: string
  createdAt: number
}

export type OutlineThreadStatus = 'open' | 'resolved'

export interface OutlineThread {
  id: string
  status: OutlineThreadStatus
  // 锚点整体失效（原文被删/跨块结构变化）。按引用原文保留，不做相似度重绑
  detached: boolean
  anchor: OutlineAnchor
  messages: OutlineThreadMessage[]
  createdAt: number
  resolvedAt?: number
}

export type OutlineImageUsage = 'reference' | 'include'

export interface OutlineAssetRef {
  blockId: string
  src: string
  assetId?: string
  caption: string
  usage: OutlineImageUsage
  usageDescription: string
  // http(s) 外链（非站内受控资产）
  external: boolean
}

export type OutlineSubmissionStatus = 'pending' | 'handled' | 'superseded'

export type OutlineApprovalStatus = 'active' | 'revoked' | 'superseded'

export interface OutlineSubmission {
  id: string
  docId: string
  round: number
  version: number
  contentVersion: number
  status: OutlineSubmissionStatus
  note?: string
  result?: { note?: string, keyId?: string, completedAt: number }
  createdAt: number
  handledAt?: number
}

export interface OutlineApproval {
  id: string
  docId: string
  version: number
  contentVersion: number
  status: OutlineApprovalStatus
  openThreads: number
  acknowledgedOpenThreads: boolean
  createdAt: number
  revokedAt?: number
}

// op 请求中的锚点描述。textRange 的 from/to 是该区块文本内容内的偏移（编辑器位置语义）
export type OutlineAnchorSpec =
  | { kind: 'document' }
  | { kind: 'block', blockId: string }
  | { kind: 'image', blockId: string }
  | { kind: 'textRange', fragments: { blockId: string, from: number, to: number }[] }

export interface OutlineNodeJson {
  type: string
  attrs?: Record<string, unknown>
  content?: OutlineNodeJson[]
  text?: string
  marks?: { type: string, attrs?: Record<string, unknown> }[]
}

// 面向 Agent/网页的结构化区块与线程操作；服务端统一编译为 transforms 应用
export type OutlineOp =
  | { op: 'insertBlocks', before?: string, after?: string, blocks: OutlineNodeJson[] }
  | { op: 'replaceBlock', blockId: string, block: OutlineNodeJson }
  | { op: 'updateBlockAttrs', blockId: string, attrs: Record<string, unknown> }
  | { op: 'deleteBlocks', blockIds: string[] }
  | { op: 'moveBlock', blockId: string, before?: string, after?: string }
  | { op: 'addComment', anchor: OutlineAnchorSpec, content: string }
  | { op: 'replyComment', threadId: string, content: string }
  | { op: 'setThreadStatus', threadId: string, status: OutlineThreadStatus }
