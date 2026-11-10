import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auth, createDoc, createUser, makeApp, PNG_DATA_URL, slide, textElement, type TestContext } from './helpers'

// §九 M4 端到端：真实 Chromium 走无头导出页导出 PDF / PPTX / PNG
// 默认跳过；E2E=1 且 RENDER_BASE_URL 指向可达的 PPTBase 前端（vite dev 或已构建的静态托管）时运行
const E2E = process.env.E2E === '1'
const RENDER_BASE_URL = process.env.RENDER_BASE_URL ?? 'http://127.0.0.1:5173'

describe.skipIf(!E2E)('e2e 导出（需要无头 Chromium + 可达前端）', () => {
  let ctx: TestContext
  let key = ''
  let docId = ''

  beforeAll(async () => {
    // 真实监听 + 前端 dist：render 浏览器以 RENDER_BASE_URL 回连同一实例读取文档
    const distDir = join(__dirname, '../../dist')
    ctx = await makeApp({ EXPORT_SYNC_WAIT_MS: '55000', RENDER_BASE_URL, STATIC_DIR: distDir })
    await ctx.app.listen({ host: '127.0.0.1', port: Number(new URL(RENDER_BASE_URL).port) })
    key = createUser(ctx, 'e2e').key
    const doc = await createDoc(ctx, key, {
      title: 'e2e 导出',
      slides: [slide('e1', [textElement('t1', '端到端导出测试')])],
    })
    docId = doc.docId
  }, 60_000)

  afterAll(async () => {
    await ctx.app.close()
  })

  it('PDF 导出成功', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${docId}/exports`,
      headers: auth(key),
      payload: { format: 'pdf' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string, url?: string }
    expect(body.status).toBe('done')
    const file = readFileSync(join(ctx.dir, 'exports', body.url!.split('/exports/')[1]))
    expect(file.subarray(0, 5).toString()).toBe('%PDF-')
  }, 90_000)

  it('PPTX 导出成功', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${docId}/exports`,
      headers: auth(key),
      payload: { format: 'pptx' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string, url?: string }
    expect(body.status).toBe('done')
    const file = readFileSync(join(ctx.dir, 'exports', body.url!.split('/exports/')[1]))
    expect(file.subarray(0, 2).toString()).toBe('PK')
  }, 90_000)

  it('中文+图片+图表 PPTX/PDF 导出结构可解析', async () => {
    const logo = readFileSync(join(__dirname, '../../public/logo.png'))
    const richDoc = await createDoc(ctx, key, {
      title: '安全回归-中文图表',
      slides: [{
        id: 's-rich',
        elements: [
          textElement('t-cn', '中文标题与段落：导出回归'),
          {
            type: 'image',
            id: 'img1',
            left: 300,
            top: 80,
            width: 120,
            height: 120,
            rotate: 0,
            src: `data:image/png;base64,${logo.toString('base64')}`,
            fixedRatio: true,
          },
          {
            type: 'chart',
            id: 'ch1',
            left: 80,
            top: 220,
            width: 400,
            height: 240,
            rotate: 0,
            chartType: 'bar',
            data: {
              labels: ['一季度', '二季度', '三季度'],
              legends: ['销售额'],
              series: [[12, 18, 9]],
            },
            options: { lineSmooth: true },
            themeColors: ['#5b9bd5'],
            textColor: '#333',
          },
        ],
      }],
    })
    const outDir = process.env.SECURITY_E2E_OUT ?? join(tmpdir(), 'pptist-security-export-')
    mkdirSync(outDir, { recursive: true })

    const pdfRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${richDoc.docId}/exports`,
      headers: auth(key),
      payload: { format: 'pdf' },
    })
    expect(pdfRes.statusCode).toBe(200)
    const pdfBody = pdfRes.json() as { status: string, url?: string }
    expect(pdfBody.status).toBe('done')
    const pdfPath = join(ctx.dir, 'exports', pdfBody.url!.split('/exports/')[1])
    const pdfBuf = readFileSync(pdfPath)
    writeFileSync(join(outDir, 'export-zh-chart.pdf'), pdfBuf)
    expect(pdfBuf.subarray(0, 5).toString()).toBe('%PDF-')

    const pptxRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/docs/${richDoc.docId}/exports`,
      headers: auth(key),
      payload: { format: 'pptx' },
    })
    expect(pptxRes.statusCode).toBe(200)
    const pptxBody = pptxRes.json() as { status: string, url?: string }
    expect(pptxBody.status).toBe('done')
    const pptxPath = join(ctx.dir, 'exports', pptxBody.url!.split('/exports/')[1])
    const pptxBuf = readFileSync(pptxPath)
    writeFileSync(join(outDir, 'export-zh-chart.pptx'), pptxBuf)
    expect(pptxBuf.subarray(0, 2).toString()).toBe('PK')
    expect(pptxBuf.length).toBeGreaterThan(10_000)
    const slideXml = execFileSync('unzip', ['-p', pptxPath, 'ppt/slides/slide1.xml']).toString('utf8')
    expect(slideXml).toContain('中文标题与段落')
    const listing = execFileSync('unzip', ['-Z1', pptxPath]).toString('utf8')
    expect(listing).toMatch(/ppt\/charts\//)
    expect(listing).toMatch(/ppt\/media\//)
    writeFileSync(join(outDir, 'export-zh-chart-meta.json'), JSON.stringify({
      docId: richDoc.docId,
      pdfBytes: pdfBuf.length,
      pptxBytes: pptxBuf.length,
      logoBytes: logo.length,
    }, null, 2))
  }, 120_000)

  it('单页 PNG 截图成功', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/docs/${docId}/slides/0.png?width=1000`,
      headers: auth(key),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
  }, 90_000)
})
