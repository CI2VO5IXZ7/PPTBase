import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// prosemirror 不允许同时加载多个副本：运行时会报 "multiple versions loaded"，
// 且不同副本的 Plugin、Selection 等类型互不兼容。服务端测试会同时引用
// server/src 与上层 src/utils/outline，可能分别解析到根目录与服务端
// node_modules 中的不同副本，因此必须满足两点：
// 1. server/package.json 中各 prosemirror-* 依赖必须使用与根目录完全一致的
//    精确版本号（不能用 ^ 范围），保证两边安装的是同一版本；
// 2. 下面的 alias 把全部 6 个 prosemirror 包强制解析到服务端 node_modules
//    中的同一份副本，保证整个测试运行只加载一份。
// 另外 prosemirror-model 还靠 package.json 的 overrides 锁定到同一版本，
// 防止 prosemirror-view 在其 node_modules 下嵌套安装不同版本的副本。
// 别名用正则精确匹配包名，不影响 prosemirror-* 的子路径导入或其他模块。
const prosemirrorAlias = (pkg: string) => ({
  find: new RegExp(`^${pkg}$`),
  replacement: fileURLToPath(new URL(`./node_modules/${pkg}`, import.meta.url)),
})

export default defineConfig({
  resolve: {
    alias: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-transform',
      'prosemirror-schema-list',
      'prosemirror-history',
      'prosemirror-view',
    ].map(prosemirrorAlias),
  },
  test: {
    // e2e/ 为 Playwright 套件（PPTBASE_E2E=1 独立运行），不进 vitest
    exclude: ['e2e/**', '**/node_modules/**'],
  },
})
