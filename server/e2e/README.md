# 大纲浏览器 E2E（Playwright，opt-in）

覆盖原开发计划 §9 全部 13 项浏览器验收。**默认不运行**：需要显式 `PPTBASE_E2E=1`。

## 前置条件

```bash
npm run build                              # 产出 dist/（应用静态托管前端）
npm --prefix server ci                     # 服务端依赖（含 playwright）
npx playwright install chromium            # 首次安装浏览器（仅此一次需联网）
```

## 运行

```bash
cd server
PPTBASE_E2E=1 npx playwright test -c e2e/playwright.config.ts
# 或指定单个用例：
PPTBASE_E2E=1 npx playwright test -c e2e/playwright.config.ts -g "9. 制作门禁"
```

## 结构与隔离

- `fixtures.ts`：每用例 `mkdtemp` 独立 `DATA_DIR`（SQLite+assets），内存随机端口 `buildApp().listen(0)`，测试结束 `app.close()` + 删除该临时目录——**不碰任何真实账号/数据/Key/共享运行时**。
- `outline.spec.ts`：每 `test` 标题前缀对应计划 §9 案例编号 1–13。
- Agent 侧操作经**同一 `/mcp` 端点 + 真实 Streamable HTTP JSON-RPC**（`mcpCall`），REST 操作走对应令牌。
- 未 opt-in 时 `testIgnore` 忽略全部 spec：收集/列表阶段也不启动任何运行时。

## 用例 → 计划 §9 映射

| 用例 | 覆盖 |
|---|---|
| 1 | 零幻灯片大纲直接打开不卡初始化 |
| 2 | 标题/列表/IME 组合事件/撤销重做/保存刷新持久化 |
| 3 | 文字批注前插字锚点保持 + 删除后脱离引用 |
| 4 | 段落/跨段/图片/文档锚点 + 回复/解决/重开/筛选/重叠共存 |
| 5 | 保存失败禁止虚假提交，恢复重试不重复记录 |
| 6 | 提交后编辑：轮次快照不可变 vs 当前稿 |
| 7 | 素材清单 + `get_outline_asset` image 内容块 |
| 8 | Agent 改稿/complete 后网页可见结果，新一轮仍待处理 |
| 9 | 未确认 MCP+REST 双门禁拒绝；确认+sourceApprovalId 可制作 |
| 10 | 正文变/撤销使来源失效；仅评论不失效 |
| 11 | 并发冲突：草稿保留、复制取回、不盲放旧版本 |
| 12 | 只读/伪令牌/他人 Key/跨项目素材权限边界 |
| 13 | 窄屏抽屉、多标签、导航；首页工具列表回归 |

## 明确不覆盖

- 脚本 `CompositionEvent` 仅模拟 IME 的 DOM 事件契约，**不等于系统输入法全链路**；原生中文 IME 需人工用例。
- 浏览器/OS 级真实粘贴板图片（用 `DataTransfer` 构造的 drop/paste 覆盖）。
- Docker/镜像内运行（compose 部署验收另需批准）。
