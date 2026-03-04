import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { ensureImageSizeForVideoSOfficial } from '@/lib/generators/runninghub'

async function createBase64Image(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  return `data:image/png;base64,${buffer.toString('base64')}`
}

async function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
  const data = base64.replace(/^data:image\/\w+;base64,/, '')
  const metadata = await sharp(Buffer.from(data, 'base64')).metadata()
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  }
}

describe('ensureImageSizeForVideoSOfficial', () => {
  it('允许的尺寸 1792x1024 -> 不缩放', async () => {
    const input = await createBase64Image(1792, 1024)
    const output = await ensureImageSizeForVideoSOfficial(input)
    const dim = await getImageDimensions(output)
    expect(dim).toEqual({ width: 1792, height: 1024 })
  })

  it('允许的尺寸 1280x720 -> 不缩放', async () => {
    const input = await createBase64Image(1280, 720)
    const output = await ensureImageSizeForVideoSOfficial(input)
    const dim = await getImageDimensions(output)
    expect(dim).toEqual({ width: 1280, height: 720 })
  })

  it('非允许尺寸 5456x3072 横图 -> 缩放为 1792x1024', async () => {
    const input = await createBase64Image(5456, 3072)
    const output = await ensureImageSizeForVideoSOfficial(input)
    const dim = await getImageDimensions(output)
    expect(dim).toEqual({ width: 1792, height: 1024 })
  })

  it('非允许尺寸 3072x5456 竖图 -> 缩放为 1024x1792', async () => {
    const input = await createBase64Image(3072, 5456)
    const output = await ensureImageSizeForVideoSOfficial(input)
    const dim = await getImageDimensions(output)
    expect(dim).toEqual({ width: 1024, height: 1792 })
  })
})
