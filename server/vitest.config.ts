import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // e2e/ 为 Playwright 套件（PPTBASE_E2E=1 独立运行），不进 vitest
    exclude: ['e2e/**', '**/node_modules/**'],
  },
})
