<p align="center">
    <img src='/public/logo.png' />
</p>

简体中文 | [English](README.md)

# PPTist —— 面向 Agent 的多用户 Fork

**本仓库是 [pipipi-pikachu/PPTist](https://github.com/pipipi-pikachu/PPTist) 的 fork。** 在保留上游 Vue 3 + TypeScript 网页编辑器的基础上，新增了为 AI Agent 工作流设计的自托管服务端（`server/`）：多用户 API Key、服务端文档存储、远程 MCP 端点、服务端导出与管理台。本 fork 与上游无隶属关系、未获上游认可，相关改动也未合入上游。

## 本 Fork 新增

除特别说明外，以下能力均在 `server/`（Fastify + better-sqlite3）中实现：

- **多用户隔离**：每个用户只拥有自己的文档，所有访问按请求鉴权。
- **凭证体系**：用户 API Key（`pk_…`，供 Agent 与 REST API 使用）+ 每文档的编辑/只读令牌（`X-Doc-Token` 请求头、URL `#t=` hash，供网页端使用）。Key 只在创建时显示一次，管理端永远只显示 Key 前缀。
- **配额与存储**：按用户配额（文档数、单文档大小、每日导出次数）。文档、修订、上传资产与导出文件全部放在 `DATA_DIR`——SQLite `app.db`（WAL）、`assets/`、`exports/`。
- **协作**：文档带版本号，写入基于 `baseVersion` 三方合并（冲突返回 409），SSE 推送（`GET /api/docs/:id/events`），批注/评论。
- **远程 MCP**：`POST /mcp`（Streamable HTTP，无状态）提供创建、编辑、导出演示文稿的工具——`create_presentation`、`add_slides`、`update_elements`、`batch_edit`、`get_changes`、`export_presentation` 等；`get_authoring_guide` 分段返回编写规范（`doc/AI_PPT_SCHEMA.md`）。
- **服务端导出**：无头 Chromium（Playwright）复用前端导出运行时渲染 PPTX / PDF / PNG；JSON 导出不走浏览器。
- **管理端**：独立的 `/admin` 管理台（单独的 Vite 入口 `admin.html`，Vue 3 + Naive UI）+ `pptist-admin` CLI，覆盖用户、Key、配额与 SQLite 在线备份。
- **Agent 说明页**：不带 `doc` 参数访问根路径 `/` 时，显示面向 Agent 的 MCP 接入说明页而非编辑器（`src/views/McpHome`）。

## 上游编辑器（核心未改）

- Vue 3 + TypeScript 构建，不依赖 UI 组件库
- 常用 Office PPT 元素：文字、图片、形状、线条、图表、表格、视频、音频、公式
- 幻灯片页面编辑、翻页与元素动画、放映工具、移动端基础编辑与预览
- 浏览器端 PPTX / JSON / 图片 / PDF 导入导出
- 上游自己的在线演示（由上游托管，非本 fork 实例）：<https://pipipi-pikachu.github.io/PPTist/>

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
  pptist:
    url: https://pptist.example.com/mcp   # 换成你部署的公网地址
    headers:
      Authorization: Bearer pk_...        # 真实 Key 由 pptist-admin 签发，只显示一次
```

### 管理台

- 首次管理员密码：用 `ADMIN_INITIAL_PASSWORD` 环境变量（≥10 字符，仅在库里还没有密码时播种），或执行 `pptist-admin passwd`。
- 宿主不方便调整目录权限时，可把 Compose 的 data 绑定挂载改为 Docker named volume（卷名如 `pptist-data`），不要以 root 运行应用。
- 入口：生产 `GET /admin`；Vite 开发模式下 `http://localhost:5173/admin.html`。

## 运维提示

- 生产请走 HTTPS；`ADMIN_SECURE_COOKIES` 依据 `PUBLIC_BASE_URL` 自动判定。仅在可信反代之后设置 `TRUST_PROXY=1`。
- 密钥、用户 Key、`data/` 目录一律不入库——`.env*` 已被 git 忽略，`server/.env.example` 只含占位符。
- `pptist-admin backup <文件>` 可做 SQLite 在线备份；备份计划与异地拷贝由部署者按需自行安排，仓库不自带任何自动备份任务。

## 文档

- 服务端：环境变量、`pptist-admin` CLI、REST/MCP API、部署 —— [server/README.md](server/README.md)
- 上游开发文档 —— [doc/](doc/)（目录与数据结构、画布原理、自定义元素、AIPPT）

## Issues

- 本 fork 相关问题（服务端、MCP、管理台、部署） → [本仓库 Issues](https://github.com/CI2VO5IXZ7/PPTist/issues)
- 上游编辑器问题 → [pipipi-pikachu/PPTist Issues](https://github.com/pipipi-pikachu/PPTist/issues)

## 许可证

[AGPL-3.0](LICENSE) | Copyright © 2020-PRESENT [pipipi-pikachu](https://github.com/pipipi-pikachu)

AGPL-3.0 覆盖整个仓库（含本 fork 新增代码）：如果你修改了代码并通过网络提供给他人使用，必须以 AGPL-3.0 完整公开对应源码、保留版权声明、不得附加额外限制。上游作者另行提供独立商业授权——条款与联系方式见上游 README。本 fork 不是上游官方产品。
