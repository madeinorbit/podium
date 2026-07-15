// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { BufferLike, Cell } from './buffer-line'
import { findRefMatches, makeRefLinkProvider } from './ref-link-provider'

/** Build a row of unstyled cells from a string. */
function cells(text: string): Cell[] {
  return [...text].map((char, x) => ({ char, x, y: 0, styled: false }))
}

const known = (p: string): boolean => p === 'POD' || p === 'WEB'

describe('findRefMatches', () => {
  it('matches a bare issue ref with a known prefix', () => {
    const m = findRefMatches(cells('see POD-13 now'), known)
    expect(m.map((x) => x.ref)).toEqual(['POD-13'])
    expect(m[0]?.cells[0]?.x).toBe(4)
  })

  it('matches session and draft refs', () => {
    expect(findRefMatches(cells('POD-13-A and POD-DRAFT-3'), known).map((x) => x.ref)).toEqual([
      'POD-13-A',
      'POD-DRAFT-3',
    ])
  })

  it('ignores unknown prefixes (e.g. UTF-8)', () => {
    expect(findRefMatches(cells('UTF-8 encoded'), known)).toEqual([])
    expect(findRefMatches(cells('ZZZ-9 here'), known)).toEqual([])
  })

  it('matches multiple refs on one row', () => {
    expect(findRefMatches(cells('POD-1 WEB-2'), known).map((x) => x.ref)).toEqual([
      'POD-1',
      'WEB-2',
    ])
  })

  it('keeps link cells aligned past combining-grapheme cells (char length > 1)', () => {
    // 'é' as base + combining acute lives in ONE cell but is TWO text chars —
    // without a textIndex→cellIndex map the link rectangle would shift right.
    const row: Cell[] = [
      { char: 'é', x: 0, y: 0, styled: false },
      { char: ' ', x: 1, y: 0, styled: false },
      ...[...'POD-13'].map((char, i) => ({ char, x: 2 + i, y: 0, styled: false })),
    ]
    const m = findRefMatches(row, known)
    expect(m.map((x) => x.ref)).toEqual(['POD-13'])
    expect(m[0]?.cells[0]?.x).toBe(2)
    expect(m[0]?.cells[m[0].cells.length - 1]?.x).toBe(7)
    expect(m[0]?.cells.map((c) => c.char).join('')).toBe('POD-13')
  })
})

// Fake xterm buffer over rows of plain strings (no wraps — refs are single-row).
function fakeBuf(rows: string[]): BufferLike {
  return {
    getLine(y: number) {
      const s = rows[y]
      if (s === undefined) return undefined
      return {
        length: s.length,
        isWrapped: false,
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
}

describe('makeRefLinkProvider', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const provide = () => {
    const activated: string[] = []
    const provider = makeRefLinkProvider(
      () => fakeBuf(['see POD-13 now']),
      () => ({ isKnownPrefix: known, onActivate: (ref) => activated.push(ref) }),
    )
    let links: import('@xterm/xterm').ILink[] = []
    provider.provideLinks(1, (l) => {
      links = l ?? []
    })
    return { links, activated }
  }

  it('links carry pointer + underline hover decorations', () => {
    const { links } = provide()
    expect(links).toHaveLength(1)
    expect(links[0]?.decorations).toEqual({ pointerCursor: true, underline: true })
  })

  it('hover shows the modifier tooltip; leave removes it', () => {
    const { links } = provide()
    const ev = new MouseEvent('mousemove', { clientX: 20, clientY: 20 })
    links[0]?.hover?.(ev, 'POD-13')
    const tip = document.body.lastElementChild as HTMLElement
    expect(tip?.textContent).toMatch(/^Click to preview · (⌘|Ctrl)-click to open$/)
    links[0]?.leave?.(ev, 'POD-13')
    expect(document.body.contains(tip)).toBe(false)
  })

  it('activate hides the tooltip and dispatches the ref', () => {
    const { links, activated } = provide()
    const ev = new MouseEvent('mousemove', { clientX: 20, clientY: 20 })
    links[0]?.hover?.(ev, 'POD-13')
    links[0]?.activate(new MouseEvent('click'), 'POD-13')
    expect(activated).toEqual(['POD-13'])
    expect(document.body.querySelectorAll('div')).toHaveLength(0)
  })
})
