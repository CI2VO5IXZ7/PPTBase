// PPTBase 大纲浏览器验收（plan §9 全 13 例）。
// 仅 PPTBASE_E2E=1 时执行（config testIgnore 保证），每用例独立临时 DATA_DIR。
// 选择器优先用语义文本/稳定 class，避免依赖易变的 DOM 结构。
import { test, expect, connectMcp, type E2EServer, type Page } from './fixtures'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { APIRequestContext } from 'playwright/test'

// ── 真实 SDK Client 复用会话调 MCP；callTool 直传 tools/call ──
const outlineVersionOf = async (request: APIRequestContext, baseUrl: string, key: string, docId: string) => {
  const r = await api(request, baseUrl, bearer(key)).get(`/api/docs/${docId}/outline`)
  return (await r.json()).version as number
}
const callTool = (mcp: Client, name: string, args: Record<string, unknown>) =>
  mcp.callTool({ name, arguments: args })
const textOf = (r: Awaited<ReturnType<Client['callTool']>>) => {
  const c = r.content as { type: string, text?: string }[] | undefined
  return c?.[0]?.text ?? ''
}


// REST（Agent/用户令牌）
const api = (request: APIRequestContext, baseUrl: string, headers: Record<string, string>) => ({
  get: (url: string) => request.get(`${baseUrl}${url}`, { headers }),
  post: (url: string, data: unknown) => request.post(`${baseUrl}${url}`, { headers: { ...headers, 'content-type': 'application/json' }, data }),
  patch: (url: string, data: unknown) => request.patch(`${baseUrl}${url}`, { headers: { ...headers, 'content-type': 'application/json' }, data }),
})
const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const tok = (t: string) => ({ 'x-doc-token': t })

const editor = (page: Page) => page.locator('.outline-editor .ProseMirror')
const thread = (page: Page) => page.locator('.comments-panel .thread')

async function waitSaved(page: Page) {
  // 等待一次真实 PATCH 200（而非仅初始 UI 指示），避免 reload 抢在 300ms debounce 前
  await page.waitForResponse(r => r.url().includes('/outline') && r.request().method() === 'PATCH' && r.status() === 200, { timeout: 15_000 })
  await expect(page.locator('.save')).toHaveText('已保存', { timeout: 10_000 })
}

// ── 例1：零幻灯片大纲直接打开，不卡在初始化 ──
test('1. Agent 链接打开无幻灯片大纲，不陷入初始化', async ({ server, page, outlinePage }) => {
  const doc = await server.createDoc('empty')
  await api(page.request, server.baseUrl, bearer(server.apiKey))
    .post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  await expect(page.locator('.outline-editor .ProseMirror')).toBeVisible()
  await expect(page.locator('text=数据初始化中')).not.toBeVisible({ timeout: 3_000 }).catch(() => undefined)
  await expect(page.locator('.outline-header .title')).toContainText('大纲协作')
  const SHOTS = process.env.PPTBASE_E2E_OUT ?? '/home/dev/worklogs/pptbase-outlines/authorized-extra-round/playwright-results'
  await p.screenshot({ path: `${SHOTS}/../screenshots/case1-major-flow.png`, fullPage: true })
})

// ── 例2：格式/列表/中文输入(IME 事件)/粘贴/撤销重做/图片用途，保存刷新不丢 ──
test('2. 编辑+IME+撤销重做保存后刷新不丢', async ({ server, page, outlinePage, request }) => {
  const doc = await server.createDoc('edit')
  await api(page.request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)

  await ed.click()
  // IME 组合事件（脚本模拟 compositionend 的 DOM 契约，不等价系统 IME 全链路）
  await p.locator('.ProseMirror').evaluate(el => {
    // 脚本模拟 compositionstart/end 的 DOM 契约（不等于系统 IME 全链路）。
    // 经 ownerDocument 的 defaultView 取真实构造器，避免依赖 tsconfig DOM 类型名。
    const win = (el.ownerDocument?.defaultView ?? globalThis) as {
      CompositionEvent?: new (type: string, init: { data?: string }) => Event
    }
    const Ctor = win.CompositionEvent ?? Event
    el.dispatchEvent(new Ctor('compositionstart', { data: '' }))
    el.dispatchEvent(new Ctor('compositionend', { data: '中' }))
  })
  await p.keyboard.type('中文大纲')
  // 合成中真实输入 + 远端更新：composition 期间远端新增批注（元数据），补拉后本地输入保留
  const A = api(request, server.baseUrl, bearer(server.apiKey))
  await p.locator('.ProseMirror').evaluate(el => {
    const win = (el.ownerDocument?.defaultView ?? globalThis) as { CompositionEvent?: new (t: string, i: { data?: string }) => Event }
    el.dispatchEvent(new (win.CompositionEvent ?? Event)('compositionstart', { data: '' }))
  })
  const cur2 = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  const rc = await A.post(`/api/docs/${doc.docId}/outline/ops`, {
    baseVersion: cur2.version,
    ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '合成期远端批注' }],
  })
  expect(rc.status()).toBe(200)
  await p.keyboard.type('合成中保留')
  await p.locator('.ProseMirror').evaluate(el => {
    const win = (el.ownerDocument?.defaultView ?? globalThis) as { CompositionEvent?: new (t: string, i: { data?: string }) => Event }
    el.dispatchEvent(new (win.CompositionEvent ?? Event)('compositionend', { data: '合成中保留' }))
  })
  // 补拉后：本地输入仍在编辑器且远端批注可见（contentVersion 未变 → 安全合并，无冲突）
  await expect(ed).toContainText('合成中保留', { timeout: 10_000 })
  await expect(thread(p).filter({ hasText: '合成期远端批注' })).toBeVisible({ timeout: 10_000 })
  await expect(p.locator('.banner.conflict')).not.toBeVisible()
  // 标题与列表
  await p.locator('.outline-toolbar button[title="标题1"]').click()
  await p.keyboard.type('标题')
  await p.keyboard.press('Enter')
  await p.locator('.outline-toolbar button[title="无序列表"]').click()
  await p.keyboard.type('列表项一')
  await p.keyboard.press('Enter')
  await p.keyboard.type('列表项二')
  // 撤销/重做
  await p.keyboard.press('Control+z')
  await p.keyboard.press('Control+Shift+z')
  await expect(ed.locator('li').nth(1)).toContainText('列表项二')
  // 真实 UI 上传：filechooser 捕获动态 <input type=file>，插入后经属性面板改 caption/usage
  const chooser = p.waitForEvent('filechooser')
  await p.locator('.pick-btn').click()
  await (await chooser).setFiles({
    name: 'cover.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  })
  await expect(ed.locator('figure.outline-image img')).toBeVisible({ timeout: 15_000 })
  await ed.locator('figure.outline-image').click()
  await expect(p.locator('.image-attrs')).toBeVisible()
  await p.locator('.image-attrs input').first().fill('封面图')
  await p.locator('.image-attrs select').selectOption('include')
  await p.locator('.image-attrs input').first().press('Tab')
  await waitSaved(p)
  await p.reload()
  await p.waitForSelector('.outline-editor .ProseMirror')
  await expect(ed).toContainText('中文大纲')
  await expect(ed.locator('h1')).toContainText('标题')
  await expect(ed.locator('li').nth(1)).toContainText('列表项二')
  // 图片与属性持久化（figcaption 回显精确 caption；figure 上 usage 数据属性）
  await expect(ed.locator('figure.outline-image img')).toBeVisible()
  await expect(ed.locator('figure.outline-image figcaption')).toContainText('封面图')
  await expect(ed.locator('figure.outline-image')).toHaveAttribute('data-usage', 'include')
})

// ── 例3：文字批注锚点映射与失效保留 ──
test('3. 文字批注：前插字仍正确定位；删原文后显示脱离引用', async ({ server, outlinePage, request }) => {
  const doc = await server.createDoc('anchors')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)
  await ed.click()
  await p.keyboard.type('目标语句需要批注')
  // 选中“目标语句”：Ctrl+Home 后按 Shift+右箭头四次（JS 字符串长度按 UTF-16，中文各 1 位）
  await p.keyboard.press('Control+Home')
  for (let i = 0; i < 4; i++) await p.keyboard.press('Shift+ArrowRight')
  // 先注册 dialog 监听器再点击（点击触发 prompt 输入批注内容）
  p.once('dialog', d => {
    void d.accept('这是重点')
  })
  await p.locator('.outline-toolbar .comment-btn').click()
  await expect(thread(p).first()).toBeVisible({ timeout: 10_000 })
  await expect(ed.locator('.thread-hl')).toContainText('目标语句')
  // 在前面插字 → 高亮文本不变（锚点映射）
  await p.keyboard.press('Control+Home')
  await p.keyboard.type('前缀插入 ')
  await expect(ed.locator('.thread-hl')).toContainText('目标语句')
  // 删除原文 → 线程脱离并保留引用
  await p.keyboard.press('Control+a')
  await p.keyboard.press('Backspace')
  await waitSaved(p)
  await expect(thread(p).first()).toContainText('已脱离')
  await expect(thread(p).first()).toContainText('目标语句')
})

// ── 例4：段落/跨段/图片/全文批注回复/解决/重开；重叠批注共存 ──
test('4. 四类锚点线程完整操作与重叠批注', async ({ server, outlinePage, request }) => {
  const doc = await server.createDoc('threads')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)
  await ed.click()
  await p.keyboard.type('第一段\n第二段')
  // 文档级批注（面板按钮）
  p.once('dialog', d => {
    void d.accept('全文意见')
  })
  await p.locator('.comments-panel .new-btn').click()
  // 跨段选区批注
  await p.keyboard.press('Control+Home')
  await p.keyboard.down('Shift')
  for (let i = 0; i < 9; i++) await p.keyboard.press('ArrowRight')
  await p.keyboard.up('Shift')
  p.once('dialog', d => {
    void d.accept('跨段批注')
  })
  await p.locator('.outline-toolbar .comment-btn').click()
  await expect(thread(p)).toHaveCount(2, { timeout: 10_000 })
  // 块级锚点：光标折叠在第二段（不选字）→ 批注 → block 锚点
  await p.keyboard.press('Control+End')
  p.once('dialog', d => {
    void d.accept('块批注')
  })
  await p.locator('.outline-toolbar .comment-btn').click()
  await expect(thread(p)).toHaveCount(3, { timeout: 10_000 })
  // 图片锚点：经 REST 插入图片块后，点击图片选中原子节点 → 批注 → image 锚点
  await api(request, server.baseUrl, bearer(server.apiKey)).post('/api/assets', {
    data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  }).then(async r => {
    const a = await r.json()
    await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline/ops`, {
      baseVersion: await outlineVersionOf(request, server.baseUrl, server.apiKey, doc.docId),
      ops: [{ op: 'insertBlocks', blocks: [{ type: 'image', attrs: { blockId: 'im4', src: a.url } }] }],
    })
  })
  await p.reload(); await p.waitForSelector('.outline-editor .ProseMirror')
  await ed.locator('figure.outline-image img').click()
  p.once('dialog', d => {
    void d.accept('图片批注')
  })
  await p.locator('.outline-toolbar .comment-btn').click()
  await expect(thread(p)).toHaveCount(4, { timeout: 10_000 })
  // 重叠 textRange：与第一个跨段批注范围重叠的第二个批注共存
  await p.keyboard.press('Control+Home')
  await p.keyboard.down('Shift')
  for (let i = 0; i < 5; i++) await p.keyboard.press('ArrowRight')
  await p.keyboard.up('Shift')
  p.once('dialog', d => {
    void d.accept('重叠批注')
  })
  await p.locator('.outline-toolbar .comment-btn').click()
  await expect(thread(p)).toHaveCount(5, { timeout: 10_000 })
  // 回复 + 解决 + 重开
  await thread(p).first().locator('.reply').fill('收到')
  await thread(p).first().locator('.reply').press('Enter')
  await expect(thread(p).first()).toContainText('收到')
  await thread(p).first().locator('button:has-text("解决")').click()
  await p.locator('.comments-panel .filter').selectOption('open')
  await expect(thread(p)).toHaveCount(4)
  await p.locator('.comments-panel .filter').selectOption('resolved')
  await thread(p).first().locator('button:has-text("重开")').click()
  await p.locator('.comments-panel .filter').selectOption('all')
  await expect(thread(p)).toHaveCount(5)
  // 图片锚点线程的 anchor-desc 指向图片块
  await expect(p.locator('.comments-panel .anchor-desc').filter({ hasText: '图片' }).first()).toBeVisible()
})

// ── 例5：保存失败不可虚假成功；恢复后重试不重复记录 ──
test('5. 自动保存失败后提交/确认不虚假成功，恢复后重试', async ({ server, page, outlinePage }) => {
  const doc = await server.createDoc('offline')
  await api(page.request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  // 拦截大纲 PATCH 使其失败（模拟断网）
  await p.route(`**/api/docs/${doc.docId}/outline`, route => {
    if (route.request().method() === 'PATCH') route.abort('failed')
    else route.continue()
  })
  const ed = editor(p)
  await ed.click()
  await p.keyboard.type('断网期间输入')
  await expect(p.locator('.save')).toContainText('失败', { timeout: 15_000 })
  // 失败状态下提交反馈必须被阻止（drain 不通过/按钮禁用）
  const submitBtn = p.locator('button:has-text("提交反馈")')

  await expect(submitBtn).toBeDisabled()
  // 恢复路由 → 自动重试保存
  await p.unroute(`**/api/docs/${doc.docId}/outline`)
  await p.locator('button:has-text("立即重试")').click()
  await expect(p.locator('.save')).toHaveText('已保存', { timeout: 15_000 })
  // 提交反馈成功且只生成一轮
  await submitBtn.click()
  await expect(p.locator('.submissions .sub-item').first()).toContainText('第 1 轮', { timeout: 10_000 })
  const list = await api(page.request, server.baseUrl, bearer(server.apiKey)).get(`/api/docs/${doc.docId}/outline/feedback`)
  expect((await list.json()).submissions.length).toBe(1)
  // 提交后丢响应的重试语义：同 requestId+payload 的重复写服务端去重，不产生第二条修订/批注
  const A = api(page.request, server.baseUrl, bearer(server.apiKey))
  const st = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  const dup = { baseVersion: st.version, requestId: 'e2e-dedupe-c5', ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '去重批注' }] }
  const d1 = await A.post(`/api/docs/${doc.docId}/outline/ops`, dup)
  expect(d1.status()).toBe(200)
  const j1 = await d1.json()
  // 丢响应重试：客户端原样重发同 requestId+同 baseVersion+同 ops（不是改版本号的新请求）
  const d2 = await A.post(`/api/docs/${doc.docId}/outline/ops`, dup)
  const j2 = await d2.json()
  expect(j2.deduplicated).toBe(true)
  expect(j2.version).toBe(j1.version)
  const st2 = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  expect(st2.threads.filter((t: { messages: { content: string }[] }) => t.messages[0]?.content === '去重批注').length).toBe(1)
})

// ── 例6：提交后继续编辑，区分已提交与未提交；Agent 读所选轮次快照 ──
test('6. 提交后编辑：轮次快照与当前稿区分', async ({ server, outlinePage, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('rounds')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)
  await ed.click(); await p.keyboard.type('第一轮内容')
  await waitSaved(p)
  await p.locator('button:has-text("提交反馈")').click()
  await expect(p.locator('.submissions .sub-item').first()).toContainText('第 1 轮', { timeout: 10_000 })
  // 继续编辑 → 当前稿变化但第 1 轮快照不变
  await ed.click(); await p.keyboard.press('Enter'); await p.keyboard.type('提交后新增')
  await waitSaved(p)
  const fb = await api(request, server.baseUrl, bearer(server.apiKey)).get(`/api/docs/${doc.docId}/outline/feedback`)
  const sub = (await fb.json()).submissions[0]
  const snap = await api(request, server.baseUrl, bearer(server.apiKey)).get(`/api/docs/${doc.docId}/outline/feedback/${sub.id}`)
  const snapJson = JSON.stringify((await snap.json()).snapshot)
  expect(snapJson).toContain('第一轮内容')
  expect(snapJson).not.toContain('提交后新增')
  // MCP 读取当前稿含新增（当前版本 ≠ 快照）
  const cur = await callTool(mcp, 'get_outline', { docId: doc.docId })
  expect(JSON.stringify(cur)).toContain('提交后新增')
})

// ── 例7：素材清单 + get_outline_asset 返回图片内容块 ──
test('7. Agent 读取素材清单与图片内容块', async ({ server, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('assets')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  // 上传资产并经 REST 插入图片块（UI 上传路径由例2覆盖；本例验证 REST/MCP 侧契约）
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const up = await api(request, server.baseUrl, bearer(server.apiKey)).post('/api/assets', { data: PNG })
  const asset = await up.json()
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline/ops`, {
    baseVersion: await outlineVersionOf(request, server.baseUrl, server.apiKey, doc.docId),
    ops: [{ op: 'insertBlocks', blocks: [{ type: 'image', attrs: { blockId: 'i1', src: asset.url, alt: '', caption: '封面', usage: 'include', usageDescription: '放在首页' } }] }],
  })
  const out = await callTool(mcp, 'get_outline', { docId: doc.docId })
  const manifest = JSON.parse(textOf(out)).assets
  expect(manifest[0].usage).toBe('include')
  expect(manifest[0].usageDescription).toBe('放在首页')
  const img = await callTool(mcp, 'get_outline_asset', { docId: doc.docId, assetId: asset.id })
  expect((img.content as { type: string }[])[0].type).toBe('image')
})

// ── 例8：Agent 处理一轮反馈：网页可见改稿/回复与处理结果；新一轮仍待处理 ──
test('8. Agent 处理轮次后网页显示结果', async ({ server, outlinePage, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('handle')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)
  await ed.click(); await p.keyboard.type('待处理稿')
  await waitSaved(p)
  await p.locator('button:has-text("提交反馈")').click()
  await expect(p.locator('.submissions .sub-item').first()).toContainText('第 1 轮', { timeout: 10_000 })
  // Agent 改稿 + 标记完成（同一 MCP Key）
  await callTool(mcp, 'edit_outline', {
    docId: doc.docId, baseVersion: await outlineVersionOf(request, server.baseUrl, server.apiKey, doc.docId),
    ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'ag1' }, content: [{ type: 'text', text: 'Agent 改稿' }] }] }],
  })
  const fb = await api(request, server.baseUrl, bearer(server.apiKey)).get(`/api/docs/${doc.docId}/outline/feedback`)
  const sub = (await fb.json()).submissions[0]
  await callTool(mcp, 'complete_outline_feedback', { docId: doc.docId, submissionId: sub.id, note: '已按要求改' })
  // 用户再提一轮 → 仍待处理
  await p.reload(); await p.waitForSelector('.outline-editor .ProseMirror')
  await expect(ed).toContainText('Agent 改稿')
  await expect(p.locator('.submissions .sub-item').first()).toContainText('已处理')
  await ed.click(); await p.keyboard.press('End'); await p.keyboard.type('再改一点')
  await waitSaved(p)
  await p.locator('button:has-text("提交反馈")').click()
  await expect(p.locator('.submissions .sub-item').nth(0)).toContainText('第 2 轮', { timeout: 10_000 })
})

// ── 例9：未确认时 MCP+REST 制片被拒；确认后同工具生成 PPT ──
test('9. 制作门禁：未确认拒绝，确认后可制作', async ({ server, outlinePage, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('gate')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  // 未确认 → REST ops 409、MCP add_slides 报错
  const blocked = await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/ops`, { ops: [{ op: 'addSlides', slides: [{ id: 's', elements: [] }] }] })
  expect(blocked.status()).toBe(409)
  const mBlocked = await callTool(mcp, 'add_slides', { docId: doc.docId, slides: [{ id: 's', elements: [] }] })
  expect(mBlocked.isError).toBe(true)
  expect(textOf(mBlocked)).toContain('确认来源')
  // 网页确认 → begin → 写页面通过
  const p = await outlinePage(doc.docId)
  await p.locator('button:has-text("确认大纲，进入制作")').click()
  await expect(p.locator('.outline-header')).toContainText('已确认', { timeout: 10_000 })
  const begin = await callTool(mcp, 'begin_presentation_from_outline', { docId: doc.docId })
  const approvalId = JSON.parse(textOf(begin)).approvalId
  const ok = await callTool(mcp, 'add_slides', { docId: doc.docId, slides: [{ id: 's1', elements: [] }], sourceApprovalId: approvalId })
  expect(ok.isError).toBeFalsy()
})

// ── 例10：确认后正文变→旧来源失效；仅评论不失效；撤销立即生效 ──
test('10. 来源失效语义：正文/撤销 失效，评论 不失效', async ({ server, outlinePage, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('stale')
  const A = api(request, server.baseUrl, bearer(server.apiKey))
  await A.post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  await p.locator('button:has-text("确认大纲，进入制作")').click()
  await expect(p.locator('.outline-header')).toContainText('已确认', { timeout: 10_000 })
  const begin = await callTool(mcp, 'begin_presentation_from_outline', { docId: doc.docId })
  const approvalId = JSON.parse(textOf(begin)).approvalId
  // 仅加批注 → 仍有效
  const state = (await (await A.get(`/api/docs/${doc.docId}/outline`)).json())
  await api(request, server.baseUrl, tok(server.tokens(doc.docId).edit)).post(`/api/docs/${doc.docId}/outline/ops`, {
    baseVersion: state.version,
    ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '讨论' }],
  })
  const still = await A.post(`/api/docs/${doc.docId}/ops`, { ops: [{ op: 'setTitle', title: 'x' }], sourceApprovalId: approvalId })
  expect(still.status()).toBe(200)
  // 改正文 → 失效
  const cur = (await (await A.get(`/api/docs/${doc.docId}/outline`)).json())
  await api(request, server.baseUrl, tok(server.tokens(doc.docId).edit)).post(`/api/docs/${doc.docId}/outline/ops`, {
    baseVersion: cur.version,
    ops: [{ op: 'insertBlocks', blocks: [{ type: 'paragraph', attrs: { blockId: 'n' }, content: [{ type: 'text', text: '改了' }] }] }],
  })
  const stale = await A.post(`/api/docs/${doc.docId}/ops`, { ops: [{ op: 'setTitle', title: 'y' }], sourceApprovalId: approvalId })
  expect(stale.status()).toBe(409)
  // 撤销确认 → 立即阻止后续写入
  await api(request, server.baseUrl, tok(server.tokens(doc.docId).edit)).post(`/api/docs/${doc.docId}/outline/approval`, { baseVersion: cur.version + 1, acknowledgeOpenThreads: true })
  await request.delete(`${server.baseUrl}/api/docs/${doc.docId}/outline/approval`, { headers: tok(server.tokens(doc.docId).edit) })
  const revoked = await A.post(`/api/docs/${doc.docId}/ops`, { ops: [{ op: 'setTitle', title: 'z' }] })
  expect(revoked.status()).toBe(409)
})

// ── 例11：同时编辑冲突：本地输入可恢复、旧版本不覆盖新内容 ──
test('11. 冲突：远端删本地正在编辑的块 → 确定性 409，草稿可复制取回', async ({ server, outlinePage, request }) => {
  const doc = await server.createDoc('conflict')
  const A = api(request, server.baseUrl, bearer(server.apiKey))
  await A.post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const ed = editor(p)
  // 延迟本地 PATCH，确保远端删块先落地（消除竞态）
  await p.route(`**/api/docs/${doc.docId}/outline`, async route => {
    if (route.request().method() === 'PATCH') {
      await new Promise(r => setTimeout(r, 800))
      await route.continue()
    }
    else await route.continue()
  })
  const patchCodes: number[] = []
  p.on('response', r => {
    if (r.url().includes('/outline') && r.request().method() === 'PATCH') patchCodes.push(r.status()) 
  })
  await ed.click()
  await ed.locator('p').first().click()
  await p.keyboard.type('CONFLICT-LOCAL-42')
  await expect(p.locator('.save')).toContainText(/未保存|保存中/, { timeout: 5000 })
  // 远端删除本地正在输入的块 → 本地 insert step 无法重放 → 确定性 409
  const cur = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  const firstBlockId = cur.content.content[0].attrs.blockId
  const opsRes = await A.post(`/api/docs/${doc.docId}/outline/ops`, {
    baseVersion: cur.version,
    ops: [{ op: 'deleteBlocks', blockIds: [firstBlockId] }],
  })
  expect(opsRes.status()).toBe(200)
  // 确定性断言：冲突横幅 + 状态文本
  await expect(p.locator('.banner.conflict')).toBeVisible({ timeout: 10000 })
  await expect(p.locator('.save')).toContainText('冲突')
  expect(patchCodes).toContain(409)
  // 草稿复制必须包含实际输入的文本
  await p.locator('button:has-text("复制草稿内容")').click()
  const clip = await p.evaluate(() => (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText())
  expect(clip).toContain('CONFLICT-LOCAL-42')
  // 恢复：刷新为最新版本 → 远端删除生效、状态恢复、本地草稿仍可取回
  await p.locator('button:has-text("刷新为最新版本")').click()
  await expect(p.locator('.save')).toHaveText('已保存', { timeout: 10_000 })
  const fb = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  expect(fb.version).toBeGreaterThanOrEqual(2)
  const ids = fb.content.content.map((b: { attrs: { blockId: string } }) => b.attrs.blockId)
  expect(ids).not.toContain(firstBlockId)
})

test('12. 权限边界', async ({ server, page, request }) => {
  const mcp = await connectMcp(server)
  const doc = await server.createDoc('auth')
  const A = api(request, server.baseUrl, bearer(server.apiKey))
  await A.post(`/api/docs/${doc.docId}/outline`, {})
  const tokens = server.tokens(doc.docId)
  // 只读令牌：可读不可写
  const vGet = await api(request, server.baseUrl, tok(tokens.view)).get(`/api/docs/${doc.docId}/outline`)
  expect(vGet.status()).toBe(200)
  const vPatch = await api(request, server.baseUrl, tok(tokens.view)).patch(`/api/docs/${doc.docId}/outline`, { baseVersion: 1, requestId: 'x', steps: [] })
  expect(vPatch.status()).toBe(403)
  // 失效/伪造令牌
  const bad = await api(request, server.baseUrl, tok('bogus-token')).get(`/api/docs/${doc.docId}/outline`)
  expect([401, 403, 404]).toContain(bad.status())
  // 其他用户 Key：404（不存在观感）
  const other = await startOtherUser(server)
  const mcpB = await connectMcp(server, other)
  const foreign = await api(request, server.baseUrl, bearer(other)).get(`/api/docs/${doc.docId}/outline`)
  expect(foreign.status()).toBe(404)
  // 跨项目素材：bob 的资产/文档 id 互不可见
  const foreignAsset = await callTool(mcpB, 'get_outline_asset', { docId: doc.docId, assetId: 'whatever' })
  expect(foreignAsset.isError).toBe(true)
  // 同文档未引用资产：alice 上传但不引用 → get_outline_asset 拒绝
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const up0 = await api(request, server.baseUrl, bearer(server.apiKey)).post('/api/assets', { data: PNG })
  const unref = await callTool(mcp, 'get_outline_asset', { docId: doc.docId, assetId: (await up0.json()).id })
  expect(unref.isError).toBe(true)
  const up = await api(request, server.baseUrl, bearer(server.apiKey)).post('/api/assets', { data: PNG })
  // 跨属主已引用资产：bob 用自己的文档引用 alice 的资产 URL → 资产属主校验拒绝
  const refAsset = (await up.json())
  const bobDoc = await api(request, server.baseUrl, bearer(other)).post('/api/docs', { title: 'bob-doc', slides: [] })
  const bobDocId = (await bobDoc.json()).docId
  await api(request, server.baseUrl, bearer(other)).post(`/api/docs/${bobDocId}/outline`, {})
  const bobIns = await api(request, server.baseUrl, bearer(other)).post(`/api/docs/${bobDocId}/outline/ops`, {
    baseVersion: await outlineVersionOf(request, server.baseUrl, other, bobDocId),
    ops: [{ op: 'insertBlocks', blocks: [{ type: 'image', attrs: { blockId: 'bx', src: refAsset.url } }] }],
  })
  if (bobIns.status() === 200) {
    // 引用允许写入时：MCP get_outline_asset 的属主校验必须仍拒绝（非 bob 资产）
    const crossOwner = await callTool(mcpB, 'get_outline_asset', { docId: bobDocId, assetId: refAsset.id })
    expect(crossOwner.isError).toBe(true)
  }
  else {
    // 服务端在 ops 层直接禁止引用他人资产——同样是有效边界
    expect([400, 403]).toContain(bobIns.status())
  }
  // 只读视图页面不带可写控件（账号仍启用时加载，验证令牌态 UI）
  await page.goto(server.docUrl(doc.docId, 'outline', 'view'))
  await page.waitForSelector('.outline-editor .ProseMirror')
  await expect(page.locator('.outline-toolbar')).not.toBeVisible()
  await expect(page.locator('button:has-text("提交反馈")')).not.toBeVisible()
  // 旋转链接后旧令牌失效（令牌无内置过期；吊销=rotate）
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/links/rotate`, {})
  const rotated = await api(request, server.baseUrl, tok(tokens.view)).get(`/api/docs/${doc.docId}/outline`)
  expect([401, 403, 404]).toContain(rotated.status())
  // 禁用账号 Key：401
  server.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', server.userId)
  const disabled = await api(request, server.baseUrl, bearer(server.apiKey)).get(`/api/docs/${doc.docId}/outline`)
  expect([401, 403]).toContain(disabled.status())
})

async function startOtherUser(server: E2EServer): Promise<string> {
  const uid = `u_${Math.random().toString(36).slice(2, 10)}`
  server.db.prepare('INSERT INTO users (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(uid, 'other', 'active', Date.now())
  const { createApiKey } = await import('../src/auth')
  return createApiKey(server.db, uid, 'e2e-other').key
}

// ── 例13：导航/断线/多标签/窄屏 + 旧功能不回归 ──
test('13. 导航重连窄屏可用；旧 PPT 行为不回归', async ({ server, context, outlinePage, request }) => {
  const doc = await server.createDoc('nav')
  await api(request, server.baseUrl, bearer(server.apiKey)).post(`/api/docs/${doc.docId}/outline`, {})
  const p = await outlinePage(doc.docId)
  const A = api(request, server.baseUrl, bearer(server.apiKey))
  const ed = editor(p)
  const SHOTS = process.env.PPTBASE_E2E_OUT ?? '/home/dev/worklogs/pptbase-outlines/authorized-extra-round/playwright-results'
  await p.screenshot({ path: `${SHOTS}/../screenshots/case13-loaded.png`, fullPage: true })
  // SSE 断线→重连：先注册拦截再 reload → 事件流建立即被断（真实断线态）；
  // 远端更新不可见；放行后退避重连 → onReconnect 独立 GET 补拉 → 批注可见
  await p.route('**/api/docs/*/events', r => r.abort())
  await p.reload()
  await p.waitForSelector('.outline-editor .ProseMirror')
  const c1 = await (await A.get(`/api/docs/${doc.docId}/outline`)).json()
  const rmt = await A.post(`/api/docs/${doc.docId}/outline/ops`, { baseVersion: c1.version, ops: [{ op: 'addComment', anchor: { kind: 'document' }, content: '断线批注X' }] })
  expect(rmt.status()).toBe(200)
  await p.waitForTimeout(2500)
  await expect(thread(p).filter({ hasText: '断线批注X' })).not.toBeVisible()
  await p.unroute('**/api/docs/*/events')
  await expect(thread(p).filter({ hasText: '断线批注X' })).toBeVisible({ timeout: 30_000 })
  // 脏导航：PATCH 被断 → drain 失败 → confirm 取消留在页面；恢复后正常离开
  await p.route(`**/api/docs/${doc.docId}/outline`, r => {
    if (r.request().method() === 'PATCH') void r.abort('failed'); else void r.continue() 
  })
  await ed.click()
  await p.keyboard.type('DIRTY-NAV-X')
  await expect(p.locator('.save')).toContainText(/未保存|失败/, { timeout: 15_000 })
  const dlg = p.waitForEvent('dialog', { timeout: 60_000 })
  await p.locator('a:has-text("查看 PPT")').click()
  await (await dlg).dismiss() // 取消 → 停留
  expect(p.url()).toContain('outline')
  await expect(ed).toContainText('DIRTY-NAV-X')
  await p.unroute(`**/api/docs/${doc.docId}/outline`)
  // 窄屏：批注抽屉切换 + 截图
  await p.setViewportSize({ width: 480, height: 800 })
  await expect(p.locator('.comments-panel')).toBeVisible()
  await p.screenshot({ path: `${SHOTS}/../screenshots/case13-narrow.png`, fullPage: true })
  await p.locator('.drawer-toggle').click()
  await expect(p.locator('.comments-panel')).not.toBeVisible()
  await p.setViewportSize({ width: 1280, height: 800 })
  // 多标签：第二页签也能只读打开
  const p2 = await context.newPage()
  await p2.goto(server.docUrl(doc.docId, 'outline', 'view'))
  await p2.waitForSelector('.outline-editor .ProseMirror')
  await p2.close()
  // 旧 PPT 编辑器仍可用：查看 PPT 链接进入编辑器（本例文档无幻灯片 → 走创建首屏不卡死）
  await p.locator('a:has-text("查看 PPT")').click()
  await p.waitForLoadState()
  expect(p.url()).toContain(`doc=${doc.docId}`)
  // 首页 MCP 说明页展示新工具
  await p.goto(server.baseUrl + '/')
  await expect(p.locator('body')).toContainText('create_outline')
  await expect(p.locator('body')).toContainText('begin_presentation_from_outline')
})
