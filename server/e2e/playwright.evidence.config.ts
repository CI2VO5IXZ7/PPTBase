// 仓内取证专用 Playwright 配置：与 playwright.config.ts 相同门槛，仅关闭 trace 避免失败用例写 trace.zip 触发 30s fixture teardown 超时。
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { defineConfig, devices } from 'playwright/test'

const OPT_IN = process.env.PPTBASE_E2E === '1'
const testDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  outputDir: process.env.PPTBASE_E2E_OUT ?? '/home/dev/worklogs/pptbase-outlines/authorized-extra-round/playwright-results',
  testDir,
  testMatch: '**/*.spec.ts',
  testIgnore: OPT_IN ? [] : ['**/*.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    permissions: ['clipboard-read', 'clipboard-write'],
    actionTimeout: 10_000,
    trace: 'off',
  },
})
