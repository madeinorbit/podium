import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { THEME_BG } from './theme'

/** Source-level invariants for the Podium theme's token blocks [POD-372].
 *
 *  These are cheap string assertions on index.css rather than computed-style
 *  checks, and they exist because of a specific failure mode: a token
 *  declaration can be silently DROPPED by a malformed comment above it (the CSS
 *  parser resyncs by discarding), and nothing downstream complains — the theme
 *  just quietly loses that value. That happened once while building Daylight:
 *  --carve-engraved vanished from the light block and the
 *  engraved column kept painting the dark theme's pure-black inset.
 *
 *  The other half is leakage. `[data-theme="podium"]` matches the dark variant
 *  too (it is `[data-theme="podium"].dark`), so every token the light block
 *  introduces MUST be restored in the dark block or it bleeds across appearances.
 */

// Resolved from cwd rather than import.meta.url: the web suite runs under a
// jsdom environment where import.meta.url is not a file: URL. Vitest's cwd is
// the package root, but tolerate a repo-root run too.
const cssPath = ['src/index.css', 'apps/web/src/index.css']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync)
const css = readFileSync(cssPath ?? 'src/index.css', 'utf8')

/** The declarations inside one selector's block — nothing nested, which is all
 *  these flat token blocks contain. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} not found in index.css`).toBeGreaterThan(-1)
  const end = css.indexOf('\n}', start)
  return css.slice(start, end)
}

const light = block('[data-theme="podium"]')
const dark = block('[data-theme="podium"].dark')

/** Tokens Daylight introduces. Each must be present in BOTH blocks: in light
 *  because that is the point, in dark to stop the light value leaking. */
const INTRODUCED = [
  '--ink',
  '--primary-rim',
  '--carve-engraved',
  '--carve-drop',
  '--carve-popover-far',
  '--carve-popover-near',
  '--issue-tint-scale',
  '--issue-line-scale',
  '--issue-row-tint-scale',
] as const

describe('Podium token blocks', () => {
  it.each(INTRODUCED)('declares %s in the light block', (token) => {
    expect(light).toContain(`${token}:`)
  })

  it.each(INTRODUCED)('restores %s in the dark block, so it cannot leak', (token) => {
    expect(dark).toContain(`${token}:`)
  })

  it('carves light in the theme ink and dark in black', () => {
    // Black at 0.85 on paper reads as dirt, not depth — that is the whole bug
    // this theme exists to fix, so assert the two grounds never share a carve.
    expect(light).toContain('--carve-engraved: rgb(29 28 25 / 0.07)')
    expect(dark).toContain('--carve-engraved: rgb(0 0 0 / 0.85)')
  })

  it('keeps every light neutral warm, so nothing reads as unlit dark mode', () => {
    // POD-725: the Paper theme's whole premise is that a light UI must be warm
    // stone rather than cool glass. A cool neutral sneaking back in is the one
    // regression that would undo it and that no screenshot review reliably
    // catches, so assert it numerically: for every 6-digit neutral in the
    // block, red must not be the smallest channel.
    const cool: string[] = []
    for (const match of light.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
      const name = match[1] ?? ''
      const hex = match[2] ?? ''
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
      // Chromatic accents (yellow, ochre, blue, terracotta, red) are exempt —
      // only the greys are required to lean warm.
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      if (chroma > 24) continue
      if (r < b) cool.push(`${name}: ${hex}`)
    }
    expect(cool, 'cool neutrals in the Paper block').toEqual([])
  })

  it('scales issue tints down on paper and leaves dark at 1:1', () => {
    // A hue mixed into a light base saturates about twice as fast; without this
    // the 28% selected row becomes a flat fill, which the Tint-Never-Fill Rule
    // forbids. Set here rather than at ~28 call sites.
    expect(light).toContain('--issue-tint-scale: 0.4%')
    expect(light).toContain('--issue-line-scale: 0.8%')
    expect(dark).toContain('--issue-tint-scale: 1%')
    expect(dark).toContain('--issue-line-scale: 1%')
  })

  it('gives the sidebar row one dose across both appearances', () => {
    // POD-1456. The general scale is held down for surfaces that carry tint
    // across half the window; a 306px work row is not one of them, and at paper's
    // 0.4% its hue was visible without being nameable. The row therefore rides
    // its own scale, at the SAME value in both blocks: an issue's colour should
    // be the same statement whichever theme you are in.
    const scale = (blk: string, token: string) =>
      Number.parseFloat(new RegExp(`${token}:\\s*([\\d.]+)%`).exec(blk)?.[1] ?? 'NaN')
    expect(light).toContain('--issue-row-tint-scale: 1%')
    expect(dark).toContain('--issue-row-tint-scale: 1%')
    expect(scale(light, '--issue-row-tint-scale')).toBe(scale(dark, '--issue-row-tint-scale'))
    // The split is the whole point of the token: equal ROW doses must not be
    // achieved by letting paper's general scale drift up to meet dark's, which
    // is what would put the deck fade and the tab strip back where POD-725
    // found them claiming the centre of the window.
    expect(scale(light, '--issue-tint-scale')).toBeLessThan(scale(dark, '--issue-tint-scale'))
    expect(scale(light, '--issue-row-tint-scale')).toBeGreaterThan(
      scale(light, '--issue-tint-scale'),
    )
  })

  it('never assigns the light fill to a text token', () => {
    // --attention is a `color:` in six places (styles.css .chat-next,
    // text-attention in UnifiedIssueRow/sidebar-common/the Flight Deck).
    // Bisque measures 1.6:1 on paper — exactly the constraint the yellow it
    // replaced had — so the fill must never reach a text token here.
    // Bisque fills; bronze writes.
    const attention = /--attention:\s*(#[0-9a-f]{6})/i.exec(light)?.[1]
    expect(attention?.toLowerCase()).not.toBe('#d9b477')
    expect(attention?.toLowerCase()).toBe('#7a6134')
    // The fill takes the bisque accent.
    expect(light).toContain('--primary: #d9b477')
  })

  it('collapses fill and ink onto one accent in dark, warning held apart', () => {
    // Rule 3 after the bisque swap: bisque clears 9.9:1 on the dark ground, so
    // --primary and --attention stop diverging and become one value. The yellow
    // is demoted rather than deleted — it is the only high-chroma warm left, and
    // it must stay distinct from the accent or "alarm" and "material" collapse
    // into the same signal.
    const hex = (blk: string, token: string) =>
      new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(blk)?.[1]?.toLowerCase()
    expect(hex(dark, '--attention')).toBe(hex(dark, '--primary'))
    expect(hex(dark, '--primary')).toBe('#d9b477')
    expect(hex(dark, '--warning')).toBe('#f5c518')
    expect(hex(dark, '--warning')).not.toBe(hex(dark, '--primary'))
  })

  it('gives the primary button a rim in both appearances', () => {
    // The yellow carried its own silhouette on warm stone, so light set this to
    // `transparent`. Bisque, at half the chroma, does not — .btn-primary-rim is
    // the whole reason the button still reads as an object.
    expect(light).toContain('--primary-rim: #b08c4e')
    expect(dark).toContain('--primary-rim: #e8ca97')
    expect(light).not.toContain('--primary-rim: transparent')
  })

  it('keeps the utilities reading the scales rather than a hardcoded 1%', () => {
    // If someone reinlines `* 1%`, every light-mode tint silently doubles.
    expect(css).not.toMatch(/--value\(integer\) \* 1%/)
    expect(css).toContain('--value(integer) * var(--issue-tint-scale, 1%)')
    expect(css).toContain('--value(integer) * var(--issue-line-scale, 1%)')
  })
})

describe('theme inventory', () => {
  it('contains only the Podium selector', () => {
    const names = [...css.matchAll(/^\[data-theme="([^"]+)"\][^{]*\{/gm)].map((m) => m[1])
    expect([...new Set(names)]).toEqual(['podium'])
  })
})

describe('THEME_BG', () => {
  it('mirrors each Podium block --background, for the anti-flash script', () => {
    // index.html duplicates this map pre-React; a mismatch flashes the wrong
    // colour on every cold load.
    expect(THEME_BG.light).toBe(/--background:\s*(#[0-9a-f]{6})/i.exec(light)?.[1])
    expect(THEME_BG.dark).toBe(/--background:\s*(#[0-9a-f]{6})/i.exec(dark)?.[1])
  })
})
