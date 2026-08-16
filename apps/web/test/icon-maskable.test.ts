// @vitest-environment node
// Reads source files off disk via import.meta.url — needs the real file URL,
// which happy-dom (this package's default test env) mangles. Matches the
// convention in pwa.structure.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the Android adaptive icon [POD-1109].
 *
 * The bug: the maskable slot was icon.svg run through @vite-pwa/assets-generator
 * at `padding: 0.15` over a flat colour. That padding is TOTAL rather than
 * per-side, so the art landed at 85% of the frame — and because icon.svg owns a
 * GRADIENT ground, insetting it over a flat colour read as a band around a
 * smaller tile rather than as padding. On an Android home screen that is a
 * visible border around the mark.
 *
 * The fix is the 9a set's safe-zone cut [POD-1108], rendered full bleed. These
 * tests do not re-derive the artwork's geometry: the cut deliberately runs the
 * letter and the ocre plane off the frame so the launcher's crop slices them
 * rather than boxing them, and a rule like "all ink inside the 40% circle" would
 * contradict the design on purpose. What they guard instead is the two ways this
 * bug can come back — the art drifting away from the shared master, and the
 * renderer insetting it again — plus the wiring that carries it to the manifest.
 */
const webPath = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const readWeb = (rel: string) => readFileSync(webPath(rel), 'utf8')
const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

/** Comments differ per app; the drawing must not. */
const artOnly = (svg: string) => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, '')

describe('the maskable source', () => {
  const master = readWeb('public/icon-maskable.svg')

  it('is the same art as the shared 9a cut the mobile app renders', () => {
    // THE REGRESSION THIS EXISTS FOR. Web keeps its own copy of the masters
    // (nothing resolves across the two app trees at build time), so the copy can
    // silently fall behind when the mark is recut — which is exactly what
    // happened while POD-1109 was in flight: the 9a rollout landed and this
    // file still held the previous cut, which would have put last-generation art
    // on the Android home screen while every other surface wore 9a.
    const shared = readFileSync(repoPath('apps/mobile/assets/icon-maskable.svg'), 'utf8')
    expect(artOnly(master)).toBe(artOnly(shared))
  })

  it('is not icon.svg — the full-bleed cut must never feed a hard crop', () => {
    // Rasterising the full-bleed tile for a maskable slot is the original bug.
    expect(artOnly(master)).not.toBe(artOnly(readWeb('public/icon.svg')))
  })

  it('lays its ground over the whole frame so no mask can reveal a border', () => {
    // Whatever sits at the frame edge is what shows at the mask edge. A ground
    // short of the edge is what let a second colour become a visible ring.
    expect(master).toMatch(/<rect width="1024" height="1024" fill="url\(#[^)]+\)"\/>/)
  })
})

describe('the maskable renderer', () => {
  const script = readWeb('scripts/generate-maskable-icon.ts')

  it('renders full bleed, never onto a coloured canvas', () => {
    // `composite` over a `create`d background IS the inset that produced the
    // border — it is what the generator's maskable step does and what this
    // script exists to avoid. A straight resize is the whole job.
    expect(script).not.toContain('composite(')
    expect(script).not.toContain('create:')
    expect(script).toContain('.resize(512, 512)')
  })

  it('ships the committed 512 PNG the manifest points at', () => {
    const png = readFileSync(webPath('public/icon-maskable-512.png'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // IHDR width/height, big-endian, at the fixed offsets a PNG header uses.
    expect(png.readUInt32BE(16)).toBe(512)
    expect(png.readUInt32BE(20)).toBe(512)
  })
})

describe('maskable wiring', () => {
  it('is not generated from icon.svg by the assets generator', () => {
    const config = readWeb('pwa-assets.config.ts')
    // An empty `sizes` switches the slot off: resolveMaskableIcons iterates
    // sizes, so it emits neither an asset nor a manifest entry. A padding here
    // would mean icon.svg is being inset over a flat colour again.
    expect(config).toMatch(/maskable:\s*\{\s*sizes:\s*\[\s*\],?\s*\}/)
  })

  it('is named directly in the manifest, as a PNG, with purpose maskable', () => {
    const config = readWeb('vite.config.ts')
    expect(config).toContain("src: 'icon-maskable-512.png'")
    expect(config).toContain("purpose: 'maskable'")
  })

  it('lists exactly the transparent sizes the generator rasterises', () => {
    // Declaring `icons` by hand is what keeps our maskable, but it also splits
    // one list into two files: pwa-assets.config.ts decides which PNGs exist,
    // vite.config.ts decides which the manifest advertises. Adding a size to
    // the generator and forgetting the manifest ships an asset nothing points
    // at; the reverse points the manifest at a 404. Tie them together here.
    const sizes = readWeb('pwa-assets.config.ts').match(
      /transparent:\s*\{[^}]*?sizes:\s*\[([^\]]*)\]/s,
    )?.[1]
    expect(sizes, 'expected transparent sizes in pwa-assets.config.ts').toBeTruthy()
    const declared = (sizes as string)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
    expect(declared.length).toBeGreaterThan(0)

    const listed = [...readWeb('vite.config.ts').matchAll(/src: 'pwa-(\d+)x\1\.png'/g)].map((m) =>
      Number(m[1]),
    )
    expect(listed.sort((a, b) => a - b)).toEqual(declared.sort((a, b) => a - b))
  })

  it('never sets overrideManifestIcons, which would discard the maskable entry', () => {
    // vite-plugin-pwa replaces the whole icons array with the generator's own
    // when this is true — and the generator no longer emits a maskable at all,
    // so setting it would silently ship an Android icon with no adaptive
    // variant. Default false + a declared `icons` key is what keeps ours.
    expect(readWeb('vite.config.ts')).not.toContain('overrideManifestIcons:')
  })
})
