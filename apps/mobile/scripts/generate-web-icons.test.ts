// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const mobilePath = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const readMobile = (rel: string) => readFileSync(mobilePath(rel), 'utf8')

async function cornerAlphas(rel: string): Promise<number[]> {
  const { data, info } = await sharp(mobilePath(rel))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3]!
  return [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ]
}

describe('mobile web icon generation', () => {
  it('renders the favicon and purpose:any PWA outputs with transparent rounded corners', async () => {
    for (const output of [
      'assets/favicon.png',
      'public/icons/icon-192.png',
      'public/icons/icon-512.png',
    ]) {
      expect(await cornerAlphas(output), output).toEqual([0, 0, 0, 0])
    }
  })

  it('keeps Apple, native iOS, and Android maskable outputs full bleed', async () => {
    for (const output of [
      'assets/icon.png',
      'public/icons/apple-touch-icon.png',
      'public/icons/icon-512-maskable.png',
    ]) {
      expect(await cornerAlphas(output), output).toEqual([255, 255, 255, 255])
    }
  })

  it('wires only unmasked outputs to icon-browser.svg', () => {
    const generator = readMobile('scripts/generate-web-icons.ts')
    expect(generator).toContain("const BROWSER_SRC = join(ROOT, 'assets', 'icon-browser.svg')")
    expect(generator).toContain('const BROWSER_PNG = await sharp(BROWSER_SRC')
    expect(generator).toContain('await sharp(BROWSER_PNG).resize(48, 48')
    expect(generator).toContain('const buf = await sharp(ICON_PNG).resize(180, 180')
    expect(generator).toContain('const buf = await sharp(MASKABLE_SRC')

    const manifest = JSON.parse(readMobile('public/manifest.webmanifest')) as {
      icons: { src: string; purpose?: string }[]
    }
    expect(manifest.icons.filter(({ purpose }) => purpose === 'any').map(({ src }) => src)).toEqual(
      ['/mobile/icons/icon-192.png', '/mobile/icons/icon-512.png'],
    )
    expect(manifest.icons.filter(({ purpose }) => purpose === 'maskable')).toHaveLength(1)
  })
})
