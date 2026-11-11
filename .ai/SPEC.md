# PPTBase PR#13 实施合同（`.ai/SPEC.md`）

- **仓库**：`https://github.com/CI2VO5IXZ7/PPTBase`
- **关联 PR**：PR #13（`https://github.com/CI2VO5IXZ7/PPTBase/pull/13`）
- **PR 标题**：`fix: 安全修复、大纲三栏 UX 与默认 E2E 测试基建`
- **当前分支**：`cursor/comment-ops-wait-303e`（状态：`OPEN`，非 draft，未合并，未部署）
- **工作树路径**：`/home/dev/work/pptbase-pr13-aef0f9a`（严禁触碰 `/home/dev/projects/PPTBase` 或 `/home/dev/projects/PPTist`）
- **合同性质**：按 2026-11-11 14:49（Asia/Shanghai）生效的新工作流起草的仓库内规范合同（`.ai/SPEC.md`），**供本人审阅确认后方可执行实现与推送**；本文件本身不构成自动推送、拉取评审、合入或上机部署的许可。
- **核阅修订**：正文由 host 上 agy `gemini-4-argon-high` 于 2026-11-11 15:00:49（Asia/Shanghai）起草（`conversation_id` `95c50e5e-ff1c-4e9b-83e3-79c07233e48d`，`AGY_EXIT=0`，`status=SUCCESS`）。火泷果对照工作树 `bccccbb5f7d841aac0a9412bce13a94b31837863` 与 `f91a4970..d222df66` 的实际文件清单，修订了增量白名单、全量文件表，以及 `imageAttrsTr` / `cloneDraftBody` 等函数的所在文件；目标、排除项、基线建议、测试门禁与 PR 纪律的意图未改。

---

## 1. 目标与排除项

### 1.1 目标（Goals）

在已审阅通过的页面方案（`PAGE_DESIGN.md`）、文件级实施计划（`IMPLEMENTATION_PLAN.md`）、原仓外授权范围（`IMPLEMENTATION_CONTRACT.md`）以及历次已核实返修项（`PR13-STAGE-CONTRACT.md` 与 GitHub Copilot 评审 `5854489365`）基础上，按新工作流收口 PR #13 的全部交付物并通过门禁验证：

1. **大纲三栏协作 UX（`WPK-OUTLINE-UX`）**：
   - 保持已认可的桌面端（`≥860px`）三栏布局（左栏只读标题导航 `OutlineNavigator.vue`、中栏编辑器 `OutlineEditor.vue`、右栏批注侧栏 `CommentsPanel.vue`）与窄屏（`<860px`）顶栏抽屉等价布局，提供初始化骨架屏、加载失败重试（`sync.init()`）及空文档引导。
   - 状态条组件 `OutlineWorkflowStatus.vue` 将「用户确认（`approval`）」、「Agent 制作来源（`generation`）」与「反馈记录（`submissions`）」**严格分行独立展示**，明确传达「确认大纲 ≠ 生成成功 / 成品已导出」以及「编辑器本地撤销（`history` undo）≠ 撤销确认（`revoke`）」。
   - 使用受控弹窗 `CommentComposerModal.vue` 与 `LinkModal.vue` 替代原生 `window.prompt`，统一由父壳 `src/views/Outline/index.vue` 挂载调度。
   - 支持工具栏顶层单块「上移 / 下移」（调用既有 `moveBlock` op）：仅移动当前选区所在的顶层单块，非顶层/嵌套列表内禁用且不自动提升；严格复用 `submitGate.ts`（`dirty` / `uploadsPending` / IME 合成 / 待决队列）门禁，保证「先 `flush` 成功 → 获取最新 `version` → 再发 `moveBlock` ops」；图片上传中禁止移动并按队列安全插图。
   - 导航、批注、链接、块移动、确认审批均绑定当前文档与最近 `blockId` 祖先；确认审批严格绑定已审版本。
   - **图片属性按 `blockId` 重映射（Copilot 评审 `5854489365` 已核实项 1）**：`src/utils/outline/imageOps.ts` 中的 `imageAttrsTr` / `imageBlockPos` / `remapImageSel` 必须按 `blockId` 定位目标节点；`OutlineEditor.vue` 的 `applyImageAttrs` 必须使用上述函数，并在本地 `docChanged` 与远端 `props.content` 触发 `view.updateState` 之后都执行 `remapImageSel`；若找不到对应 `blockId` 则立即关闭图片属性面板，严禁把属性写到另一张图片上。
   - **冲突备份快照作废与刷新门禁（Copilot 评审 `5854489365` 已核实项 2 + 历史返修项 6）**：CAS 409 冲突时锁定编辑，展示人读说明，提供「复制草稿 JSON（`copyDraft`）」与「下载草稿 JSON（`downloadDraft`）」；备份时经 `src/utils/outline/editorGuards.ts` 的 `cloneDraftBody` 保存快照；冲突态下若本地正文发生任何变化（含 `onDocJson`，不必等到 steps 入队）立即通过 `noteLocalConflictEdit` 作废已备份标志；`downloadDraft()` 必须在可验证地成功下载当前草稿并经 `sameDraftBody` 复核后才解锁刷新按钮，且延后释放 Blob URL（`revokeObjectURL`）；`onDiscardDraft()`（刷新为最新版本）必须先执行 `flushNow()`，再通过 `conflictRefreshDecision` + `sameDraftBody` 判定是否允许执行 `resolveConflict()`。

2. **依赖与静态服务安全（`WPK-SECURITY-DEPS` 已并入同一 PR 的范围）**：
   - 保持 `server/src/app.ts` 中 `normalizeRequestPath` 在剥离查询串与百分号解码后，对 `.` 与 `..` 点段做规范化，确保 `/./admin.html`、`/%2e/admin.html` 等落到管理页（`/admin`、`/admin/`、`/admin.html`）的请求仍补齐管理页安全响应头（CSP、`X-Frame-Options` 等）；缺失 `/static/*` 返回静态 404，不存在的 `/api/*` 返回 JSON 404，`POST /mcp` 无鉴权头返回 401，路径穿越请求一律拦截。
   - 保持前后端安全依赖升级与 Node.js `>= 20` 兼容性（含 `@fastify/static` 与 `content-disposition` 版本约束、`server/package.json` 显式声明 `image-size@2.0.3`、根包 `vue@3.5.42`、`prosemirror-view@1.42.3`、`lodash@4.18.0`、`echarts@6.1.0`、`nanoid@5.1.16`、`overrides.shell-quote@1.8.4` 等）。

3. **默认 E2E 与测试基建稳定性**：
   - 保持 Playwright 默认配置位于 `server/e2e/playwright.config.ts`：`timeout: 30000`、`retries: 0`、`trace: 'retain-on-failure'`。
   - 保持页面拆卸时释放 SSE / Vue 实例；`server/e2e/outline.spec.ts` 例 3/4 先订阅 `POST /api/docs/:id/outline/ops` 再触发点击；例 11/14/17 在 `deleteBlocks` 前先通过 API 准备至少两个顶层块（保持 `200` 断言不放宽）；`server/test/static.test.ts` 的 `afterAll` 保持对 `ctx` 与 `os.tmpdir()` 下独立 sandbox 目录的安全清理守卫。

### 1.2 排除项与硬性禁令（Non-Goals & Exclusions）

1. **严禁新增右键批注**：禁止新增任何右键上下文菜单添加批注，批注仅走既有按钮入口 + `CommentComposerModal.vue`。
2. **严禁实施 P2 项**：不创建 `src/views/Outline/ReadablePreviewPanel.vue`（T08），不创建 `server/e2e/outline-navigator.spec.ts`（X08），不在冲突区实现 `readableText` 双栏正文 diff 对照。
3. **严禁越界扩展大纲功能**：不做大纲树拖拽重排（DnD）、不做块拆合向导、不把「标题 + 后随正文」当作整节移动、不在嵌套列表内自动提升块再移动、不做 H1–H3 到幻灯片的自动生成/映射或自动跟随更新、不做大纲内 WYSIWYG 幻灯片缩略图预览、不做三路合并或 OT/CRDT、冲突时严禁自动重放失败的用户 ops。
4. **严禁修改后端契约与 Schema**：不改 SQLite 表结构（`server/src/db.ts`）与 migration、不改 `src/utils/outline/schema.ts` 与 `server/src/outline/schema.ts`、不改 CAS（`version` / `contentVersion` / 409）协议语义、不改 SSE `event: outline`、不改 REST/MCP 路由签名与请求/响应体结构、不改确认三段凭证与 `sourceApprovalId` 门禁。
5. **严禁未授权改动依赖与 Lockfile**：**未获本人当次明确授权引入新依赖时，严禁修改 `package.json`、`package-lock.json`、`server/package.json`、`server/package-lock.json`**。禁止升级 ProseMirror 2.x、禁止默认升级 Vite 8.x、禁止修改 `Dockerfile` 基础镜像 tag、禁止通过将 `README.md` 的 Node.js 要求改为 `>= 22` 来规避依赖引擎检查。
6. **严禁削弱已认可布局与测试门禁**：不削弱已认可的大纲三栏布局；不放宽 Playwright 默认 30000ms 超时、不加 `skip`、不放宽或删除例 11/14/17 等业务断言；不设置 `PPTBASE_E2E_OUT`（若环境变量存在必须 `unset`）。
7. **严禁提交生成物与仓外敏感文件**：禁止把 `dist/`、凭据、真实生产 URL、令牌、日志、截图、审核原文、临时探针、仓外计划文档提交进仓库。
8. **严禁使用 Cloud、严禁擅自新开 PR / 合并 / 部署**：禁止使用任何 Cloud Agent；禁止 `git add .`；禁止 `force-push` / `rebase` / `amend` 已推送提交；禁止擅自合并或部署；除非本人明确选择备选拆分方案，否则禁止新开 PR。

---

## 2. 历史偏离说明与基线建议（供本人确认）

### 2.1 历史偏离事实（必须显式记录）

原仓外计划规定 `WPK-SECURITY-DEPS`（依赖安全修复）与 `WPK-OUTLINE-UX`（大纲前端体验）应分属**两张独立 PR**。但在实际执行历史中，这两部分改动连同默认 E2E 测试基建修复**已经合并提交在同一张 PR #13（分支 `cursor/comment-ops-wait-303e`）并推送到 GitHub**：

- `base / master` SHA：`f91a4970d58df56126efc8f490d37e55cc447b9f`
- GitHub PR #13 当前已推送 `head` SHA：`d222df66a58e983233329c50ceb4ee040246c2eb`
- 本地工作树（`/home/dev/work/pptbase-pr13-aef0f9a`）未推送提交 SHA：`bccccbb5f7d841aac0a9412bce13a94b31837863`（父提交为 `d222df66`，改动 7 个文件 `+348/-24`，专门修复 Copilot 评审 `5854489365` 中核实成立的「图片属性按 `blockId` 重映射」与「冲突备份快照在本地编辑时立即作废」两项问题）。

### 2.2 基线方案对比与建议（严禁擅自丢弃已推送工作）

| 方案 | 基线起点 | 处理方式 | 风险与成本评估 | 建议等级 |
|------|----------|----------|----------------|----------|
| **方案 A（推荐）：以已推送 `d222df66` 为已交付基线，增量纳入 `bccccbb5`** | GitHub 已推送 head `d222df66a58e983233329c50ceb4ee040246c2eb` | **保留全部已推送成果**，不新开 PR，不回退分支；将本地未推送的 `bccccbb5` 作为待纳入的最小剩余实现，在本合同获本人确认后，按白名单校验与黑盒隔离复测通过后快进推送到同一张 PR #13，并另提交 `.ai/SPEC.md` | 改动最小（相对 `d222df66` 仅 7 个源码/测试文件增量 + `.ai/SPEC.md`），不改动 lockfile，保留既有 PR #13 评审上下文与已通过验证的工作 | **强烈推荐（默认执行路径，待本人确认）** |
| **方案 B（备选 1）：从 `master` 完全重写** | `master` 基线 `f91a4970d58df56126efc8f490d37e55cc447b9f` | 丢弃或旁置 `d222df66` 与 `bccccbb5` 的既有提交，从 `f91a497` 按本合同全量白名单重新编码安全修复、大纲三栏 UX、E2E 测试基建及全部返修项 | 丢弃大量已完成且经多轮验证的工作，重跑全量编码与依赖树核验耗时长，且若推回原分支会涉及重写历史 | **不推荐**（仅当本人明确要求丢弃既有提交重写时采用） |
| **方案 C（备选 2）：按原计划拆分为两张独立 PR** | `master` 基线 `f91a4970d58df56126efc8f490d37e55cc447b9f` | 将 PR #13 中混合的 `WPK-SECURITY-DEPS` 与 `WPK-OUTLINE-UX` 拆分为两个独立分支与两张 PR | 需新开 PR 并重做分支切分与双份审查，**必须本人明确书面确认要求拆分时才允许执行** | **备选（须本人专门确认）** |

---

## 3. 允许修改的文件白名单与禁止改动路径

### 3.1 增量收口白名单（推荐方案 A：相对已推送基线 `d222df66`）

在推荐方案 A 下，**未授权引入任何新依赖，严禁修改任何 `package.json` 或 lockfile**。相对 `d222df66` 仅允许包含本合同文件及 `bccccbb5` 已经改动的业务源码与测试文件：

1. `.ai/SPEC.md`（新增：本实施合同）
2. `src/utils/outline/imageOps.ts`（修改：`imageBlockPos`、`imageAttrsTr`、`remapImageSel` 按 `blockId` 定位）
3. `src/utils/outline/editorGuards.ts`（修改：`cloneDraftBody`、`sameDraftBody`、`noteLocalConflictEdit`、`conflictRefreshDecision`、`CONFLICT_REBACKUP_MESSAGE`；`conflictRefreshAllowed` 语义保持不变）
4. `src/views/Outline/OutlineEditor.vue`（修改：`applyImageAttrs` 先经 `remapImageSel` / `imageAttrsTr`；本地 `docChanged` 与远端 `props.content` 在 `view.updateState` 之后按 `blockId` 重映射，找不到则关闭面板）
5. `src/views/Outline/index.vue`（修改：冲突备份 `cloneDraftBody` 快照、本地编辑经 `noteLocalConflictEdit` 作废备份标志、`onDiscardDraft` 先 `flushNow()` 再通过 `conflictRefreshDecision` + `sameDraftBody` 决定是否 `resolveConflict`、`downloadDraft` 复核与延后 revoke）
6. `src/utils/__tests__/outline-image-attrs.test.ts`（新增：按 `blockId` 重映射图片属性/选区的单测）
7. `src/utils/__tests__/outline-conflict-preserve.test.ts`（新增：冲突快照克隆、本地编辑作废备份、`conflictRefreshDecision` 回归单测）
8. `server/test/outline-thread-deco.test.ts`（修改：`imageAttrsTr` 改为按 `blockId` 调用）

方案 A **不要求**为收口去改 `src/hooks/useOutlineSync.ts`、`src/utils/outline/syncCore.ts` 或 `server/e2e/outline.spec.ts`。例 17 的既有下载校验与再次冲突须重新确认等断言保持不放宽；冲突态本地编辑立即作废备份由上述单元测试覆盖。

### 3.2 PR #13 相对 `master`（`f91a497`）的实际文件范围（含已推送范围及备选方案 B 边界）

下列为 `f91a497..bccccbb5` 的实际变更文件，外加本合同。若核查整张 PR 或采用备选方案 B 重建，允许范围以此表为限，不得额外扩大。方案 A 后续收口中，对已在 `d222df66` 落地且未列入 3.1 的文件保持原样，尤其是 4 个依赖清单与锁文件。

| 类别 | 文件路径 | 相对 master | 职责范围 |
|------|----------|-------------|----------|
| **合同规范** | `.ai/SPEC.md` | 新增（待提交） | 仓库内实施合同 |
| **大纲页面与组件** | `src/views/Outline/index.vue` | 修改 | 页面壳、三栏响应式容器、事件总线、顶层移动门禁、冲突保全与下载/复制/刷新门禁 |
| **大纲页面与组件** | `src/views/Outline/OutlineEditor.vue` | 修改 | ProseMirror 编辑器、工具栏、上传排队、图片属性按 `blockId` 重映射 |
| **大纲页面与组件** | `src/views/Outline/CommentsPanel.vue` | 修改 | 批注侧栏，向父级 `emit('requestAddComment')`，无右键批注 |
| **大纲页面与组件** | `src/views/Outline/OutlineNavigator.vue` | 新增 | H1–H3 只读导航树，点击只 `emit('navigate', blockId)` |
| **大纲页面与组件** | `src/views/Outline/OutlineNavigatorRow.vue` | 新增 | 导航树行渲染 |
| **大纲页面与组件** | `src/views/Outline/OutlineWorkflowStatus.vue` | 新增 | 确认、制作来源、反馈分行状态条 |
| **大纲页面与组件** | `src/views/Outline/CommentComposerModal.vue` | 新增 | 批注输入弹窗（替代 `window.prompt`） |
| **大纲页面与组件** | `src/views/Outline/LinkModal.vue` | 新增 | 链接输入弹窗（替代 `window.prompt`） |
| **大纲工具与状态** | `src/utils/outline/navigatorTree.ts` | 新增 | 纯函数：从大纲文档解析导航树 |
| **大纲工具与状态** | `src/utils/outline/imageOps.ts` | 修改（仅 `bccccbb5`） | `imageBlockPos` / `imageAttrsTr` / `remapImageSel` |
| **大纲工具与状态** | `src/utils/outline/editorGuards.ts` | 新增，并在 `bccccbb5` 续改 | `cloneDraftBody` / `sameDraftBody` / `noteLocalConflictEdit` / `conflictRefreshDecision` 等 |
| **大纲工具与状态** | `src/utils/outline/imageInsert.ts` | 新增 | 移动期间插图排队 |
| **大纲工具与状态** | `src/utils/outline/blobRevoke.ts` | 新增 | 草稿 Blob URL 延后释放 |
| **大纲工具与状态** | `src/utils/outline/linkHref.ts` | 新增 | 链接 href 校验 |
| **大纲工具与状态** | `src/utils/outline/selectionMeta.ts` | 新增 | 选区元数据 |
| **大纲工具与状态** | `src/utils/outline/anchors.ts` | 修改 | 锚点相关（不改协议字段） |
| **大纲工具与状态** | `src/utils/outline/syncCore.ts` | 修改（已在 `d222df66` 落地） | CAS 同步核心；冲突时禁止自动重放失败的用户 move。方案 A 不再改此文件 |
| **前端单元测试** | `src/utils/__tests__/outline-navigator-tree.test.ts` | 新增 | 导航树纯函数单测 |
| **前端单元测试** | `src/utils/__tests__/outline-image-attrs.test.ts` | 新增（`bccccbb5`） | 图片属性按 `blockId` 重映射单测 |
| **前端单元测试** | `src/utils/__tests__/outline-conflict-preserve.test.ts` | 新增（`bccccbb5`） | 冲突备份作废与刷新决策单测 |
| **前端单元测试** | `src/utils/__tests__/outline-image-insert.test.ts` | 新增 | 插图队列单测 |
| **前端单元测试** | `src/utils/__tests__/outline-blob-revoke.test.ts` | 新增 | Blob 延后释放单测 |
| **前端单元测试** | `src/utils/__tests__/outline-selection-meta.test.ts` | 新增 | 选区与既有守卫函数回归 |
| **后端静态与安全** | `server/src/app.ts` | 修改 | `normalizeRequestPath` 解码与点段归一化后再匹配管理页补安全头 |
| **后端与 E2E 测试** | `server/test/static.test.ts` | 修改 | 路径穿越、点段管理页安全头、鉴权与 `afterAll` 清理守卫 |
| **后端与 E2E 测试** | `server/test/image-size-boundary.test.ts` | 新增 | `image-size` 边界回归 |
| **后端与 E2E 测试** | `server/test/e2e.test.ts` | 修改 | 与默认 E2E 基建协同的既有测试调整 |
| **后端与 E2E 测试** | `server/test/outline-thread-deco.test.ts` | 修改（仅 `bccccbb5`） | `imageAttrsTr` 按 `blockId` 调用 |
| **后端与 E2E 测试** | `server/e2e/outline.spec.ts` | 修改（已在 `d222df66` 落地） | 默认 17 项 E2E；方案 A 不再改此文件，断言不放宽 |
| **后端与 E2E 测试** | `server/e2e/fixtures.ts` | 修改 | E2E 夹具 |
| **后端与 E2E 测试** | `server/e2e/playwright.config.ts` | 修改 | 默认 `timeout: 30000`、`retries: 0`、`trace: 'retain-on-failure'` |
| **依赖清单与锁文件** | `package.json`、`package-lock.json`、`server/package.json`、`server/package-lock.json` | 修改（已在 `d222df66` 落地） | **方案 A 后续收口未获新依赖授权，严禁再修改这 4 个文件** |

说明：仓库中已有但未出现在 `f91a497..bccccbb5` 的文件（如 `src/hooks/useOutlineSync.ts`、`src/utils/outline/submitGate.ts`、`src/store/outline.ts`，以及既有单测 `outline-sync-core.test.ts` / `outline-submit-gate.test.ts` / `outline-steps.test.ts` / `entry.test.ts`）**不是方案 A 的改动范围**。方案 A 下保持这些文件原样；测试门禁仍要求现有测试全部通过。

### 3.3 严禁修改或新增的路径黑名单（Blacklist）

- **严禁新增的 P2 文件**：`src/views/Outline/ReadablePreviewPanel.vue`、`server/e2e/outline-navigator.spec.ts`。
- **严禁修改的前端契约与入口**：`src/App.vue`、`src/utils/outline/schema.ts`、`src/services/outline.ts`、`src/services/document.ts`、`src/types/outline.ts`。
- **严禁修改的后端业务与数据库层**：`server/src/db.ts`、`server/src/outline/schema.ts`、`server/src/outline/service.ts`、`server/src/outline/ops.ts`、`server/src/routes/outline.ts`、`server/src/mcp/outline.ts`、`server/src/events.ts`。
- **严禁修改的构建与运行时声明**：`Dockerfile`、`README.md`（不得把 Node.js `>= 20` 改为 `>= 22`）。
- **严禁入库的目录与文件**：`dist/`、任何日志/截图/trace 产物、凭据/Token、仓外合同与设计稿。

---

## 4. 组件与函数级行为规范及 Done When

### 4.1 `src/views/Outline/index.vue`（父壳组件）

- **组件职责与子组件装配**：
  - 挂载并协调 `OutlineWorkflowStatus`、`OutlineNavigator`、`OutlineEditor`、`CommentsPanel`、`CommentComposerModal`、`LinkModal`。不挂载 `ReadablePreviewPanel`，不与 `CommentsPanel` 形成循环 import。
  - 桌面端（`≥860px`）保持左导航（约 220px 可折叠）、中编辑器、右批注（约 300px 可折叠）三栏布局；窄屏（`<860px`）提供顶栏 `[树]` 与 `[批注]` 抽屉切换。
  - 加载态与错误重试：`sync.init()` 期间展示骨架屏并隐藏/禁用确认按钮；当加载失败时展示错误提示与 `[重试]` 按钮（点击重新调用 `sync.init()`）；组件卸载时确保关闭 SSE 连接并清理定时器与 Vue 响应式副作用。
- **核心事件与函数行为**：
  - **导航滚动转发**：响应 `OutlineNavigator` 的 `navigate(blockId)` 事件时，仅调用 `editorRef.scrollToBlockId(blockId)`，**严禁修改文档 JSON、严禁置 `dirty = true`、严禁触发 `PATCH` 或 `postOutlineOps`**。
  - **批注与链接弹窗调度**：响应 `CommentsPanel` 的 `requestAddComment({ anchor })` 打开 `CommentComposerModal`，提交时调用 `onThreadOp`；响应 `OutlineEditor` 的 `requestLinkModal({ blockId, href })` 打开 `LinkModal`。批注、链接、移动、导航、确认审批全部绑定当前文档 ID，切换文档时清空跨文档残留状态。
  - **顶层单块移动（响应 `OutlineEditor` 的 `requestMove({ blockId, direction: 'up' | 'down' })`）**：
    1. 先通过 `submitGate` 检查：若存在未保存正文（`dirty`）、图片上传中（`uploadsPending`）、IME 合成中或未完成 steps 队列，阻止发出移动请求。
    2. 门禁通过后，必须先执行 `flush` / `flushNow()` 直至成功，并取回服务端最新 `version`。
    3. 携带最新 `version` 调用 `postOutlineOps` 发送 `moveBlock` op（仅移动该顶层 `blockId` 单块）。
    4. 若返回 CAS `409`，进入冲突保全态，**严禁自动重放**该次失败的 `moveBlock`。
  - **冲突保全、草稿快照作废与刷新门禁（函数：`copyDraft`、`downloadDraft`、`onDiscardDraft`、`onDocJson`）**：
    1. 当发生 CAS `409` 时锁定编辑器，显示人读冲突说明（明确说明保留本地草稿快照、刷新将替换为服务端最新版本、不会自动重放失败的 ops）。
    2. **草稿备份快照记录**：在 `copyDraft()` 成功写入剪贴板、或 `downloadDraft()` 成功触发下载时，调用 `cloneDraftBody` 保存当时的本地草稿正文快照，并将已备份标志置为有效。
    3. **冲突态本地编辑立即作废备份**：在冲突态下，一旦本地正文发生任何修改（包括 `onDocJson` 收到新文档内容时，**不必等到 steps 入队**），必须调用 `noteLocalConflictEdit`；若当前正文与已备份快照不再一致（`!sameDraftBody(...)`），立即作废已备份标志，使 `[刷新为最新版本]` 按钮重新禁用。
    4. **`downloadDraft()` 成功校验与延后释放**：严禁在点击下载后无条件把已备份标志设为有效；必须在下载流程无异常完成后，通过 `sameDraftBody` 复核当前草稿与备份快照一致，才解锁刷新按钮，且必须**延后执行 `URL.revokeObjectURL`**；若下载失败，刷新按钮保持禁用。
    5. **`onDiscardDraft()`**：点击后必须先调用 `await flushNow()`，随后调用 `conflictRefreshDecision` 结合 `sameDraftBody` 校验当前草稿是否与已保全快照一致；仅当判定允许刷新时才调用 `resolveConflict()` 用远端最新文档覆盖编辑器。

### 4.2 `src/views/Outline/OutlineEditor.vue` 与 `src/utils/outline/imageOps.ts`

- **暴露接口与事件**：
  - `scrollToBlockId(blockId)`：仅将 ProseMirror 选区/滚动容器定位至对应 `blockId` 节点，不改动文档内容，不产生 dirty 状态。
  - `selectedBlockId`：从当前选区向上查找最近的 `blockId` 祖先节点（绑定当前文档）。
  - `isTopLevelSelection`：精确判断当前选区是否处于顶层单块。当选区位于嵌套列表项或非顶层块内、或位于首个顶层块上移 / 末个顶层块下移边界、或处于图片上传中时，工具栏 `[上移]` / `[下移]` 必须禁用，并给出「只支持移动顶层块」提示，**严禁自动提升嵌套列表项**。
  - `emit('requestLinkModal', { blockId, href })` 与 `emit('requestMove', { blockId, direction })`：不直接 import 弹窗组件，不绕过父级门禁直接调用 `postOutlineOps`。
- **图片上传排队**：图片上传期间禁止移动块，待插图任务按队列顺序安全插入。
- **图片属性按 `blockId` 定位与重映射（`imageOps.ts` 的 `imageAttrsTr`、`imageBlockPos`、`remapImageSel`；编辑器中的 `applyImageAttrs`）**：
  - 修改图片节点属性时，严禁盲目信任旧的数字 `pos`；必须按目标图片的 `blockId` 在当前文档中定位并校验一致后才构造并派发 transaction。
  - 在本地编辑产生 `docChanged` 之后，以及远端 `props.content` 更新并调用 `view.updateState(...)` 之后，都必须调用 `remapImageSel` 按 `blockId` 重新定位。
  - 若找不到该 `blockId` 对应的图片节点，必须立即关闭图片属性面板 / 清空图片选中状态，**严禁把图片属性误写到另一张图片上**。

### 4.3 `src/views/Outline/OutlineNavigator.vue` 与 `src/utils/outline/navigatorTree.ts`

- `navigatorTree.ts` 提供纯函数，解析 H1–H3 标题层级、标题文本与 `blockId`；不修改 `src/utils/outline/schema.ts`。
- `OutlineNavigator.vue` 接收文档内容与当前 `activeBlockId`，发出 `emit('navigate', blockId)`；支持章节折叠/展开与当前块高亮；空文档时显示「（空）」；不提供拖拽手柄；只读模式下仍允许点击滚动且不改文档。

### 4.4 `src/views/Outline/OutlineWorkflowStatus.vue`

- 接收 `approval`、`generation`、`submissions`，纯只读展示。
- 必须将确认、制作来源、反馈**分成独立行展示**，禁止合并为单一「已完成」或「生成成功」指示灯。
- 确认有效时显示「确认：大纲已确认」，启用「撤销确认」。确认后修改正文导致确认过时时，第一行显示「确认：已过时，请重新确认」；若制作来源已失效，第二行独立显示「制作来源：已失效」，并提示已生成的幻灯片不会自动跟随修改。
- 点击「撤销确认」只清空确认与制作来源状态，**正文内容保持不变**。按钮文案必须写为「撤销确认」，不得简写为「撤销」。
- Owner（Agent Key）角色下明确提示确认/提交反馈/撤销确认须由用户本人操作，Agent 不能代点。

### 4.5 `CommentsPanel.vue`、`CommentComposerModal.vue`、`LinkModal.vue`

- `CommentsPanel.vue`：点击添加批注按钮时向父级 `emit('requestAddComment', { anchor })`，不提供右键菜单批注。
- `CommentComposerModal.vue`：受控打开，字数上限对齐既有大纲限制，提交或取消。
- `LinkModal.vue`：受控打开，保持与既有链接逻辑一致的 `https://` URL 校验。

### 4.6 同步、门禁与冲突纯函数

- `src/utils/outline/editorGuards.ts`（方案 A 收口的函数家园）：导出 `cloneDraftBody`、`sameDraftBody`、`noteLocalConflictEdit`、`conflictRefreshDecision`、`CONFLICT_REBACKUP_MESSAGE`；`conflictRefreshAllowed` 的既有语义不得改变。
- `src/utils/outline/syncCore.ts`：保持 CAS `version` / `contentVersion` / `409` 核心状态机不变；冲突时严禁自动重放用户触发的 `moveBlock` 等 ops。方案 A 下不要求再改此文件。
- `src/hooks/useOutlineSync.ts` 与 `src/utils/outline/submitGate.ts`：保持既有 `init` / `flush` / `flushNow` / `resolveConflict`，以及确认、反馈、顶层块移动的 `dirty` / `uploadsPending` / IME / 待决队列门禁。方案 A 下不要求再改这些文件。

### 4.7 `server/src/app.ts`（函数 `normalizeRequestPath`）与安全依赖约束

- 在剥离 URL 查询串并完成百分号解码后，必须规范化路径中的 `.` 与 `..` 段，确保 `/./admin.html`、`/%2e/admin.html` 等仍匹配管理页并附带完整安全响应头。
- 严禁削弱路径穿越保护：逃出静态根目录的 `..`（含百分号编码）必须被拒绝；缺失的 `/static/*` 返回 404；未知 `/api/*` 返回 JSON 404；`POST /mcp` 缺少 Bearer 鉴权头返回 401。
- `server/package.json` 必须显式声明 `image-size@2.0.3`，不依赖根目录 hoisting。`server/package-lock.json` 中 `@fastify/static` 及其传递依赖 `content-disposition` 必须兼容 `README.md` 声明的 `Node.js >= 20`（不得残留要求 `node: >=22` 的 `content-disposition@3.0.0`，且不得通过篡改文档 Node 版本要求来规避）。这些依赖约束已在 `d222df66` 落地，方案 A 不得再改 lockfile。

### 4.8 测试夹具与清理守卫

- `server/test/static.test.ts` 的 `afterAll`：仅在测试上下文已成功创建时关闭应用；只清理 `os.tmpdir()` 下有效的 sandbox 路径，严禁对空目录路径执行危险删除。
- `server/e2e/outline.spec.ts`（已在 `d222df66` 落地，方案 A 不要求再改，断言不放宽）：
  - 例 3、例 4：在点击前先订阅 `POST /api/docs/:id/outline/ops`。
  - 例 11、例 14、例 17：在调用 `deleteBlocks` 前先通过 API 准备至少两个顶层块，删完后仍至少保留一块，且严禁放宽 `status() === 200` 断言。
  - 例 17：验证冲突横幅、下载失败时刷新按钮保持禁用、成功下载内容含标记与 `"content"` 后才解锁、再次冲突必须重新确认后才可刷新。

### 4.9 总体 Done When 判据

当且仅当以下条件全部满足时，本合同视为实现完成（Done）：

1. **范围合规**：`git status` 与 `git diff` 严格落在第 3 节允许的文件白名单内；推荐方案 A 下，相对 `d222df66` 只出现 3.1 所列文件，4 个依赖清单与锁文件零改动；无 `dist/`、无日志、无临时文件或凭据。
2. **功能与返修闭环**：第 4 节列出的行为均已完备，特别是 `imageOps.ts` / `OutlineEditor.vue` 的按 `blockId` 重映射，以及 `editorGuards.ts` / `index.vue` 的冲突备份立即作废与 `onDiscardDraft` 先 `flushNow()`。
3. **测试门禁全绿**：第 5 节规定的前端单测、前端类型检查、前端构建、Server 单测、Server 类型检查及默认 17 项 Playwright E2E 全部真实运行且退出码为 `0`。
4. **隔离验证与审查闭环**：轻量模型黑盒隔离测试记录为 PASS（样本哈希一致），且在本人授权推送后通过 GitHub Copilot 源码审查（无未解决的 Bug / 安全隐患 / 逻辑错误，Nitpick 已汇总交本人）。

---

## 5. 测试门禁与必跑命令

### 5.1 运行环境纪律

- 所有测试必须在独立临时数据库、临时资产目录与 loopback 空闲端口上运行；严禁挂载生产数据目录，严禁暴露宿主 Docker socket，严禁影响无关容器与服务。
- 运行 E2E 前必须确认未设置 `PPTBASE_E2E_OUT`（若环境变量存在，必须先取消该变量）。
- 构建验证生成的 `dist/` 仅用于检验编译通过，验证后不得提交入库。

### 5.2 必跑测试命令清单（全部要求退出码 `0`）

| 序号 | 检查项 | 执行命令 | 门禁要求 |
|------|--------|----------|----------|
| 1 | 前端单元测试 | 在仓库根目录执行 `npm test`（即 `node --test src/utils/__tests__/*.test.ts`） | 现有前端单测全部通过，必须包含 `outline-image-attrs.test.ts` 与 `outline-conflict-preserve.test.ts` |
| 2 | 前端类型检查 | `npm run type-check`（`vue-tsc --build --force`） | 零类型错误 |
| 3 | 前端构建验证 | `npm run build` | 构建成功，且生成的 `dist/` 不入 Git |
| 4 | Server 单元测试 | `npm --prefix server test` | 全部通过，必须包含 `server/test/static.test.ts`、`server/test/image-size-boundary.test.ts` 与 `server/test/outline-thread-deco.test.ts` |
| 5 | Server 类型检查 | `npm --prefix server run type-check` | 零类型错误 |
| 6 | 默认 17 项 E2E 测试 | `unset PPTBASE_E2E_OUT` 后，在 `server/` 目录执行 `npm run e2e`（即 `playwright test -c e2e/playwright.config.ts`） | 默认 17 项 E2E 全部 PASS，退出码 `0` |

### 5.3 严禁放宽的测试门禁红线

1. **禁止放宽超时与重试**：`server/e2e/playwright.config.ts` 必须保持默认 `timeout: 30000`、`retries: 0`、`trace: 'retain-on-failure'`。
2. **禁止跳过或弱化断言**：严禁使用 `test.skip`、`test.fixme`、删除断言、扩大单步 timeout，或将例 11/14/17 的 `status() === 200`、CAS `409`、MCP `401`、静态 `404` 及例 17 下载文件内容/按钮禁用状态等业务断言改松来冒充通过。

---

## 6. 提交、PR、Copilot 审查、合入与上机纪律

1. **Git 提交卫生**：
   - **严禁使用 `git add .` 或 `git add -A`**：必须对照第 3 节白名单逐文件显式加入暂存区。
   - **严禁 `force-push`、变基、对已推送提交进行 amend，或硬重置已推送历史**。
   - 提交前必须检查暂存区，确保不含 `dist/`、凭据、真实生产 URL、令牌、测试日志、截图、审核原文或临时探针。
2. **PR 纪律**：
   - 继续使用现有 PR #13（分支 `cursor/comment-ops-wait-303e`），**禁止新开 PR**（除非本人明确确认选择第 2.2 节备选方案 C 进行拆分）。
   - 在本人确认本 `.ai/SPEC.md` 并授权之前，不得向远端推送 `bccccbb5` 或新提交。
3. **黑盒隔离测试与 GitHub Copilot 审查分工**：
   - **黑盒隔离测试**：使用轻量模型执行黑盒/集成测试验证（核对固定提交样本哈希、白名单合规性与第 5.2 节全部命令退出码），测试者不修改产品源码。
   - **源码级审查**：统一交由 GitHub Copilot 在 PR #13 上针对实际推送的 head 提交进行审查。
   - **Copilot 自动返修上限**：仅当确属 Bug、安全隐患、逻辑错误时才执行自动返修，且最多自动返修 2 轮；每轮仍须遵守本合同文件白名单与测试门禁。
   - **Nitpick 处理原则**：风格、命名、非关键重构建议等一律不自动改码，集中汇总后交由本人决定。
4. **合入与上机纪律**：
   - **禁止建议或擅自执行合并，禁止建议或擅自执行部署/上机**。
   - 即使本地自测、黑盒隔离测试与 GitHub Copilot 审查全部通过，也绝不等于自动获准合并或上线；**合入与上机必须分别等待本人当次明确点名**。
   - 若未来获本人点名执行部署或回滚：回滚仅限切回上一已知良好镜像标记，必须完整保留最新生产数据卷，严禁使用旧数据库文件覆盖新卷。

---

## 7. 实现入口与计费路径

| 维度 | 强制规范 |
|------|----------|
| **唯一实现入口** | 仅限远程开发服务器（host）上的 Cursor CLI，工作树为 `/home/dev/work/pptbase-pr13-aef0f9a` |
| **实现模型** | 当时最新的 Grok fast + high 思考等级（当前精确 ID：`grok-4.7-high-fast`） |
| **Cloud 禁令** | 严禁使用任何 Cloud 入口，除非本人当次明确另行授权 |
| **隔离测试模型** | 轻量模型（仅做黑盒/集成测试是否通过，不改源码；禁止轻量模型对实现代码做风格或重构挑刺；源码审查交 GitHub Copilot） |
| **计费与预算上限** | 仅使用订阅内包含额度，额外付费预算为 0；严禁开启按量付费、严禁使用付费 credits fallback、严禁充值或换号绕过额度限制 |
