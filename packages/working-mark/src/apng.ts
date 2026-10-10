/**
 * Animated PNG assembly with no DOM: the cells' PNG files plus their holds in, one APNG out. The browser steps the
 * image's frames by itself, so a mark drawn this way gives the page no animation to run.
 */
import type { Sheet } from './frames'

const CRC = /* @__PURE__ */ (() =>
  Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))()
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC[(c ^ b) & 255] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface PngChunk {
  type: string
  data: Uint8Array
}

/** A PNG file's chunks, after its 8-byte signature. */
export function pngChunks(png: Uint8Array): PngChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: PngChunk[] = []
  for (let i = 8; i + 12 <= png.length; ) {
    const length = view.getUint32(i)
    out.push({
      type: String.fromCharCode(...png.subarray(i + 4, i + 8)),
      data: png.subarray(i + 8, i + 8 + length),
    })
    i += 12 + length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * One APNG from one PNG per cell (all the same size) and the sheet's holds, looping forever. A hold lasts from its
 * first frame to the next hold, in whole ms counted from the loop's start, so rounding doesn't add up over the loop.
 */
export function assembleApng(
  cellPngs: readonly Uint8Array[],
  sheet: Pick<Sheet, 'P' | 'holds'>,
): Uint8Array {
  const pngs = cellPngs.map(pngChunks)
  const ihdr = pngs[0]?.find((c) => c.type === 'IHDR')?.data
  if (!ihdr) throw new Error('assembleApng: the first cell is not a PNG')
  const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
  const acTL = new Uint8Array(8)
  new DataView(acTL.buffer).setUint32(0, sheet.holds.length) // and 0 plays: forever
  const parts: Uint8Array[] = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('acTL', acTL),
  ]
  let seq = 0
  sheet.holds.forEach((h, i) => {
    const fcTL = new Uint8Array(26)
    const v = new DataView(fcTL.buffer)
    v.setUint32(0, seq++)
    v.setUint32(4, ihdrView.getUint32(0))
    v.setUint32(8, ihdrView.getUint32(4))
    v.setUint16(20, Math.round(h.to * sheet.P) - Math.round(h.from * sheet.P))
    v.setUint16(22, 1000) // delay in ms; dispose none, blend source: each frame replaces the last whole
    parts.push(chunk('fcTL', fcTL))
    for (const c of (pngs[h.cell] ?? []).filter((x) => x.type === 'IDAT')) {
      if (i === 0) parts.push(chunk('IDAT', c.data))
      else {
        const fdAT = new Uint8Array(4 + c.data.length)
        new DataView(fdAT.buffer).setUint32(0, seq++)
        fdAT.set(c.data, 4)
        parts.push(chunk('fdAT', fdAT))
      }
    }
  })
  parts.push(chunk('IEND', new Uint8Array(0)))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
