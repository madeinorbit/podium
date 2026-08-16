/**
 * Builds the POD-1108 review sheet: every icon surface at the size it is
 * actually seen at, plus the Android adaptive layers composited under the
 * launcher's circle mask. Throwaway — not wired into any build.
 *
 * bun .design/build-preview.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, '.design')
const px = (n: number) => Math.round(n)

/** Android composites foreground over background, then masks the pair. */
async function adaptive(shape: 'circle' | 'squircle', size: number) {
  const fg = join(ROOT, 'apps/mobile/assets/android-icon-foreground.png')
  const bg = join(ROOT, 'apps/mobile/assets/android-icon-background.png')
  // 108dp layer, 72dp visible: the mask is inset to the middle 66.7%.
  const layer = px(size / 0.667)
  // Two passes: sharp runs extract ahead of composite inside one pipeline.
  const stacked = await sharp(await sharp(bg).resize(layer, layer).png().toBuffer())
    .composite([{ input: await sharp(fg).resize(layer, layer).png().toBuffer() }])
    .png()
    .toBuffer()
  const flat = await sharp(stacked)
    .extract({
      left: px((layer - size) / 2),
      top: px((layer - size) / 2),
      width: size,
      height: size,
    })
    .png()
    .toBuffer()
  const r = shape === 'circle' ? size / 2 : size * 0.22
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`,
  )
  return sharp(flat)
    .composite([{ input: await sharp(mask).png().toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer()
}

const strip: { label: string; buf: Buffer }[] = []
async function add(label: string, buf: Buffer) {
  strip.push({ label, buf })
}

// Web: the browser tab and the installed PWA.
for (const size of [16, 32, 64]) {
  await add(
    `favicon ${size}`,
    await sharp(readFileSync(join(ROOT, 'apps/web/public/icon.svg')), { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer(),
  )
}
// Desktop: the dock, the titlebar, the taskbar.
for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['icon.png', 256],
] as [string, number][]) {
  await add(
    `desktop ${size}`,
    await sharp(join(ROOT, 'apps/desktop/src-tauri/icons', name)).resize(size, size).png().toBuffer(),
  )
}
// Mobile: iOS squircle, Android circle, Android squircle.
await add(
  'ios 180',
  await sharp(join(ROOT, 'apps/mobile/public/icons/apple-touch-icon.png'))
    .resize(180, 180)
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="40" fill="#fff"/></svg>`,
        ),
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer(),
)
await add('android circle', await adaptive('circle', 180))
await add('android squircle', await adaptive('squircle', 180))

// Lay the strip out on the design doc's own ground.
const PAD = 28
const H = 300
const widths = await Promise.all(
  strip.map(async (s) => (await sharp(s.buf).metadata()).width ?? 0),
)
const W = widths.reduce((a, b) => a + b + PAD, PAD)
const sheet = await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 0x15, g: 0x16, b: 0x1a, alpha: 1 } },
})
  .composite(
    strip.map((s, i) => ({
      input: s.buf,
      left: widths.slice(0, i).reduce((a, b) => a + b + PAD, PAD),
      top: px((H - (widths[i] ?? 0)) / 2),
    })),
  )
  .png()
  .toBuffer()
writeFileSync(join(OUT, 'POD-1108-icon-9a-surfaces.png'), sheet)
console.log('POD-1108-icon-9a-surfaces.png', strip.map((s) => s.label).join(' · '))
