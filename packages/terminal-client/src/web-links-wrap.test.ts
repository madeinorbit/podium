// @vitest-environment happy-dom
//
// Regression guard for the "wrapped (multiline) URL not clickable" bug, reported on
// mobile where the narrow terminal makes a URL wrap onto several rows.
//
// ROOT CAUSE (a): the stock @xterm/addon-web-links v0.11.0 builds a windowed string
// for the logical line under the pointer in `_getWindowedLineStrings`. Its "expand
// bottom" walk stops at the FIRST wrapped continuation row that contains a space
// (`content.indexOf(' ') !== -1`). That optimisation assumes a space always ends every
// possible link — but a URL can START *after* a space, partway through a wrapped logical
// line (e.g. agent prose "See the docs at https://…"). When the user hovers/taps the row
// where the URL visually begins, the window is truncated at the earlier space, so the
// regex only sees a fragment: the link gets a truncated `text` and a bogus `end.x === 0`,
// and that row of the URL is not clickable. The lower rows compute the URL correctly,
// so the failure is row-specific — exactly the "the top of the link doesn't work" report.
//
// FIX: a one-line local patch (patches/@xterm%2Faddon-web-links@0.11.0.patch) removes the
// space short-circuit from the BOTTOM expansion only (the TOP expansion's guard is left
// intact — walking up, a space genuinely ends the logical line). The walk is still bounded
// by `isWrapped` and the 2048-char cap, so it only ever stitches the real logical line.
//
// WHAT THIS TEST CAN / CANNOT COVER HEADLESS: xterm's buffer + reflow (which sets
// `isWrapped`) is pure data and runs fully under happy-dom with NO renderer, so the link
// provider's computed range is exercised for real. The final mouse-coord -> buffer-cell
// mapping (`getCoords`) DOES need cell measurement and cannot run headless (happy-dom
// rects are all-zero), so the literal "dispatch a tap and see it open" cannot be asserted
// here. Instead we assert the provider output that the bug corrupted, plus xterm core's
// own multi-row hit-test math, which together are the data the activation path consumes.

import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

/** Load the real addon onto a real Terminal and capture the link provider it
 *  registers, so we can drive `provideLinks(row)` exactly as xterm's Linkifier does
 *  when the pointer is over `row` (1-based). */
function captureProvider(term: Terminal): () => ILinkProvider {
  let provider: ILinkProvider | undefined
  const register = term.registerLinkProvider.bind(term)
  ;(term as unknown as { registerLinkProvider: (p: ILinkProvider) => unknown }).registerLinkProvider =
    (p: ILinkProvider) => {
      provider = p
      return register(p)
    }
  term.loadAddon(new WebLinksAddon(() => {}))
  return () => {
    if (!provider) throw new Error('addon did not register a link provider')
    return provider
  }
}

function linksForRow(provider: ILinkProvider, row: number): ILink[] {
  let got: ILink[] | undefined
  provider.provideLinks(row, (links) => {
    got = links
  })
  return got ?? []
}

/** Mirror of xterm core Linkifier._linkAtPosition: a multi-row range is linearised
 *  (y*cols + x) so a pointer on a continuation row falls between start and end. This is
 *  the exact hit-test that decides whether a tap activates the link. */
function rangeCoversCell(link: ILink, cols: number, row1: number, col1: number): boolean {
  const start = link.range.start.y * cols + link.range.start.x
  const end = link.range.end.y * cols + link.range.end.x
  const at = row1 * cols + col1
  return start <= at && at <= end
}

/** Buffer rows (0-based) that hold visible (non-blank) content. */
function occupiedRows(term: Terminal): Array<{ y: number; len: number }> {
  const buf = term.buffer.active
  const rows: Array<{ y: number; len: number }> = []
  for (let y = 0; y < buf.length; y += 1) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true).replace(/\s+$/, '')
    if (text) rows.push({ y, len: text.length })
  }
  return rows
}

describe('wrapped (multiline) URL link', () => {
  it('xterm wraps a long URL across rows headless (precondition for the rest)', async () => {
    const term = new Terminal({ cols: 20, rows: 6 })
    await new Promise<void>((res) => term.write('https://example.com/some/really/long/path/that/wraps', res))
    const rows = occupiedRows(term)
    expect(rows.length).toBeGreaterThan(1)
    expect(term.buffer.active.getLine(rows[1]!.y)!.isWrapped).toBe(true)
  })

  it('the wrapped URL stays whole when computed from EVERY row of its logical line', async () => {
    // The exact reported shape: agent prose with spaces, then a URL that wraps. The
    // logical line is `See the install guide at https://…/install` laid across rows
    // y=0..3. xterm recomputes the link from whichever row the pointer is over, so the
    // URL must come back WHOLE from all of them.
    //
    // Pre-fix, asking from the logical-line START row (the non-wrapped first row,
    // prose-only "See the install guid") truncated the URL to "https://example" with a
    // bogus end.x === 0: the addon's "expand bottom" walk stopped at the next row's
    // space ("e at …") before it ever reached the URL's tail. So the head of the link
    // was dead while the lower rows worked — the row-specific failure users saw.
    const url = 'https://example.com/docs/getting-started/install'
    const term = new Terminal({ cols: 20, rows: 10 })
    const getProvider = captureProvider(term)
    await new Promise<void>((res) => term.write(`See the install guide at ${url}`, res))

    const rows = occupiedRows(term)
    expect(rows.length).toBeGreaterThan(2) // genuinely wrapped across several rows

    for (const { y } of rows) {
      const row1 = y + 1
      const link = linksForRow(getProvider(), row1).find((l) => l.text.startsWith('https://'))
      expect(link, `row ${row1} must yield the URL link`).toBeTruthy()
      // The whole URL, never a wrap-truncated fragment like "https://example".
      expect(link!.text, `row ${row1} must yield the FULL url`).toBe(url)
      // A valid multi-row range — never the bogus end.x === 0 the bug produced.
      expect(link!.range.end.x, `row ${row1} must have a valid end.x`).toBeGreaterThan(0)
      expect(link!.range.end.y, `row ${row1} must span >1 row`).toBeGreaterThan(link!.range.start.y)
    }
  })

  it('every cell of a wrapped URL hits the link (full multi-row activation) at several widths', async () => {
    const url = 'https://example.com/some/really/long/path/that/wraps/and/keeps/going'
    for (const cols of [12, 16, 20, 28]) {
      const term = new Terminal({ cols, rows: 40 })
      const getProvider = captureProvider(term)
      await new Promise<void>((res) => term.write(url, res))

      // The single link as computed for the first row (what xterm shows on hover).
      const link = linksForRow(getProvider(), 1).find((l) => l.text === url)
      expect(link, `width ${cols}: provider must yield the full URL`).toBeTruthy()
      expect(link!.range.end.y, `width ${cols}: URL must span >1 row`).toBeGreaterThan(
        link!.range.start.y,
      )

      // Every populated cell of every row the URL occupies must fall inside the range,
      // so a tap anywhere on the link activates it.
      for (const { y, len } of occupiedRows(term)) {
        for (let c = 0; c < len; c += 1) {
          expect(
            rangeCoversCell(link!, cols, y + 1, c + 1),
            `width ${cols}: cell (row ${y + 1}, col ${c + 1}) must activate the link`,
          ).toBe(true)
        }
      }
    }
  })
})
