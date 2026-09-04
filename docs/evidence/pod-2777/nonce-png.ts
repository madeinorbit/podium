/**
 * A PNG carrying a digit nonce, built with no image library at all.
 *
 * WHY THIS EXISTS. The attachment probe proves the agent READ the bytes by
 * putting a secret in them that exists nowhere else — an agent can agree that it
 * sees a file without reading one, but it cannot produce the secret without
 * having read it. That works for a text file, and codex refuses text files: it
 * declares `image` staging only, and refuses `text/plain` with a typed
 * `unsupported`. That refusal is the CONTRACT WORKING, so scoring it as "attach
 * a file failed" misreads a driver doing exactly what it declared.
 *
 * Driving codex's attachment path therefore needs a real image with a secret
 * inside it. This box has no ImageMagick and no PIL, and the chromium in the
 * playwright cache needs an LD_LIBRARY_PATH workaround to start — so the image
 * is drawn here: a 5x7 bitmap font, scaled up into big blocky digits that a
 * vision model reads without ambiguity, encoded as a PNG by hand.
 *
 * DIGITS ONLY, deliberately. Ten glyphs instead of thirty-six, and no letter
 * pairs a model can transpose (O/0, I/1, S/5) — the nonce has to be unambiguous
 * or a correct read looks like a wrong one.
 */

import { deflateSync } from 'node:zlib'

/** 5x7, one string per row, '#' = ink. */
const FONT: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
}

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] as number
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcOver = out.subarray(4, 8 + data.length)
  dv.setUint32(8 + data.length, crc32(crcOver))
  return out
}

/**
 * Render `digits` as black-on-white blocks and encode a PNG.
 *
 * `scale` is 24 so each glyph is 120x168 — far larger than any downscaling a
 * provider applies before the model sees it, which is the failure mode a small
 * image would hit and report as "the agent could not read the attachment".
 */
export function digitsPng(digits: string, scale = 24): Uint8Array {
  const glyphs = [...digits].filter((d) => FONT[d])
  const pad = 2
  const cols = glyphs.length * 6 + pad * 2 // 5 wide + 1 space
  const rows = 7 + pad * 2
  const w = cols * scale
  const h = rows * scale

  // THREE bytes per pixel, truecolour RGB (colour type 2). Greyscale (type 0)
  // encodes correctly and is a valid PNG, but not every consumer in the chain
  // decodes it — the first version of this file produced a perfectly good
  // greyscale image that a downstream reader refused outright. An attachment
  // probe whose image cannot be decoded reports "the agent could not read it",
  // which is the wrong finding entirely, so this uses the format nothing argues
  // with.
  const stride = w * 3 + 1
  const raw = new Uint8Array(stride * h).fill(0xff)
  for (let y = 0; y < h; y++) raw[y * stride] = 0 // filter byte: none

  const ink = (px: number, py: number) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const x = px * scale + dx
        const y = py * scale + dy
        if (x >= w || y >= h) continue
        const o = y * stride + 1 + x * 3
        raw[o] = 0x00
        raw[o + 1] = 0x00
        raw[o + 2] = 0x00
      }
    }
  }

  glyphs.forEach((d, gi) => {
    const rowsOf = FONT[d] as string[]
    rowsOf.forEach((line, ry) => {
      ;[...line].forEach((ch, rx) => {
        if (ch === '#') ink(pad + gi * 6 + rx, pad + ry)
      })
    })
  })

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)))
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    png.set(p, off)
    off += p.length
  }
  return png
}

/** Six unambiguous digits: no leading zero, so a model cannot drop it. */
export function digitNonce(): string {
  let s = String(1 + Math.floor(Math.random() * 9))
  for (let i = 0; i < 5; i++) s += String(Math.floor(Math.random() * 10))
  return s
}
