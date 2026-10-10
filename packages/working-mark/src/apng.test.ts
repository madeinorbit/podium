// @vitest-environment node
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assembleApng, pngChunks } from './apng'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (b: Uint8Array): number => {
  let c = 0xffffffff
  for (const x of b) c = (crcTable[(c ^ x) & 255] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** A real 2 × 2 RGBA PNG of one colour, made the way a canvas would. */
const png = (r: number): Uint8Array => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.from([0, r, 0, 0, 255, r, 0, 0, 255, 0, r, 0, 0, 255, r, 0, 0, 255])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('assembleApng', () => {
  it('writes one frame per hold, looping forever, holding each for its share of the period', () => {
    const holds = [
      { cell: 0, from: 0, to: 0.25 },
      { cell: 1, from: 0.25, to: 0.6 },
      { cell: 0, from: 0.6, to: 1 },
    ]
    const out = assembleApng([png(10), png(200)], { P: 2000, holds })
    expect([...out.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const chunks = pngChunks(out)
    expect(chunks.map((c) => c.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'fcTL',
      'fdAT',
      'IEND',
    ])
    const acTL = new DataView(
      chunks[1]?.data.buffer ?? new ArrayBuffer(8),
      chunks[1]?.data.byteOffset,
      8,
    )
    expect([acTL.getUint32(0), acTL.getUint32(4)]).toEqual([3, 0])
    const delays = chunks
      .filter((c) => c.type === 'fcTL')
      .map((c) => {
        const v = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength)
        expect(v.getUint16(22)).toBe(1000)
        return v.getUint16(20)
      })
    expect(delays).toEqual([500, 700, 800])
    // Sequence numbers run 0..n over fcTL and fdAT together.
    const seqs = chunks
      .filter((c) => c.type === 'fcTL' || c.type === 'fdAT')
      .map((c) => new DataView(c.data.buffer, c.data.byteOffset, 4).getUint32(0))
    expect(seqs).toEqual([0, 1, 2, 3, 4])
    // Every chunk's CRC is right.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    for (let i = 8; i < out.length; ) {
      const length = view.getUint32(i)
      expect(view.getUint32(i + 8 + length)).toBe(crc(out.subarray(i + 4, i + 8 + length)))
      i += 12 + length
    }
  })
})
