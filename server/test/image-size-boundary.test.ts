import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { imageSize } from 'image-size'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('image-size@2.0.3 直接边界（不经过导出）', () => {
  it('正常 1x1 PNG 返回宽高与类型', () => {
    expect(imageSize(PNG)).toMatchObject({ width: 1, height: 1, type: 'png' })
  })

  it('仓库 logo.png 可被 Uint8Array 入参读取', () => {
    const logo = readFileSync(join(__dirname, '../../public/logo.png'))
    const dim = imageSize(logo)
    expect(dim.type).toBe('png')
    expect(dim.width).toBeGreaterThan(0)
    expect(dim.height).toBeGreaterThan(0)
  })

  it('畸形字节、空缓冲、截断 PNG 抛错且不返回尺寸', () => {
    expect(() => imageSize(Buffer.from('not-an-image-xxxx'))).toThrow(/unsupported file type/)
    expect(() => imageSize(Buffer.alloc(0))).toThrow(RangeError)
    expect(() => imageSize(PNG.subarray(0, 8))).toThrow(/Invalid PNG/)
  })
})
