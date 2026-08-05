/**
 * Generates the installed-app assets for the web export [POD-366].
 *
 * The mobile web build shipped no manifest, no apple-touch-icon and no launch
 * images, so "Add to Home Screen" produced a Safari bookmark with a cropped
 * screenshot for an icon. These outputs land in `public/`, which Expo copies
 * verbatim to the export root, and are wired into index.html by
 * ./patch-web-html.ts.
 *
 * The mark comes from assets/icon.svg — the Podium P, the same one the macOS
 * app wears [POD-392]. It used to come from assets/icon.png, which was still
 * the Expo template's chevron, so the home screen advertised create-expo-app.
 * The PNG is now a build output of the SVG rather than a hand-placed asset, and
 * is still committed because Expo reads it for the native icon and the splash.
 *
 * Re-run with `bun scripts/generate-web-icons.ts` after changing assets/icon.svg.
 * The outputs are committed — CI and the normal build never need sharp.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'assets', 'icon.svg')
const OUT = join(ROOT, 'public', 'icons')

/** Expo's own icon source (app.json `icon`, and the splash mark). */
const ICON_PNG = join(ROOT, 'assets', 'icon.png')
writeFileSync(ICON_PNG, await sharp(SRC, { density: 384 }).resize(1024, 1024).png().toBuffer())
console.log('assets/icon.png 1024')

/** Race Navy — color.bg. The launch screen must be this, not white. */
const BG = { r: 0x0a, g: 0x0f, b: 0x1c, alpha: 1 }

mkdirSync(OUT, { recursive: true })

/** Square app icons. iOS masks its own corners, so ship the full bleed. */
const SQUARES: [string, number][] = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]
for (const [name, size] of SQUARES) {
  const buf = await sharp(ICON_PNG).resize(size, size, { fit: 'cover' }).png().toBuffer()
  writeFileSync(join(OUT, name), buf)
  console.log(name, size, `${Math.round(buf.length / 1024)}kb`)
}

/**
 * Maskable icon: Android crops to a circle inscribed in the middle 80%, so the
 * artwork is inset onto a navy field rather than filling the frame.
 */
{
  const inner = Math.round(512 * 0.62)
  const art = await sharp(ICON_PNG).resize(inner, inner, { fit: 'cover' }).toBuffer()
  const buf = await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toBuffer()
  writeFileSync(join(OUT, 'icon-512-maskable.png'), buf)
  console.log('icon-512-maskable.png', `${Math.round(buf.length / 1024)}kb`)
}

/**
 * iOS launch images. Safari only honours an `apple-touch-startup-image` whose
 * media query matches the device exactly, so every supported iPhone needs its
 * own file; anything unmatched falls back to a white flash. Portrait only —
 * the app is `orientation: portrait`.
 */
export const LAUNCH: { w: number; h: number; ratio: number }[] = [
  { w: 750, h: 1334, ratio: 2 }, // SE (2nd/3rd gen), 8
  { w: 828, h: 1792, ratio: 2 }, // XR, 11
  { w: 1125, h: 2436, ratio: 3 }, // X, XS, 11 Pro
  { w: 1170, h: 2532, ratio: 3 }, // 12, 13, 14
  { w: 1179, h: 2556, ratio: 3 }, // 14 Pro, 15, 16
  { w: 1206, h: 2622, ratio: 3 }, // 16 Pro
  { w: 1260, h: 2736, ratio: 3 }, // Air [POD-392 — the list missed it]
  { w: 1284, h: 2778, ratio: 3 }, // 12/13 Pro Max
  { w: 1290, h: 2796, ratio: 3 }, // 14 Pro Max, 15/16 Plus & Pro Max
  { w: 1320, h: 2868, ratio: 3 }, // 16 Pro Max
]
for (const { w, h } of LAUNCH) {
  const art = Math.round(Math.min(w, h) * 0.28)
  const icon = await sharp(ICON_PNG).resize(art, art, { fit: 'cover' }).toBuffer()
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
    .composite([{ input: icon, gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer()
  writeFileSync(join(OUT, `launch-${w}x${h}.png`), buf)
  console.log(`launch-${w}x${h}.png`, `${Math.round(buf.length / 1024)}kb`)
}

const manifest = {
  name: 'Podium',
  short_name: 'Podium',
  description: 'Your agents, on your phone.',
  start_url: '/mobile',
  scope: '/mobile',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0a0f1c',
  theme_color: '#0a0f1c',
  icons: [
    { src: '/mobile/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/mobile/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/mobile/icons/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}
writeFileSync(
  join(ROOT, 'public', 'manifest.webmanifest'),
  JSON.stringify(manifest, null, 2) + '\n',
)
console.log('manifest.webmanifest')

/** app.json `web.favicon` — the browser tab, when it is a tab and not an app. */
const favicon = join(ROOT, 'assets', 'favicon.png')
writeFileSync(favicon, await sharp(ICON_PNG).resize(48, 48, { fit: 'cover' }).png().toBuffer())
console.log('assets/favicon.png 48')
