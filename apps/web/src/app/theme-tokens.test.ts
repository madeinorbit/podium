import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { THEME_BG } from './theme'

/** Source-level invariants for the Superade theme's token blocks [POD-372].
 *
 *  These are cheap string assertions on index.css rather than computed-style
 *  checks, and they exist because of a specific failure mode: a token
 *  declaration can be silently DROPPED by a malformed comment above it (the CSS
 *  parser resyncs by discarding), and nothing downstream complains — the theme
 *  just quietly falls back to another preset's value. That happened once while
 *  building Daylight: --carve-engraved vanished from the light block and the
 *  engraved column kept painting the dark theme's pure-black inset.
 *
 *  The other half is leakage. `[data-theme="superade"]` matches the dark variant
 *  too (it is `[data-theme="superade"].dark`), so every token the light block
 *  introduces MUST be restored in the dark block or it bleeds across themes.
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

const light = block('[data-theme="superade"]')
const dark = block('[data-theme="superade"].dark')

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
] as const

describe('superade token blocks', () => {
  it.each(INTRODUCED)('declares %s in the light block', (token) => {
    expect(light).toContain(`${token}:`)
  })

  it.each(INTRODUCED)('restores %s in the dark block, so it cannot leak', (token) => {
    expect(dark).toContain(`${token}:`)
  })

  it('carves light in the theme ink and dark in black', () => {
    // Black at 0.85 on paper reads as dirt, not depth — that is the whole bug
    // this theme exists to fix, so assert the two grounds never share a carve.
    expect(light).toContain('--carve-engraved: rgb(14 22 38 / 0.26)')
    expect(dark).toContain('--carve-engraved: rgb(0 0 0 / 0.85)')
  })

  it('scales issue tints down on paper and leaves dark at 1:1', () => {
    // A hue mixed into a light base saturates about twice as fast; without this
    // the 28% selected row becomes a flat fill, which the Tint-Never-Fill Rule
    // forbids. Set here rather than at ~28 call sites.
    expect(light).toContain('--issue-tint-scale: 0.5%')
    expect(light).toContain('--issue-line-scale: 0.85%')
    expect(dark).toContain('--issue-tint-scale: 1%')
    expect(dark).toContain('--issue-line-scale: 1%')
  })

  it('never assigns Superade Yellow to a text token in light', () => {
    // --attention is a `color:` in six places (styles.css .chat-next,
    // text-attention in SectionBar/TrayCard/UnifiedIssueRow/sidebar-common).
    // #f5c518 as text is 1.6:1 on paper. Yellow fills; ochre writes.
    const attention = /--attention:\s*(#[0-9a-f]{6})/i.exec(light)?.[1]
    expect(attention?.toLowerCase()).not.toBe('#f5c518')
    expect(attention?.toLowerCase()).toBe('#8a6200')
    // The fill keeps the brand yellow.
    expect(light).toContain('--primary: #f5c518')
  })

  it('keeps the utilities reading the scales rather than a hardcoded 1%', () => {
    // If someone reinlines `* 1%`, every light-mode tint silently doubles.
    expect(css).not.toMatch(/--value\(integer\) \* 1%/)
    expect(css).toContain('--value(integer) * var(--issue-tint-scale, 1%)')
    expect(css).toContain('--value(integer) * var(--issue-line-scale, 1%)')
  })
})

describe('THEME_BG', () => {
  it('mirrors each superade block --background, for the anti-flash script', () => {
    // index.html duplicates this map pre-React; a mismatch flashes the wrong
    // colour on every cold load.
    expect(THEME_BG['superade-light']).toBe(/--background:\s*(#[0-9a-f]{6})/i.exec(light)?.[1])
    expect(THEME_BG['superade-dark']).toBe(/--background:\s*(#[0-9a-f]{6})/i.exec(dark)?.[1])
  })
})
