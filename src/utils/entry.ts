// 首页入口判定：根路径没有 doc 和 mode 参数时，展示面向 Agent 的 MCP 说明页；
// 带 doc 或 mode（export/view/audience 等）走文档/放映/导出逻辑
export function isMcpHomeEntry(search: string): boolean {
  const params = new URLSearchParams(search)
  return !params.get('doc') && !params.get('mode')
}
