import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

describe('working mark raster masks', () => {
  for (const density of ['small', 'medium', 'large']) {
    it(`${density} preserves every wave frame and transparent cell margins`, async () => {
      const bytes = readFileSync(new URL(`./working-mark-${density}.png`, import.meta.url))
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(66)
      expect(info.height).toBe(4500)
      expect(info.channels).toBe(4)
      const frames = new Set<string>()
      for (let frame = 0; frame < 45; frame++) {
        const start = frame * 100 * info.width * info.channels
        const end = start + 100 * info.width * info.channels
        const pixels = data.subarray(start, end)
        let lit = 0
        for (let y = 0; y < 100; y++) {
          expect(pixels[(y * info.width) * 4 + 3]).toBe(0)
          expect(pixels[(y * info.width + info.width - 1) * 4 + 3]).toBe(0)
          for (let x = 0; x < info.width; x++) lit += pixels[(y * info.width + x) * 4 + 3]
        }
        expect(lit).toBeGreaterThan(0)
        frames.add(pixels.toString('base64'))
      }
      expect(frames.size).toBe(45)
    })
  }
})
