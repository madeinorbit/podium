/**
 * Rasterises public/icon-maskable.svg into the committed Android adaptive icon
 * [POD-1109].
 *
 * Everything else in the installed-app set is generated at build time by
 * @vite-pwa/assets-generator (see ../pwa-assets.config.ts) and nothing else in
 * public/ is committed. This one asset is the exception, because the generator
 * takes a single source for all three asset types: `images` is a flat list and
 * the output names are per-TYPE, so a second source overwrites rather than
 * specialises. The maskable slot needs the 9a safe-zone cut, which the other two
 * must NOT have, so it is rendered here instead.
 *
 * FULL BLEED — no padding, no background. Unlike the generator's maskable step,
 * which insets the art and composites it over a flat colour, the source already
 * carries its own safe-zone margin and its own ground. Insetting it is precisely
 * the bug this replaces.
 *
 * The manifest points at the PNG, not the SVG (apps/web/vite.config.ts). SVG
 * maskable icons are not a documented-safe path through Chrome's WebAPK minting
 * on Android, and shipping one would risk re-breaking the surface this exists to
 * fix. Committing the PNG also keeps the normal build and CI free of sharp.
 *
 * Re-run with `bun apps/web/scripts/generate-maskable-icon.ts` after the mark is
 * recut, and commit the PNG it writes. The source is web's copy of the shared
 * master — re-copy it from apps/mobile/assets/icon-maskable.svg at the same
 * time, or the two home screens drift apart.
 *
 * `sharp` is not a declared dependency here — it arrives hoisted as a transitive
 * dependency of @vite-pwa/assets-generator, which is the same way
 * apps/mobile/scripts/generate-web-icons.ts reaches it.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'public', 'icon-maskable.svg')
const OUT = join(ROOT, 'public', 'icon-maskable-512.png')

/**
 * 512 is the size the manifest advertises and the size Chrome wants for the
 * WebAPK. `density` oversamples the SVG before the downscale so the letter's
 * curves and the plane's edge resolve cleanly rather than aliasing.
 */
const buf = await sharp(SRC, { density: 384 })
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(OUT, buf)
console.log('public/icon-maskable-512.png', `512 ${Math.round(buf.length / 1024)}kb`)
