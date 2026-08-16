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
 * app wears [POD-392], now in its 9a cut [POD-1108]. It used to come from
 * assets/icon.png, which was still the Expo template's chevron, so the home
 * screen advertised create-expo-app. The PNG is now a build output of the SVG
 * rather than a hand-placed asset, and is still committed because Expo reads it
 * for the native icon and the splash.
 *
 * The Android adaptive layers were the last three files the chevron survived in
 * [POD-1108]: they are named in app.json but nothing generated them, so
 * `bun scripts/generate-web-icons.ts` reported success while an Android home
 * screen still showed a blue arrow. They are rendered here now, from their own
 * masters — see assets/android-icon-foreground.svg for why they are not just
 * icon.svg resized.
 *
 * Re-run with `bun scripts/generate-web-icons.ts` after changing any
 * assets/*.svg master. The outputs are committed — CI and the normal build
 * never need sharp.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'assets', 'icon.svg')
const MASKABLE_SRC = join(ROOT, 'assets', 'icon-maskable.svg')
const OUT = join(ROOT, 'public', 'icons')

/** Expo's own icon source (app.json `icon`). */
const ICON_PNG = join(ROOT, 'assets', 'icon.png')
writeFileSync(ICON_PNG, await sharp(SRC, { density: 384 }).resize(1024, 1024).png().toBuffer())
console.log('assets/icon.png 1024')

/**
 * Native launch chrome is the same bare Dark Ink ground as the PWA launch
 * images. The transparent pixel replaces Expo's target-grid template without
 * creating a second static logo before BootSplash's one animated brand moment.
 */
const SPLASH_PNG = join(ROOT, 'assets', 'splash-icon.png')
writeFileSync(
  SPLASH_PNG,
  await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer(),
)
console.log('assets/splash-icon.png transparent')

/** Dark Ink #16171a — color.bg. The launch screen must be this, not white. */
const BG = { r: 0x16, g: 0x17, b: 0x1a, alpha: 1 }

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
 * Maskable icon: Android crops to a circle inscribed in the middle 80%.
 *
 * This used to inset icon.svg to 62% over flat Dark Ink, which put a second
 * visible tile inside the first — icon.svg owns a gradient ground, so the inset
 * edge read as a border rather than as padding. assets/icon-maskable.svg is the
 * mark redrawn for the crop instead of shrunk into it, so this one renders full
 * bleed [POD-1108].
 */
{
  const buf = await sharp(MASKABLE_SRC, { density: 192 }).resize(512, 512).png().toBuffer()
  writeFileSync(join(OUT, 'icon-512-maskable.png'), buf)
  console.log('icon-512-maskable.png', `${Math.round(buf.length / 1024)}kb`)
}

/**
 * Android adaptive icon layers — app.json `android.adaptiveIcon`.
 *
 * Three separate masters rather than three crops of one, because the layers are
 * not the same picture: the launcher parallaxes foreground against background
 * and tints monochrome to the wallpaper, so each has a constraint the others do
 * not. All three land at 1024 (Expo's recommended source size, and what it
 * downsamples the mipmap set from) — the monochrome layer used to be 432, the
 * one size the Expo template happened to ship.
 *
 * Alpha is preserved on foreground and monochrome; flattening either onto a
 * colour is what turns an adaptive icon back into a square sticker.
 */
for (const layer of ['foreground', 'background', 'monochrome']) {
  const name = `android-icon-${layer}.png`
  const buf = await sharp(join(ROOT, 'assets', `android-icon-${layer}.svg`), { density: 384 })
    .resize(1024, 1024)
    .png()
    .toBuffer()
  writeFileSync(join(ROOT, 'assets', name), buf)
  console.log(`assets/${name}`, 1024, `${Math.round(buf.length / 1024)}kb`)
}

/**
 * iOS launch images. Safari only honours an `apple-touch-startup-image` whose
 * media query matches the device exactly, so every supported iPhone needs its
 * own file; anything unmatched falls back to a white flash. Portrait only —
 * the app is `orientation: portrait`.
 *
 * Bare ground, no mark [POD-420]. They used to centre the P, which made a cold
 * launch play two different logos back to back: iOS held the static P, then the
 * bundle booted and replaced it with BootSplash's animated wordmark. Apple's own
 * guidance is that a launch screen resembles the first screen of the app rather
 * than being a splash of its own — and the first screen here is the Dark Ink
 * ground with a wordmark that reveals itself cell by cell FROM empty. Starting
 * from that same empty ground makes the handoff invisible and leaves one brand
 * moment instead of two competing ones.
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
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
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
  background_color: '#16171a',
  theme_color: '#16171a',
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
  `${JSON.stringify(manifest, null, 2)}\n`,
)
console.log('manifest.webmanifest')

/** app.json `web.favicon` — the browser tab, when it is a tab and not an app. */
const favicon = join(ROOT, 'assets', 'favicon.png')
writeFileSync(favicon, await sharp(ICON_PNG).resize(48, 48, { fit: 'cover' }).png().toBuffer())
console.log('assets/favicon.png 48')
