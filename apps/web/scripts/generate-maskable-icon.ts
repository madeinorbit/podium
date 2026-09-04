/**
 * Rasterises the platform-masked web icons that cannot use the rounded browser
 * source: Android's maskable safe-zone cut and Apple's full-bleed touch icon.
 *
 * Everything unmasked is generated at build time by @vite-pwa/assets-generator
 * (see ../pwa-assets.config.ts). These two assets are committed exceptions
 * because the generator takes a single source for all three asset types:
 * `images` is a flat list and the output names are per-TYPE, so a second source
 * overwrites rather than specialises. The maskable slot needs the 9a safe-zone
 * cut, which the other two must NOT have, so it is rendered here instead.
 *
 * FULL BLEED — no padding, no background. Unlike the generator's maskable step,
 * which insets the art and composites it over a flat colour, the source already
 * carries its own safe-zone margin and its own ground. Insetting it is precisely
 * the bug this replaces.
 *
 * The maskable manifest entry points at the PNG, not the SVG
 * (apps/web/vite.config.ts). SVG maskable icons are not a documented-safe path
 * through Chrome's WebAPK minting on Android, and shipping one would risk
 * re-breaking the surface this exists to fix. Committing the PNG also keeps the
 * normal build and CI free of sharp.
 *
 * The Apple touch icon also stays PNG and full bleed: iOS supplies its own
 * squircle, so feeding it icon-browser.svg would draw a second rounded frame.
 * Re-run this script after either platform-masked source is recut and commit both
 * PNGs. The maskable SVG is web's copy of the shared mobile master.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '..')
const MASKABLE_SRC = join(ROOT, 'public', 'icon-maskable.svg')
const MASKABLE_OUT = join(ROOT, 'public', 'icon-maskable-512.png')
const FULL_BLEED_SRC = join(ROOT, 'public', 'icon.svg')
const APPLE_OUT = join(ROOT, 'public', 'apple-touch-icon-180x180.png')

/**
 * 512 is the size the manifest advertises and the size Chrome wants for the
 * WebAPK. `density` oversamples the SVG before the downscale so the letter's
 * curves and the plane's edge resolve cleanly rather than aliasing.
 */
const buf = await sharp(MASKABLE_SRC, { density: 384 })
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(MASKABLE_OUT, buf)
console.log('public/icon-maskable-512.png', `512 ${Math.round(buf.length / 1024)}kb`)

const apple = await sharp(FULL_BLEED_SRC, { density: 384 })
  .resize(180, 180)
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(APPLE_OUT, apple)
console.log('public/apple-touch-icon-180x180.png', `180 ${Math.round(apple.length / 1024)}kb`)
