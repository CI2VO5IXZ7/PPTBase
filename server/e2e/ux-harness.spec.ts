// UX 针对性回归（授权自测；与 14 例 outline.spec 并列，非 P2 X08）
import { test, expect, connectMcp } from './fixtures'

const SHOTS = process.env.UX_HARNESS_SHOTS ?? '/cursor/stores/self/artifacts/pptbase-outline-ux-20261110/screenshots'

const editor = (page: import('@playwright/test').Page) => page.locator('.outline-editor .ProseMirror')

test.describe.configure({ timeout: 90_000 })

test.describe('UX 新增交互', () => {
  test('中文编辑 + 导航 + 批注 Modal + 截图', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('zh-ux')
    await page.request.post(`${server.baseUrl}/api/docs/${doc.docId}/outline`, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    })
    const p = await outlinePage(doc.docId)
    await editor(p).click()
    await p.keyboard.type('中文大纲验收：项目汇报与里程碑')
    await p.waitForResponse(r => r.url().includes('/outline') && r.request().method() === 'PATCH' && r.status() === 200, { timeout: 20_000 })
    await expect(p.locator('.workflow-status')).toContainText('未确认')
    await p.locator('button:has-text("＋ 添加批注")').click()
    await p.locator('.modal-content textarea, textarea').first().fill('示例批注：数字口径需核对')
    await p.locator('.modal-content button:has-text("确定"), button:has-text("确定")').first().click()
    await p.waitForResponse(r => r.url().includes('/outline/ops') && r.status() === 200, { timeout: 15_000 })
    await p.screenshot({ path: `${SHOTS}/ux-zh-nav-comments.png`, fullPage: true })
  })

  test('批注 Modal 空值与超限', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('modal-val')
    await page.request.post(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })
    const p = await outlinePage(doc.docId)
    await p.locator('button:has-text("＋ 添加批注")').click()
    await p.locator('.modal-content button:has-text("确定"), button:has-text("确定")').first().click()
    await expect(p.locator('text=请输入批注内容')).toBeVisible()
    await p.locator('textarea').fill('x'.repeat(2001))
    await p.locator('.modal-content button:has-text("确定"), button:has-text("确定")').first().click()
    await expect(p.locator('text=最多 2000 字')).toBeVisible()
  })

  test('链接 Modal 拒绝 http', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('link')
    await page.request.post(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })
    const p = await outlinePage(doc.docId)
    await editor(p).click()
    await p.keyboard.type('linktext')
    await p.keyboard.press('Control+Home')
    await p.keyboard.down('Shift')
    for (let i = 0; i < 8; i++) await p.keyboard.press('ArrowRight')
    await p.keyboard.up('Shift')
    await p.locator('.outline-toolbar button:has-text("🔗")').click()
    await p.locator('.modal-content input[type="url"], input[type="url"]').first().fill('http://bad.example')
    await p.locator('.modal-content button:has-text("确定"), button:has-text("确定")').first().click()
    await expect(p.locator('text=请使用 https://')).toBeVisible()
  })

  test('导航点击不提升 version', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('nav-only')
    await page.request.post(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })
    const p = await outlinePage(doc.docId)
    await editor(p).click()
    await p.keyboard.type('第一段\n第二段')
    const v0 = (await (await page.request.get(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })).json()).version
    await p.locator('.nav-entry').first().click()
    const v1 = (await (await page.request.get(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })).json()).version
    expect(v1).toBe(v0)
  })

  test('冲突门闩：未 ack 禁刷新；复制后 JSON 完整', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('conflict-gate')
    const hdr = { authorization: `Bearer ${server.apiKey}` }
    const post = (path: string, data?: unknown) => page.request.post(`${server.baseUrl}${path}`, { headers: { ...hdr, 'content-type': 'application/json' }, data })
    await post(`/api/docs/${doc.docId}/outline`, {})
    const p = await outlinePage(doc.docId)
    await editor(p).click()
    await p.keyboard.type('LOCAL-MARKER-409')
    await p.locator('.ProseMirror').evaluate(el => {
      const win = (el.ownerDocument?.defaultView ?? globalThis) as { CompositionEvent?: new (t: string, i: { data?: string }) => Event }
      el.dispatchEvent(new (win.CompositionEvent ?? Event)('compositionstart', { data: '' }))
    })
    const cur = await (await page.request.get(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: hdr })).json()
    await post(`/api/docs/${doc.docId}/outline/ops`, { baseVersion: cur.version, requestId: 'ux-c1', ops: [{ op: 'deleteBlocks', blockIds: [cur.content.content[0].attrs.blockId] }] })
    await p.locator('.ProseMirror').evaluate(el => {
      const win = (el.ownerDocument?.defaultView ?? globalThis) as { CompositionEvent?: new (t: string, i: { data?: string }) => Event }
      el.dispatchEvent(new (win.CompositionEvent ?? Event)('compositionend', { data: '' }))
    })
    await expect(p.locator('.banner.conflict')).toBeVisible({ timeout: 15_000 })
    await p.screenshot({ path: `${SHOTS}/ux-conflict-locked.png`, fullPage: true })
    const refresh = p.locator('button:has-text("刷新为最新版本")')
    await expect(refresh).toBeDisabled()
    await p.locator('button:has-text("复制草稿内容")').click()
    const clip = await p.evaluate(() => navigator.clipboard.readText())
    expect(clip).toContain('LOCAL-MARKER-409')
    expect(clip).toContain('"steps"')
    await expect(refresh).toBeEnabled()
  })

  test('确认后改正文 → 确认过时横幅', async ({ server, outlinePage, page }) => {
    const doc = await server.createDoc('stale-approval')
    await page.request.post(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })
    const p = await outlinePage(doc.docId)
    await editor(p).click()
    await p.keyboard.type('待确认正文')
    await p.waitForResponse(r => r.url().includes('/outline') && r.request().method() === 'PATCH' && r.status() === 200, { timeout: 20_000 })
    await p.locator('button:has-text("确认大纲")').click()
    await p.waitForResponse(r => r.url().includes('/approval') && r.status() === 200, { timeout: 15_000 })
    await editor(p).click()
    await p.keyboard.type('改后偏离')
    await p.waitForResponse(r => r.url().includes('/outline') && r.request().method() === 'PATCH' && r.status() === 200, { timeout: 20_000 })
    await expect(p.locator('.workflow-status')).toContainText('已过时')
    await p.screenshot({ path: `${SHOTS}/ux-stale-approval.png`, fullPage: true })
  })

  test('MCP 与网页 version 一致', async ({ server, outlinePage, request }) => {
    const doc = await server.createDoc('mcp-sync')
    const mcp = await connectMcp(server)
    await mcp.callTool({ name: 'create_outline', arguments: { docId: doc.docId } })
    const page = await outlinePage(doc.docId)
    await editor(page).click()
    await page.keyboard.type('网页写入')
    await page.waitForResponse(r => r.url().includes('/outline') && r.request().method() === 'PATCH' && r.status() === 200, { timeout: 20_000 })
    const w = await (await request.get(`${server.baseUrl}/api/docs/${doc.docId}/outline`, { headers: { authorization: `Bearer ${server.apiKey}` } })).json()
    const m = await mcp.callTool({ name: 'get_outline', arguments: { docId: doc.docId } })
    expect(JSON.stringify(m.content)).toContain(String(w.version))
    await mcp.close()
  })
})
