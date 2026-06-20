import { describe, expect, it } from 'vitest'
import type { BufferLike } from './buffer-line'
import { findUrlMatches, makeUrlLinkProvider } from './url-link-provider'

// Fake xterm buffer: rows of strings; `wrapped[y]` marks a SOFT (reflow) wrap.
function fakeBuf(rows: string[], wrapped: boolean[] = [], width?: number): BufferLike {
  return {
    getLine(y: number) {
      const s = rows[y]
      if (s === undefined) return undefined
      const lineWidth = Math.max(width ?? s.length, s.length)
      return {
        length: lineWidth,
        isWrapped: wrapped[y] === true,
        getCell(x: number) {
          if (x >= lineWidth) return undefined
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

function linksFor(buf: BufferLike, row1: number): Array<{ text: string; sy: number; ey: number }> {
  const opened: string[] = []
  const provider = makeUrlLinkProvider(
    () => buf,
    () => ({ onOpen: (u) => opened.push(u) }),
  )
  let got: Array<{ text: string; sy: number; ey: number }> = []
  provider.provideLinks(row1, (links) => {
    got = (links ?? []).map((l) => ({ text: l.text, sy: l.range.start.y, ey: l.range.end.y }))
  })
  return got
}

describe('findUrlMatches', () => {
  it('trims trailing sentence punctuation', () => {
    const cells = [...'see https://example.com/a).'].map((char, x) => ({
      char,
      x,
      y: 0,
      styled: false,
    }))
    const m = findUrlMatches(cells)
    expect(m).toHaveLength(1)
    expect(m[0]!.url).toBe('https://example.com/a')
  })
})

describe('makeUrlLinkProvider', () => {
  it('links a single-line URL', () => {
    const buf = fakeBuf(['see https://example.com/a here'])
    const links = linksFor(buf, 1)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com/a')
    expect(links[0]!.sy).toBe(1) // single row
    expect(links[0]!.ey).toBe(1)
  })

  it('stitches a SOFT-wrapped URL into one whole link', () => {
    // cols=20: row0 fills to the edge, row1 is a soft (reflow) continuation.
    const buf = fakeBuf(['https://example.com/', 'abcdefg'], [false, true])
    const links = linksFor(buf, 1) // query the first row
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com/abcdefg')
    expect(links[0]!.ey).toBeGreaterThan(links[0]!.sy) // spans 2 rows
  })

  it('stitches a HARD-wrapped URL (Claude hang-indent) — the reported bug', () => {
    // row0 fills the width and is NOT wrapped; row1 is a real new line with a 2-space
    // hang indent continuing the URL. The whole URL must come back from BOTH rows.
    const buf = fakeBuf(['https://example.com/', '  abcdefg'], [false, false])
    const fromTop = linksFor(buf, 1)
    expect(fromTop, 'top row yields the FULL url (not just line 1)').toHaveLength(1)
    expect(fromTop[0]!.text).toBe('https://example.com/abcdefg')
    expect(fromTop[0]!.ey).toBeGreaterThan(fromTop[0]!.sy)

    const fromCont = linksFor(buf, 2) // clicking the continuation row also opens the full url
    expect(fromCont).toHaveLength(1)
    expect(fromCont[0]!.text).toBe('https://example.com/abcdefg')
  })

  it('stitches a zero-indent HARD-wrapped URL (Claude management/login output)', () => {
    const head = 'https://example.com/docs/abcdefghi'
    const rows = [head, 'j'.repeat(head.length), 'efghijklmnop']
    const buf = fakeBuf(rows, [false, false, false], rows[0]!.length)
    const full = rows.join('')

    const fromTop = linksFor(buf, 1)
    expect(fromTop, 'top row yields the FULL url (not just line 1)').toHaveLength(1)
    expect(fromTop[0]!.text).toBe(full)
    expect(fromTop[0]!.ey).toBeGreaterThan(fromTop[0]!.sy)

    const fromCont = linksFor(buf, 2)
    expect(fromCont).toHaveLength(1)
    expect(fromCont[0]!.text).toBe(full)
  })

  it('does not hard-wrap-stitch an unrelated indented next line', () => {
    // row0 does NOT fill the width → the next indented line is not a continuation.
    const buf = fakeBuf(['https://example.com/a', '  some other text'], [false, false])
    const links = linksFor(buf, 1)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com/a')
    expect(links[0]!.ey).toBe(links[0]!.sy) // single row, no bogus stitch
  })

  it('does not zero-indent-stitch when the URL row did not reach the right edge', () => {
    const buf = fakeBuf(['https://example.com/a', 'nexttoken'], [false, false], 80)
    const links = linksFor(buf, 1)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com/a')
    expect(links[0]!.ey).toBe(links[0]!.sy)
  })
})
