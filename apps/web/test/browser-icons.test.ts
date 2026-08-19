// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const webPath = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const readWeb = (rel: string) => readFileSync(webPath(rel), 'utf8')
const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

/** Comments are app-specific; the source drawing must remain shared. */
const artOnly = (svg: string) => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, '')

async function cornerAlphas(path: string): Promise<number[]> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3]!
  return [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ]
}

describe('unmasked browser icon source', () => {
  const browser = readWeb('public/icon-browser.svg')

  it('clips all visible art to a rounded frame with transparent corners', () => {
    expect(browser).toMatch(
      /<clipPath id="frame">\s*<rect width="1024" height="1024" rx="224"\/>\s*<\/clipPath>/,
    )
    const drawing = browser.match(/<\/defs>\s*([\s\S]*?)\s*<\/svg>/)?.[1]
    expect(drawing).toMatch(/^<g clip-path="url\(#frame\)">[\s\S]*<\/g>$/)
  })

  it('stays the same drawing as the mobile browser source', () => {
    const mobile = readFileSync(repoPath('apps/mobile/assets/icon-browser.svg'), 'utf8')
    expect(artOnly(browser)).toBe(artOnly(mobile))
  })
})

describe('web browser icon wiring', () => {
  const assets = readWeb('pwa-assets.config.ts')

  it('feeds the SVG favicon, ICO favicon and purpose:any PNGs from the rounded source', () => {
    expect(assets).toContain("images: ['public/icon-browser.svg']")
    expect(assets).toMatch(
      /transparent:\s*\{[^}]*sizes:\s*\[64, 192, 512\][^}]*favicons:\s*\[\[48, 'favicon\.ico'\]\]/s,
    )

    const manifest = readWeb('vite.config.ts')
    for (const size of [64, 192, 512]) {
      expect(manifest).toMatch(new RegExp(`src: 'pwa-${size}x${size}\\.png'[^}]*purpose: 'any'`))
    }
  })

  it('keeps Apple touch generation off the rounded source', async () => {
    expect(assets).toMatch(/apple:\s*\{\s*sizes:\s*\[\s*\],?\s*\}/)
    expect(readWeb('index.html')).toContain('href="/apple-touch-icon-180x180.png"')
    expect(await cornerAlphas(webPath('public/apple-touch-icon-180x180.png'))).toEqual([
      255, 255, 255, 255,
    ])
  })
})
