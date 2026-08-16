import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetaGlyph } from './MetaGlyph'

/**
 * The foot glyphs were drawn twice from lucide and reported wrong twice — the
 * shapes and the weight both differ from the handoff's Material Symbols
 * Rounded. These assertions pin the properties that made the difference visible,
 * so a well-meaning "use the icon set everyone else uses" cannot land silently.
 */
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('MetaGlyph', () => {
  const render = (name: 'copy' | 'quote' | 'check' | 'close'): SVGSVGElement => {
    act(() => root.render(<MetaGlyph name={name} />))
    return host.querySelector('svg')!
  }

  it('draws on the design font’s own em box, at its 13px', () => {
    const svg = render('copy')
    // Material Symbols' 960-unit em with a baseline at 0 — not lucide's 0 0 24 24.
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960')
    expect(svg.getAttribute('width')).toBe('13')
    expect(svg.getAttribute('height')).toBe('13')
  })

  it('is filled ink, not a stroke', () => {
    // The weight difference that read as "heavier": lucide paints a 1.75-unit
    // outline, a Material glyph is a filled shape and carries no stroke at all.
    const svg = render('copy')
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('stroke')).toBeNull()
    expect(svg.querySelector('path')?.getAttribute('stroke-width')).toBeNull()
  })

  it('is `format_quote` — the "99" comma pair, not a pair of quote boxes', () => {
    const quote = render('quote')!.querySelector('path')!.getAttribute('d')!
    // A comma pair is four curved subpaths — two tails, two bowls. lucide's
    // Quote is two straight-edged blocks and would be a fraction of this.
    expect((quote.match(/z/gi) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((quote.match(/q/gi) ?? []).length).toBeGreaterThan(0)
    expect(quote.length).toBeGreaterThan(900)
  })

  it('hides itself from the accessibility tree — the button carries the label', () => {
    expect(render('close').getAttribute('aria-hidden')).toBe('true')
  })
})
