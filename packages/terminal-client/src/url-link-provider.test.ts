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

  it('stitches a zero-indent URL wrapped NARROWER than the terminal (Sentry login)', () => {
    // Management-mode output (login/MCP auth) wraps the URL at its own fixed width
    // (~78) even though the terminal is wider (120) — so the rows never reach the
    // terminal edge, yet they ARE one wrapped URL. All three rows must link.
    const l1 = `https://sentry.io/auth/${'a'.repeat(78 - 'https://sentry.io/auth/'.length)}`
    const l2 = 'b'.repeat(78)
    const l3 = 'c'.repeat(24)
    const rows = [l1, l2, l3]
    const buf = fakeBuf(rows, [false, false, false], 120)
    const full = rows.join('')

    const fromTop = linksFor(buf, 1)
    expect(fromTop, 'top row yields the full url').toHaveLength(1)
    expect(fromTop[0]!.text).toBe(full)
    expect(fromTop[0]!.ey).toBeGreaterThan(fromTop[0]!.sy)

    expect(linksFor(buf, 2)[0]?.text).toBe(full) // middle row
    expect(linksFor(buf, 3)[0]?.text).toBe(full) // last row
  })

  it('stitches a very long URL (>2KB) across ALL its hard-wrapped rows', () => {
    // A real PostHog MCP OAuth URL is ~2.5KB — one contiguous, space-free token whose
    // huge scope list makes it far longer than the old 2048-cell stitch cap. Hard-wrapped
    // (zero indent, no gutter) at the terminal width, it must link from the FIRST row to
    // the LAST: the cap must never truncate the URL and orphan its trailing rows.
    const W = 220
    const url = `https://oauth.posthog.com/oauth/authorize/?response_type=code&client_id=x&scope=${'a%3Aread+'.repeat(280)}end`
    expect(url.length).toBeGreaterThan(2048)
    const rows: string[] = []
    for (let i = 0; i < url.length; i += W) rows.push(url.slice(i, i + W))
    const buf = fakeBuf(
      rows,
      rows.map(() => false),
      W,
    )

    const fromTop = linksFor(buf, 1)
    expect(fromTop).toHaveLength(1)
    expect(fromTop[0]!.text).toBe(url) // whole URL, not a 2048-char prefix
    expect(fromTop[0]!.ey).toBe(rows.length) // link reaches the LAST row

    const fromLast = linksFor(buf, rows.length) // hovering the last row links too
    expect(fromLast).toHaveLength(1)
    expect(fromLast[0]!.text).toBe(url)
  })

  it('does not merge a prose word that happens to follow a URL at zero indent', () => {
    // A long prose line ending in a URL, then a new sentence at zero indent: the
    // URL must stay clean, not absorb "Done".
    const buf = fakeBuf(['Open the dashboard at https://example.com', 'Done.'], [false, false], 80)
    const links = linksFor(buf, 1)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com')
    expect(links[0]!.ey).toBe(links[0]!.sy)
  })
})
