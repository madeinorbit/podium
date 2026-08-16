/**
 * Rasterises src-tauri/icons/app-icon.svg into the desktop shell's icon set
 * [POD-1108].
 *
 * These files used to be hand-produced — someone ran `tauri icon` once, in
 * 2026-07, and the SVG next to them was a record of what had been done rather
 * than something anything re-read. Swapping the mark meant reproducing that run
 * from memory, so the mark is now a build input and this script is the run.
 *
 * The outputs are committed: `tauri build` reads them straight from
 * tauri.conf.json's `bundle.icon` list, and neither CI nor a release build has
 * sharp available.
 *
 * Re-run with `bun apps/desktop/scripts/generate-icons.ts` after changing
 * app-icon.svg.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const ICONS = join(import.meta.dir, '..', 'src-tauri', 'icons')
const SRC = join(ICONS, 'app-icon.svg')

/**
 * The contact shadow, kept out of app-icon.svg on purpose.
 *
 * It is one `feDropShadow` conceptually, but SVG filters are the part of the
 * spec rasterisers disagree about most — librsvg, resvg and every browser
 * preview would each give a slightly different shadow, and the one that matters
 * is whichever one `tauri build` happens to link. Compositing it here from a
 * blurred silhouette is boring, deterministic, and identical everywhere.
 *
 * Geometry mirrors the clip rect in app-icon.svg. Apple's grid drops the shadow
 * ~1.5% of the canvas below the tile and keeps it inside the 1024 frame.
 */
const TILE = { x: 100, y: 90, w: 824, h: 824, r: 180 }
const SHADOW = { dy: 0.018, sigma: 0.021, opacity: 0.34 }

async function render(size: number): Promise<Buffer> {
  const scale = size / 1024
  const silhouette = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">` +
      `<rect x="${TILE.x}" y="${TILE.y}" width="${TILE.w}" height="${TILE.h}" rx="${TILE.r}" fill="#000"/>` +
      `</svg>`,
  )
  const shadow = await sharp(silhouette)
    .blur(Math.max(0.4, SHADOW.sigma * size))
    .composite([
      // Flatten the blurred black to the target opacity without touching its
      // alpha ramp — `dest-in` against a uniform grey scales the whole ramp.
      {
        input: {
          create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: SHADOW.opacity },
          },
        },
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer()

  const tile = await sharp(readFileSync(SRC), { density: Math.max(72, 72 * scale * 4) })
    .resize(size, size)
    .png()
    .toBuffer()

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: shadow, top: Math.round(SHADOW.dy * size), left: 0 },
      { input: tile, top: 0, left: 0 },
    ])
    .png()
    .toBuffer()
}

/** The PNGs tauri.conf.json names, plus icon.png (the 512 the repo has always kept). */
const PNGS: [string, number][] = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]
for (const [name, size] of PNGS) {
  const buf = await render(size)
  writeFileSync(join(ICONS, name), buf)
  console.log(name, size, `${Math.round(buf.length / 1024)}kb`)
}

/**
 * .icns and .ico are multi-image containers, not something sharp writes. The
 * tauri CLI builds both from a 1024 PNG, and it is already a devDependency of
 * this package — so hand it the same render rather than growing an
 * icns/ico encoder here.
 *
 * It is pointed at a temp directory because `tauri icon` also emits a full
 * Windows Store Square*Logo set plus iOS and Android mipmaps, none of which
 * this app ships. Only the two container formats are copied back; the PNGs
 * above stay the ones rendered here, so every committed PNG comes from one
 * code path.
 */
const staging = mkdtempSync(join(tmpdir(), 'podium-icons-'))
try {
  const master = join(staging, 'master.png')
  writeFileSync(master, await render(1024))
  execFileSync('bunx', ['--bun', '@tauri-apps/cli', 'icon', master, '--output', staging], {
    cwd: join(import.meta.dir, '..'),
    stdio: 'inherit',
  })
  for (const name of ['icon.icns', 'icon.ico']) {
    copyFileSync(join(staging, name), join(ICONS, name))
    console.log(name)
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
