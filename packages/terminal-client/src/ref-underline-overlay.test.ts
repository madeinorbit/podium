// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { BufferLike, Cell } from './buffer-line'
import { mentionRects, RefUnderlineOverlay, type ViewportBufferLike } from './ref-underline-overlay'

/** Build a row of unstyled cells from a string. */
function cells(text: string, y = 0): Cell[] {
  return [...text].map((char, x) => ({ char, x, y, styled: false }))
}

const known = (p: string): boolean => p === 'POD' || p === 'WEB'

describe('mentionRects', () => {
  it('positions one rect per mention in cell geometry', () => {
    const rows = [cells('no refs here'), cells('see POD-13 now', 1)]
    const rects = mentionRects(rows, known, 8, 17)
    expect(rects).toEqual([{ left: 4 * 8, top: 1 * 17, width: 6 * 8, height: 17 }])
  })

  it('handles multiple mentions and skips unknown prefixes', () => {
    const rows = [cells('POD-1 UTF-8 WEB-22')]
    const rects = mentionRects(rows, known, 10, 20)
    expect(rects).toEqual([
      { left: 0, top: 0, width: 5 * 10, height: 20 },
      { left: 12 * 10, top: 0, width: 6 * 10, height: 20 },
    ])
  })

  it('uses real buffer columns, so wide glyphs earlier in the row keep rects aligned', () => {
    // '漢' occupies columns 0-1; its spacer cell is already dropped, so the
    // token's cells carry x=3.. — the rect must come from x, not array index.
    const row: Cell[] = [
      { char: '漢', x: 0, y: 0, styled: false },
      { char: ' ', x: 2, y: 0, styled: false },
      ...[...'POD-7'].map((char, i) => ({ char, x: 3 + i, y: 0, styled: false })),
    ]
    const rects = mentionRects([row], known, 8, 17)
    expect(rects).toEqual([{ left: 3 * 8, top: 0, width: 5 * 8, height: 17 }])
  })

  it('returns nothing for empty rows', () => {
    expect(mentionRects([[], []], known, 8, 17)).toEqual([])
  })
})

// Fake buffer over rows of plain strings, including translateToString so the
// overlay's cheap per-row pre-filter is exercised.
function fakeBuf(rows: string[], viewportY = 0): ViewportBufferLike {
  const buf: BufferLike & { viewportY: number } = {
    viewportY,
    getLine(y: number) {
      const s = rows[y]
      if (s === undefined) return undefined
      return {
        length: s.length,
        isWrapped: false,
        translateToString: () => s,
        getCell(x: number) {
          if (x >= s.length) return undefined
          return {
            getChars: () => s[x] ?? ' ',
            getWidth: () => 1,
            isBold: () => false,
            isUnderline: () => false,
            getFgColor: () => -1,
            getFgColorMode: () => 0,
          }
        },
      }
    },
  }
  return buf
}

function makeOverlay(rows: string[], prefix: ((p: string) => boolean) | null = known) {
  const screen = document.createElement('div')
  document.body.appendChild(screen)
  // happy-dom has no layout; give the screen a measured size (80×24 grid at 8×17).
  screen.getBoundingClientRect = () =>
    ({ width: 640, height: 408, left: 0, top: 0, right: 640, bottom: 408 }) as DOMRect
  const overlay = new RefUnderlineOverlay({
    screen,
    getBuffer: () => fakeBuf(rows),
    getCols: () => 80,
    getRows: () => 24,
    getIsKnownPrefix: () => prefix,
  })
  return { screen, overlay }
}

const visibleRects = (screen: HTMLElement): HTMLElement[] =>
  [...screen.querySelectorAll<HTMLElement>('.podium-ref-underlines > div')].filter(
    (el) => el.style.display !== 'none',
  )

describe('RefUnderlineOverlay', () => {
  it('draws pooled underline divs for visible mentions and hides them when gone', () => {
    const rows = ['see POD-13 now', 'and WEB-2']
    const { screen, overlay } = makeOverlay(rows)
    overlay.refreshNow()
    const shown = visibleRects(screen)
    expect(shown).toHaveLength(2)
    expect(shown[0]?.style.left).toBe(`${4 * 8}px`)
    expect(shown[0]?.style.width).toBe(`${6 * 8}px`)
    expect(shown[1]?.style.top).toBe('17px')

    // Mentions scroll away → the SAME pooled nodes are hidden, not destroyed.
    rows.splice(0, rows.length, 'plain output')
    overlay.refreshNow()
    expect(visibleRects(screen)).toHaveLength(0)
    expect(screen.querySelectorAll('.podium-ref-underlines > div')).toHaveLength(2)
    overlay.dispose()
  })

  it('stays empty while ref links are unconfigured', () => {
    const { screen, overlay } = makeOverlay(['see POD-13 now'], null)
    overlay.refreshNow()
    expect(visibleRects(screen)).toHaveLength(0)
    overlay.dispose()
  })

  it('dispose removes the layer', () => {
    const { screen, overlay } = makeOverlay(['POD-1'])
    overlay.refreshNow()
    expect(screen.querySelector('.podium-ref-underlines')).toBeTruthy()
    overlay.dispose()
    expect(screen.querySelector('.podium-ref-underlines')).toBeNull()
  })
})
