/**
 * Renders the macOS install DMG's Finder background.
 *
 * The Finder window a DMG opens is laid out once, at build time: Tauri's
 * bundle_dmg copies `bundle.macOS.dmg.background` into the volume's hidden
 * `.background/` folder and an AppleScript tells Finder where the window sits,
 * how big it is, and where the app and the Applications link go. Finder saves
 * that into the volume's `.DS_Store`, which is what every user's Finder reads.
 *
 * The art lives in src-tauri/dmg/variants/*.svg, in the podium.do "Podium
 * Paper" language and with the real logo paths from its masthead (podium-cloud
 * apps/site MarketingSymbols.astro). This script turns the selected cut into
 * src-tauri/dmg/background.tiff, a two-image TIFF holding a 1x and a 2x render.
 * Finder picks the 2x image on Retina displays, the same thing Apple's
 * `tiffutil -cathidpicheck` builds. It is written here instead so the asset can
 * be regenerated on any OS, not only a Mac.
 *
 * Two checks run before anything is written:
 *
 *  - Each SVG is drawn to the window size in tauri.conf.json, and declares
 *    where its two icons sit (`data-app-position`, `data-applications-
 *    position`), so a cut can lay its icons out on its own terms.
 *    The selected cut's positions are written into tauri.conf.json, so the
 *    art and the Finder layout cannot drift apart.
 *  - Finder draws icon labels black in Light Mode and white in Dark Mode, on
 *    whatever background is behind them. A label band that reads in one
 *    appearance and not the other is the classic DMG background bug, so each
 *    variant must keep both label bands near the mid-tone where black and
 *    white text both clear MIN_CONTRAST.
 *
 * The outputs are committed: neither CI nor a release build has sharp or the
 * Geist TTFs available. Re-run after changing an SVG or the dmg layout:
 *
 *   bun apps/desktop/scripts/generate-dmg-background.ts             # selected variant
 *   bun apps/desktop/scripts/generate-dmg-background.ts --preview <dir>
 *
 * `--preview` also writes mock Finder windows (light and dark) of every variant
 * plus a contact sheet. They are review aids, not build inputs.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { deflateSync } from 'node:zlib'

/** The cut that ships (variants/<name>.svg). Change it here and re-run; the TIFF is derived from it. */
const SELECTED_VARIANT = 'hero'

/**
 * Lowest contrast either label colour may have against the darkest/brightest
 * part of its band. Black and white both reach 4.5:1 only for a background
 * luminance of roughly 0.175–0.183, so the plates are tuned to that window;
 * 4.2 leaves room for gradient and anti-aliasing without letting a band drift
 * far enough that one appearance goes grey-on-grey.
 */
const MIN_CONTRAST = 4.2

/**
 * Where Finder draws a label, relative to its icon's centre (Tauri's bundle_dmg
 * fixes the icon size at 128 and the label size at 16pt): a line ~70-88pt
 * below the centre, as wide as the name in SF 16pt ("Podium" ~57pt,
 * "Applications" ~92pt) plus a few points of slack for Finder's own metrics.
 */
const LABEL_BAND = { top: 70, bottom: 88, halfWidth: { app: 34, applications: 52 } }

/** Title bar height of a toolbar-less Finder window: the window frame includes it. */
const TITLE_BAR = 28

const DESKTOP = join(import.meta.dir, '..')
const TAURI = join(DESKTOP, 'src-tauri')
const DMG = join(TAURI, 'dmg')
const VARIANTS = join(DMG, 'variants')

type Point = { x: number; y: number }
type DmgLayout = { background: string; windowSize: { width: number; height: number } }

const CONF = join(TAURI, 'tauri.conf.json')
const conf = JSON.parse(readFileSync(CONF, 'utf8'))
const layout: DmgLayout = conf.bundle.macOS.dmg
const { width: W, height: H } = layout.windowSize

const { values: args } = parseArgs({
  options: { variant: { type: 'string' }, preview: { type: 'string' } },
})
const variants = readdirSync(VARIANTS)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4))
  .sort()
const selected = args.variant ?? SELECTED_VARIANT
if (!variants.includes(selected)) {
  throw new Error(`no variant "${selected}" in ${VARIANTS} (have: ${variants.join(', ')})`)
}

type Variant = { name: string; svg: Buffer; app: Point; applications: Point }

function loadVariant(name: string): Variant {
  const svg = readFileSync(join(VARIANTS, `${name}.svg`))
  const root = svg.toString('utf8').match(/<svg\b[^>]*>/)?.[0] ?? ''
  const point = (attr: string): Point => {
    const m = root.match(new RegExp(`${attr}="(\\d+) (\\d+)"`))
    if (!m) throw new Error(`${name}.svg: root <svg> has no ${attr}="x y"`)
    return { x: Number(m[1]), y: Number(m[2]) }
  }
  return {
    name,
    svg,
    app: point('data-app-position'),
    applications: point('data-applications-position'),
  }
}

/** Point tauri.conf.json's icon positions at the shipped cut, touching only those two lines. */
function syncLayout(v: Variant) {
  const pos = (p: Point) => `{ "x": ${p.x}, "y": ${p.y} }`
  const text = readFileSync(CONF, 'utf8')
  const next = text
    .replace(/("appPosition": )\{[^}]*\}/, `$1${pos(v.app)}`)
    .replace(/("applicationFolderPosition": )\{[^}]*\}/, `$1${pos(v.applications)}`)
  if (next !== text) {
    writeFileSync(CONF, next)
    console.log(`tauri.conf.json dmg positions ← ${v.name}`)
  }
}

/**
 * The art is set in Geist and Geist Mono, the web app's faces. The web package
 * ships them only as variable WOFF2, which librsvg cannot load, so point
 * fontconfig at the static TTFs the phone app depends on.
 *
 * FONTCONFIG_FILE has to be in the environment when the process starts: under
 * Bun, assigning process.env does not reach the getenv() that fontconfig calls,
 * and a missing face does not fail, it silently falls back to DejaVu. So the
 * script re-runs itself with the variable set, and assertFonts() below refuses
 * to render if the fallback still happened.
 */
const FONTS_READY = 'PODIUM_DMG_FONTS_READY'
const mobileRequire = createRequire(join(DESKTOP, '../mobile/package.json'))
const fontDirs = ['@expo-google-fonts/geist', '@expo-google-fonts/geist-mono'].map((pkg) =>
  dirname(mobileRequire.resolve(`${pkg}/package.json`)),
)
if (process.env[FONTS_READY] !== '1') {
  const staging = mkdtempSync(join(tmpdir(), 'podium-dmg-fonts-'))
  const fontsConf = join(staging, 'fonts.conf')
  writeFileSync(
    fontsConf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">` +
      `<fontconfig>${fontDirs.map((d) => `<dir>${d}</dir>`).join('')}<cachedir>${staging}/cache</cachedir></fontconfig>`,
  )
  const child = spawnSync(process.execPath, [import.meta.path, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, FONTCONFIG_FILE: fontsConf, [FONTS_READY]: '1' },
  })
  rmSync(staging, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
const { default: sharp } = await import('sharp')

/** A monospace face inks "iiiiiiii" and "MMMMMMMM" to nearly the same width; DejaVu Sans does not. */
async function assertFonts() {
  const inkWidth = async (s: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><text x="4" y="30" font-family="Geist Mono" font-size="20">${s}</text></svg>`
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true })
    return info.width
  }
  const [narrow, wide] = [await inkWidth('iiiiiiii'), await inkWidth('MMMMMMMM')]
  if (Math.abs(narrow - wide) > 15) {
    throw new Error(
      `Geist Mono did not load (ink widths ${narrow} vs ${wide}); check ${fontDirs.join(', ')}`,
    )
  }
}

type Raster = { data: Buffer; width: number; height: number }

async function rasterise(svg: Buffer, scale: number): Promise<Raster> {
  const { data, info } = await sharp(svg, { density: 72 * scale })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width !== W * scale || info.height !== H * scale) {
    throw new Error(`rendered ${info.width}x${info.height}, expected ${W * scale}x${H * scale}`)
  }
  return { data, width: info.width, height: info.height }
}

function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Contrast of black and of white label text against one label band (1x raster). */
function bandContrast(img: Raster, at: Point, dx: number) {
  const lums: number[] = []
  for (let y = at.y + LABEL_BAND.top; y < at.y + LABEL_BAND.bottom; y++) {
    for (let x = at.x - dx; x < at.x + dx; x++) {
      const i = (y * img.width + x) * 3
      lums.push(luminance(img.data[i], img.data[i + 1], img.data[i + 2]))
    }
  }
  lums.sort((a, b) => a - b)
  // 1st/99th percentile: a stray anti-aliased pixel on a plate edge is not
  // what decides whether a word is readable.
  const dark = lums[Math.floor(lums.length * 0.01)]
  const light = lums[Math.ceil(lums.length * 0.99) - 1]
  return { black: (dark + 0.05) / 0.05, white: 1.05 / (light + 0.05) }
}

function checkLabels(v: Variant, img: Raster) {
  const failures: string[] = []
  for (const [label, at, dx] of [
    ['app', v.app, LABEL_BAND.halfWidth.app],
    ['Applications', v.applications, LABEL_BAND.halfWidth.applications],
  ] as const) {
    const c = bandContrast(img, at, dx)
    const line = `${label}: black ${c.black.toFixed(2)}:1, white ${c.white.toFixed(2)}:1`
    console.log(`  ${line}`)
    if (c.black < MIN_CONTRAST || c.white < MIN_CONTRAST) failures.push(line)
  }
  if (failures.length > 0) {
    throw new Error(
      `${v.name}: a label band fails ${MIN_CONTRAST}:1 in one appearance (${failures.join('; ')})`,
    )
  }
}

/**
 * A baseline TIFF with one RGB image per raster, Deflate-compressed with
 * horizontal differencing, resolution set to 72 dpi per scale step. That is
 * the shape `tiffutil -cathidpicheck a.png a@2x.png` produces: the 1x image
 * first, the 144 dpi one after it.
 */
function encodeTiff(images: { raster: Raster; dpi: number }[]): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  const push = (buf: Buffer) => {
    chunks.push(buf)
    offset += buf.length
    if (offset % 2) push(Buffer.alloc(1))
  }
  const header = Buffer.alloc(8)
  header.write('II', 0, 'latin1')
  header.writeUInt16LE(42, 2)
  push(header)

  const ifds: { at: number; entries: number }[] = []
  for (const { raster, dpi } of images) {
    const { width, height, data } = raster
    const rowBytes = width * 3
    const predicted = Buffer.alloc(data.length)
    for (let y = 0; y < height; y++) {
      const row = y * rowBytes
      for (let i = 0; i < rowBytes; i++) {
        predicted[row + i] = i < 3 ? data[row + i] : (data[row + i] - data[row + i - 3]) & 0xff
      }
    }
    const strip = deflateSync(predicted, { level: 9 })
    const stripOffset = offset
    push(strip)
    const bits = Buffer.alloc(6)
    for (let i = 0; i < 3; i++) bits.writeUInt16LE(8, i * 2)
    const bitsOffset = offset
    push(bits)
    const res = Buffer.alloc(8)
    res.writeUInt32LE(dpi, 0)
    res.writeUInt32LE(1, 4)
    const resOffset = offset
    push(res)

    const SHORT = 3
    const LONG = 4
    const RATIONAL = 5
    const entries: [number, number, number, number][] = [
      [256, LONG, 1, width],
      [257, LONG, 1, height],
      [258, SHORT, 3, bitsOffset],
      [259, SHORT, 1, 8], // Adobe Deflate
      [262, SHORT, 1, 2], // RGB
      [273, LONG, 1, stripOffset],
      [277, SHORT, 1, 3],
      [278, LONG, 1, height],
      [279, LONG, 1, strip.length],
      [282, RATIONAL, 1, resOffset],
      [283, RATIONAL, 1, resOffset],
      [284, SHORT, 1, 1], // chunky
      [296, SHORT, 1, 2], // inches
      [317, SHORT, 1, 2], // horizontal differencing
    ]
    const ifd = Buffer.alloc(2 + entries.length * 12 + 4)
    ifd.writeUInt16LE(entries.length, 0)
    entries.forEach(([tag, type, count, value], i) => {
      const at = 2 + i * 12
      ifd.writeUInt16LE(tag, at)
      ifd.writeUInt16LE(type, at + 2)
      ifd.writeUInt32LE(count, at + 4)
      if (type === SHORT && count === 1) ifd.writeUInt16LE(value, at + 8)
      else ifd.writeUInt32LE(value, at + 8)
    })
    ifds.push({ at: offset, entries: entries.length })
    push(ifd)
  }
  const out = Buffer.concat(chunks)
  out.writeUInt32LE(ifds[0].at, 4)
  // Chain each IFD to the next; the last keeps its zero terminator.
  for (let i = 0; i + 1 < ifds.length; i++) {
    out.writeUInt32LE(ifds[i + 1].at, ifds[i].at + 2 + ifds[i].entries * 12)
  }
  return out
}

/** Read the TIFF back through libvips: two pages, 1x then 2x, at 72 and 144 dpi. */
async function verifyTiff(tiff: Buffer) {
  const pages = await sharp(tiff).metadata()
  if (pages.pages !== 2) throw new Error(`background.tiff has ${pages.pages} pages, expected 2`)
  for (const [page, scale] of [
    [0, 1],
    [1, 2],
  ]) {
    const m = await sharp(tiff, { page }).metadata()
    if (
      m.width !== W * scale ||
      m.height !== H * scale ||
      Math.round(m.density ?? 0) !== 72 * scale
    ) {
      throw new Error(`page ${page} is ${m.width}x${m.height} @${m.density}dpi`)
    }
  }
}

/* ---------- review previews ---------------------------------------------- */

const APP_ICON = readFileSync(join(TAURI, 'icons', 'icon.png')).toString('base64')

/**
 * A stand-in for the Applications alias: Apple's folder art is not ours to
 * redistribute, so the preview draws a generic blue folder with the same
 * transparent margin (visible art ends ~50pt below its centre).
 */
const FOLDER = `
  <defs>
    <linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58b0f3"/><stop offset="1" stop-color="#3a8fe0"/></linearGradient>
    <linearGradient id="ff" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd2fd"/><stop offset="1" stop-color="#5db3f5"/></linearGradient>
  </defs>
  <path d="M10 26 a7 7 0 0 1 7 -7 h30 l9 9 h55 a7 7 0 0 1 7 7 v70 h-108 z" fill="url(#fb)"/>
  <rect x="10" y="36" width="108" height="78" rx="7" fill="url(#ff)"/>
  <path d="M64 52 L48 98 M64 52 L80 98 M54 82 H74" stroke="#3a8fe0" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round" fill="none"/>`

function finderMock(v: Variant, background: Buffer, appearance: 'light' | 'dark'): Buffer {
  const pad = 36
  const contentH = H - TITLE_BAR
  const dark = appearance === 'dark'
  const chrome = dark ? '#323232' : '#e9e7e5'
  const titleInk = dark ? '#dcdcdc' : '#4b4b4b'
  const label = dark ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.86)'
  const desk = dark ? '#1b1d22' : '#c9ced6'
  const icon = (at: Point, body: string) =>
    `<g transform="translate(${at.x - 64} ${at.y - 64 + TITLE_BAR})">${body}</g>`
  const text = (at: Point, s: string) =>
    `<text x="${at.x}" y="${at.y + 83 + TITLE_BAR}" text-anchor="middle" font-family="Geist" font-size="16" fill="${label}">${s}</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + pad * 2}" height="${H + pad * 2}">
    <defs>
      <clipPath id="win"><rect width="${W}" height="${H}" rx="12"/></clipPath>
      <clipPath id="content"><rect y="${TITLE_BAR}" width="${W}" height="${contentH}"/></clipPath>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dy="10" stdDeviation="14" flood-opacity="${dark ? 0.6 : 0.3}"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="${desk}"/>
    <g transform="translate(${pad} ${pad})">
      <rect width="${W}" height="${H}" rx="12" fill="${chrome}" filter="url(#shadow)"/>
      <g clip-path="url(#win)">
        <rect width="${W}" height="${TITLE_BAR}" fill="${chrome}"/>
        <g clip-path="url(#content)">
          <image href="data:image/png;base64,${background.toString('base64')}" y="${TITLE_BAR}" width="${W}" height="${H}"/>
        </g>
        <circle cx="20" cy="14" r="6" fill="#ff5f57"/><circle cx="40" cy="14" r="6" fill="#febc2e"/><circle cx="60" cy="14" r="6" fill="#28c840"/>
        <text x="${W / 2}" y="18.5" text-anchor="middle" font-family="Geist" font-weight="600" font-size="13" fill="${titleInk}">${conf.productName}</text>
        ${icon(v.app, `<image href="data:image/png;base64,${APP_ICON}" width="128" height="128"/>`)}
        ${icon(v.applications, FOLDER)}
        ${text(v.app, conf.productName)}
        ${text(v.applications, 'Applications')}
      </g>
      <rect width="${W}" height="${H}" rx="12" fill="none" stroke="${dark ? '#ffffff' : '#000000'}" stroke-opacity="${dark ? 0.14 : 0.12}"/>
    </g>
  </svg>`
  return Buffer.from(svg)
}

async function writePreviews(dir: string, rendered: Map<Variant, Raster>) {
  mkdirSync(dir, { recursive: true })
  const tiles: { input: Buffer; top: number; left: number }[] = []
  const tileW = (W + 72) * 2
  const tileH = (H + 72) * 2
  let row = 0
  for (const [v, hi] of rendered) {
    const png = await sharp(hi.data, { raw: { width: hi.width, height: hi.height, channels: 3 } })
      .png()
      .toBuffer()
    let col = 0
    for (const appearance of ['light', 'dark'] as const) {
      const mock = await sharp(finderMock(v, png, appearance), { density: 144 })
        .png()
        .toBuffer()
      writeFileSync(join(dir, `${v.name}-${appearance}.png`), mock)
      tiles.push({ input: mock, top: row * tileH, left: col * tileW })
      col++
    }
    row++
  }
  // Two pipelines: sharp resizes before it composites, whatever order the calls are chained in.
  const sheet = await sharp({
    create: { width: tileW * 2, height: tileH * row, channels: 3, background: '#808080' },
  })
    .composite(tiles)
    .png()
    .toBuffer()
  await sharp(sheet).resize({ width: tileW }).png().toFile(join(dir, 'contact-sheet.png'))
  console.log(`previews → ${dir}`)
}

/* ---------- main ---------------------------------------------------------- */

{
  await assertFonts()
  const rendered = new Map<Variant, Raster>()
  let shipped: { v: Variant; lo: Raster; hi: Raster } | undefined
  for (const name of variants) {
    if (name !== selected && !args.preview) continue
    const v = loadVariant(name)
    const lo = await rasterise(v.svg, 1)
    const hi = await rasterise(v.svg, 2)
    console.log(`${name}${name === selected ? ' (selected)' : ''}`)
    checkLabels(v, lo)
    rendered.set(v, hi)
    if (name === selected) shipped = { v, lo, hi }
  }
  if (!shipped) throw new Error(`variant ${selected} did not render`)

  const tiff = encodeTiff([
    { raster: shipped.lo, dpi: 72 },
    { raster: shipped.hi, dpi: 144 },
  ])
  await verifyTiff(tiff)
  const out = join(TAURI, layout.background)
  writeFileSync(out, tiff)
  console.log(`${layout.background} ← ${selected} (${Math.round(tiff.length / 1024)}kb)`)
  syncLayout(shipped.v)

  if (args.preview) await writePreviews(args.preview, rendered)
}
