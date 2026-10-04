import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

describe('working mark animated masks', () => {
  for (const density of ['small', 'medium', 'large']) {
    it(`${density} preserves the 1.5s wave in 45 transparent, fixed-size cells`, async () => {
      const bytes = readFileSync(new URL(`./working-mark-${density}.png`, import.meta.url))
      const info = await sharp(bytes).metadata()
      expect([info.width, info.height, info.channels]).toEqual([66, 100, 4])
      const frames: { control: Buffer; parts: Buffer[] }[] = []
      let sequence = 0
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset)
        const type = bytes.toString('ascii', offset + 4, offset + 8)
        const data = bytes.subarray(offset + 8, offset + 8 + length)
        if (type === 'acTL') {
          expect(data.readUInt32BE(0)).toBe(45)
          expect(data.readUInt32BE(4)).toBe(0) // Loop forever.
        }
        if (type === 'fcTL') {
          expect(data.readUInt32BE(0)).toBe(sequence++)
          expect([data.readUInt32BE(4), data.readUInt32BE(8)]).toEqual([66, 100])
          expect([data.readUInt32BE(12), data.readUInt32BE(16)]).toEqual([0, 0])
          expect([data[24], data[25]]).toEqual([0, 0]) // Full source frame, no accumulated alpha.
          frames.push({ control: data, parts: [] })
        }
        if (type === 'IDAT') frames.at(-1)?.parts.push(data)
        if (type === 'fdAT') {
          expect(data.readUInt32BE(0)).toBe(sequence++)
          frames.at(-1)?.parts.push(data.subarray(4))
        }
        offset += length + 12
      }
      expect(frames).toHaveLength(45)
      let durationMs = 0
      const wave = new Set<string>()
      for (const { control, parts } of frames) {
        durationMs += 1000 * control.readUInt16BE(20) / control.readUInt16BE(22)
        const scanlines = inflateSync(Buffer.concat(parts))
        const stride = 66 * 4 + 1
        expect(scanlines.length).toBe(stride * 100)
        let lit = 0
        for (let y = 0; y < 100; y++) {
          expect(scanlines[y * stride]).toBe(0) // Unfiltered PNG scanlines.
          expect(scanlines[y * stride + 4]).toBe(0)
          expect(scanlines[y * stride + 66 * 4]).toBe(0)
          for (let x = 0; x < 66; x++) lit += scanlines[y * stride + x * 4 + 4]
        }
        expect(lit).toBeGreaterThan(0)
        wave.add(scanlines.toString('base64'))
      }
      expect(durationMs).toBeCloseTo(1500)
      expect(wave.size).toBe(45)
    })
  }
})
