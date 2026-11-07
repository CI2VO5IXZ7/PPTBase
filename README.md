# PPTBase

面向 AI Agent 的在线演示文稿服务：Agent 通过远程 MCP 创建和修改演示文稿，用户在网页端查看与协作编辑，服务端可导出 PPTX / PDF / 图片。

## 代码来源与许可

本项目的**渲染、在线编辑、放映和浏览器端导出**基于 [PPTist](https://github.com/pipipi-pikachu/PPTist)（作者 [pipipi-pikachu](https://github.com/pipipi-pikachu)，AGPL-3.0），上游基线提交 `a8fcb4d`。在此基础上新增了多用户服务端、MCP、协作同步与管理台。

| 类别 | 范围 |
|---|---|
| 来自上游（未改动） | `src/views/Screen/**`、`src/views/Mobile/**`（除 `MobilePreview.vue`）、`src/views/components/**`、`src/components/**`（除 `SourceAttribution.vue`）、`src/hooks/**`（除 `useDocumentSync.ts`）、`src/store/**`（除 `document.ts`）、`src/utils/**`（除 `entry.ts` 与 `__tests__/`）、`src/configs/**`（除 `collab.ts`）、`src/types/**`、`src/assets/**`、`src/directive/**`、`public/`（`favicon.ico`、`logo.png`） |
| 在上游基础上修改 | `src/App.vue`、`src/hooks/useExport.ts`、`src/hooks/useSlideHandler.ts`、`src/hooks/usePasteDataTransfer.ts`、`src/store/index.ts`、`src/store/main.ts`、`src/store/slides.ts`、`src/types/export.ts`、`src/types/slides.ts`、`src/utils/prosemirror/commands/replaceText.ts`、`src/views/Editor/index.vue`、`src/views/Editor/EditorHeader/index.vue`、`src/views/Editor/CanvasTool/index.vue`、`src/views/Editor/Thumbnails/index.vue`、`src/views/Editor/Toolbar/common/RichTextBase.vue`、`src/views/Editor/ExportDialog/index.vue`、`src/views/Mobile/MobilePreview.vue`、`vite.config.ts`、`env.d.ts`、`index.html`、`package.json`、`components.d.ts` |
| 本项目新增 | `server/**`、`src/admin/**`、`src/views/ExportRuntime`、`src/views/Viewer`、`src/views/McpHome`、`src/hooks/useDocumentSync.ts`、`src/services/document.ts`、`src/store/document.ts`、`src/components/SourceAttribution.vue`、`src/configs/collab.ts`、`src/utils/entry.ts`、`src/utils/__tests__/`、`doc/AI_PPT_SCHEMA.md`、`admin.html`、`Dockerfile`、`docker-compose.yml`、`Caddyfile`、`.dockerignore` |

相比上游基线，本项目删除了未使用的上游功能代码：AIPPT、AI 文本改写、在线图库、幻灯片类型标注、模板库与模板 mocks、全部文件导入（PPTX / JSON / `.pptist`）及 `.pptist` 专属导出、`public/mocks` 示例数据等；完整清单见 git 历史。

第三方参考（沿用上游源码注释中的说明）：hfmath（[LingDong-/hfmath](https://github.com/LingDong-/hfmath)，上游 fork 后做了扩展）、himalaya（`src/utils/htmlParser`）、svg64（`src/utils/svg2Base64.ts`）。

## 功能

服务端（`server/`，Fastify + better-sqlite3）：

- **多用户隔离**：每个用户只拥有自己的文档，所有访问按请求鉴权。
- **凭证体系**：用户 API Key（`pk_…`，供 Agent 与 REST API 使用）+ 每文档的编辑/只读令牌（`X-Doc-Token` 请求头、URL `#t=` hash，供网页端使用）。Key 只在创建时显示一次，管理端永远只显示 Key 前缀。
- **配额与存储**：按用户配额（文档数、单文档大小、每日导出次数）。文档、修订、上传资产与导出文件全部放在 `DATA_DIR`——SQLite `app.db`（WAL）、`assets/`、`exports/`。
- **协作**：文档带版本号，写入基于 `baseVersion` 三方合并（冲突返回 409），SSE 推送（`GET /api/docs/:id/events`），批注/评论。
- **制作前大纲（outline）**：每个文档可有一份受限 ProseMirror 大纲（编辑 `?doc=…&tab=outline`，只读 `?doc=…&tab=outline&mode=view`，编辑/只读令牌与 PPT 共用 `#t=` hash，仅内存携带不落存储）。Agent 用 `create_outline`/`edit_outline` 起草，用户在网页批注、逐轮提交反馈（不可变快照），确认后 `begin_presentation_from_outline` 发制作来源；之后所有 Agent 写页面工具（MCP 及 REST ops/patch）必须携带 `sourceApprovalId`。大纲正文/图片/用途变化会使旧来源失效，批注不影响。用户提交反馈/确认**不会唤醒** Agent——在对话中继续处理即可。
  - REST：`GET/POST/PATCH /api/docs/:id/outline`、`POST /api/docs/:id/outline/ops`（区块+线程）、`POST/GET /api/docs/:id/outline/feedback`、`POST /api/docs/:id/outline/feedback/:id/complete`、`POST/DELETE /api/docs/:id/outline/approval`、`POST /api/docs/:id/outline/generation`。
  - 常见错误：`conflict`（`issues.currentVersion`/`currentContentVersion`；仅 contentVersion 未变时可安全重放，正文已变需保留草稿人工迁移）、`production_source_required`（先确认+begin）、`validation`（ops/锚点非法）、`doc_too_large`（PPT+大纲+快照合计配额）。
  - 隐私：大纲图片走 `/assets/{id}.{ext}` **公开但不可猜测**地址（无鉴权；随机 id 即链接保密性，与 PPT 图片一致）；MCP `get_outline_asset` 另行校验资产归属与所读版本引用。资产按所有者保留，**不随文档删除**。
  - 升级/恢复：v3→v4 自动迁移建 `outlines`/`outline_revisions`/`outline_submissions`/`outline_approvals`；升级前备份 `app.db`（WAL）+ `assets/` 全目录；回滚需恢复旧备份（v4 新表对旧程序无害但不回读）。配额按 PPT 正文+大纲正文+快照合计计入 `quota_doc_bytes`。
- **远程 MCP**：`POST /mcp`（Streamable HTTP，无状态，唯一端点）提供创建、编辑、导出演示文稿的工具——`create_presentation`、`add_slides`、`update_elements`、`batch_edit`、`get_changes`、`export_presentation` 等；大纲工具 `create_outline`、`get_outline`、`edit_outline`、`get_outline_feedback`、`complete_outline_feedback`、`begin_presentation_from_outline`、`get_outline_asset`；`get_authoring_guide` 分段返回编写规范（`doc/AI_PPT_SCHEMA.md`，含 outline 章节）。
- **服务端导出**：无头 Chromium（Playwright）复用前端导出运行时渲染 PPTX / PDF / PNG；JSON 导出不走浏览器。
- **管理端**：独立的 `/admin` 管理台（单独的 Vite 入口 `admin.html`，Vue 3 + Naive UI）+ `pptist-admin` CLI，覆盖用户、Key、配额与 SQLite 在线备份。
- **Agent 说明页**：不带 `doc` 参数访问根路径 `/` 时，显示面向 Agent 的 MCP 接入说明页而非编辑器（`src/views/McpHome`）。

编辑器（来自上游）：

- Vue 3 + TypeScript 构建
- 常用 Office PPT 元素：文字、图片、形状、线条、图表、表格、视频、音频、公式
- 幻灯片页面编辑、翻页与元素动画、放映工具（含演讲者/观众视图）、移动端基础编辑与预览
- 浏览器端 PPTX / JSON / 图片 / PDF 导出

## 文档链接

- 编辑链接：`https://<你的域名>/?doc=<docId>#t=<编辑令牌>`
- 只读链接：`https://<你的域名>/?doc=<docId>&mode=view#t=<只读令牌>`
- 不带 `doc` 的 `/` → MCP 说明页；`?mode=export` 是服务端内部使用的无头导出运行时。

## 快速开始

### 本地开发（Node.js >= 20）

```bash
# 前端 —— Vite 开发服务器 http://127.0.0.1:5173，把 /api /assets /exports /mcp 代理到 :3100
npm install
npm run dev

# 后端 —— http://0.0.0.0:3100
npm --prefix server install
npm --prefix server run dev
```

### Docker Compose 自托管（镜像自带 Chromium）

```bash
mkdir -p data
chown 1001:1001 data    # Playwright 镜像中非 root 用户 pwuser 可写
docker compose up -d     # 仅 app，http://127.0.0.1:3100
curl http://127.0.0.1:3100/api/health

docker compose exec app pptist-admin user create alice   # alice 可替换；pk_ Key 只显示这一次
```

`docker compose --profile https up -d` 会额外启动 Caddy 自动签发 HTTPS——先把 `Caddyfile` 里的域名和 `docker-compose.yml` 里的 `PUBLIC_BASE_URL` 改成你的真实域名。`https` profile 默认不启用，普通 `docker compose up -d` 只起 app。完整部署说明见 [server/README.md](server/README.md)。

### 接入 Agent（远程 MCP）

```yaml
mcp_servers:
  pptbase:
    url: https://pptbase.example.com/mcp   # 换成你部署的公网地址
    headers:
      Authorization: Bearer pk_...        # 真实 Key 由 pptist-admin 签发，只显示一次
```

### 管理台

- 首次管理员密码：用 `ADMIN_INITIAL_PASSWORD` 环境变量（≥10 字符，仅在库里还没有密码时播种），或执行 `pptist-admin passwd`。
- 宿主不方便调整目录权限时，可把 Compose 的 data 绑定挂载改为 Docker named volume（卷名如 `pptbase-data`），不要以 root 运行应用。
- 入口：生产 `GET /admin`；Vite 开发模式下 `http://localhost:5173/admin.html`。

## 运维提示

- 生产请走 HTTPS；`ADMIN_SECURE_COOKIES` 依据 `PUBLIC_BASE_URL` 自动判定。仅在可信反代之后设置 `TRUST_PROXY=1`。
- 密钥、用户 Key、`data/` 目录一律不入库——`.env*` 已被 git 忽略，`server/.env.example` 只含占位符。
- `pptist-admin backup <文件>` 可做 SQLite 在线备份；备份计划与异地拷贝由部署者按需自行安排，仓库不自带任何自动备份任务。

## 文档

- 服务端：环境变量、`pptist-admin` CLI、REST/MCP API、部署 —— [server/README.md](server/README.md)
- 页面数据编写规范（Agent 编写 PPT 内容时遵循） —— [doc/AI_PPT_SCHEMA.md](doc/AI_PPT_SCHEMA.md)

## 许可证

[AGPL-3.0](LICENSE)

Copyright © 2020-PRESENT [pipipi-pikachu](https://github.com/pipipi-pikachu)（上游编辑器及其衍生部分）
Copyright © 2026 CI2VO5IXZ7（本项目新增的服务端、MCP、管理台等部分）

AGPL-3.0 覆盖整个仓库：如果你修改了代码并通过网络提供给他人使用（例如把本服务作为在线服务开放），必须以 AGPL-3.0 完整公开对应源码、保留版权声明、不得附加额外限制。
