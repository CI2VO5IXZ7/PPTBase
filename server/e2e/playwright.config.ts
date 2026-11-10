// PPTBase 大纲浏览器验收（Playwright）。
// ⚠️ 显式 opt-in：仅当 PPTBASE_E2E=1 时才执行；否则全部用例跳过。
//    本配置不启动 webServer（应用服务由 fixtures 用 buildApp 直接拉起），
//    import 本文件不会启动任何运行时。
// 前置：1) 根目录 npm run build 产出 dist/（应用静态托管）
//       2) npx playwright install chromium（一次性）
// 运行：PPTBASE_E2E=1 npm --prefix server run e2e
//       或 server/ 下 PPTBASE_E2E=1 npx playwright test -c e2e/playwright.config.ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineConfig, devices } from 'playwright/test'

const OPT_IN = process.env.PPTBASE_E2E === '1'

export default defineConfig({
  // 报告/截图/追踪一律落到仓库外（验收证据目录）
  // 追踪/附件默认写本机 tmp，避免慢挂载目录拖垮 30s fixture teardown（可用 PPTBASE_E2E_OUT 覆盖）
  outputDir: process.env.PPTBASE_E2E_OUT ?? join(tmpdir(), 'pptbase-e2e-artifacts'),
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: '**/*.spec.ts',
  // 未 opt-in 时把全部用例标记为 skip —— 收集（collect/list）也不启动运行时
  testIgnore: OPT_IN ? [] : ['**/*.spec.ts'],
  workers: 1, // 单 worker：每用例独立临时 DATA_DIR，避免 SQLite 竞争
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    permissions: ['clipboard-read', 'clipboard-write'],
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
})
