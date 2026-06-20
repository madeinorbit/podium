import type { ILink, ILinkProvider } from '@xterm/xterm'
import type { BufferLike, Cell } from './buffer-line'

// Unified clickable-URL provider. Replaces @xterm/addon-web-links because that addon
// only stitches SOFT (reflow) wraps. Agent TUIs (Claude Code) HARD-wrap long URLs —
// real newlines with a hang indent — so the URL is split across separate buffer lines
// and the addon links only the first line ("it ends at line 1"). This provider stitches
// BOTH soft wraps (line.isWrapped) and hard wraps (a non-wrapped continuation row that
// begins with a short indent and continues with URL characters), so the WHOLE URL is one
// clickable link from any of its rows. Single-line URLs work too.

// Characters allowed inside a URL body (xterm's own regex, minus the trailing-punct trim).
const URL_BODY = /[^\s"'`<>(){}|\\^]/
const URL_RE = /https?:\/\/[^\s"'`<>(){}|\\^]+/gi
// Trailing punctuation that is almost never part of the URL (sentence/markup noise).
const TRAILING = /[.,;:!?)\]}>'"]+$/

export interface UrlLinkConfig {
  onOpen: (url: string) => void
}

function lineCells(buf: BufferLike, y: number): Cell[] {
  const line = buf.getLine(y)
  if (!line) return []
  const out: Cell[] = []
  for (let x = 0; x < line.length; x += 1) {
    const c = line.getCell(x)
    if (!c) continue
    if (c.getWidth() === 0) continue // spacer half of a wide glyph
    out.push({ char: c.getChars() || ' ', x, y, styled: false })
  }
  return out
}

const isWrapped = (buf: BufferLike, y: number): boolean => buf.getLine(y)?.isWrapped === true

/** Right-trimmed cells of a row (drops trailing blanks). */
function trimmedRow(buf: BufferLike, y: number): Cell[] {
  const cells = lineCells(buf, y)
  let end = cells.length
  while (end > 0 && cells[end - 1]?.char === ' ') end -= 1
  return cells.slice(0, end)
}

/** True when the row's last non-blank char is a URL-body char — content ran to the
 *  row's right edge with URL text (a hard-wrap candidate). We can't key off the
 *  terminal width for indented agent TUI wraps: they can wrap at their own narrower
 *  content width. Zero-indent management output is different, so it is gated below. */
function endsWithUrlChar(buf: BufferLike, y: number): boolean {
  const t = trimmedRow(buf, y)
  const last = t[t.length - 1]
  return !!last && URL_BODY.test(last.char)
}

/** True when the row's visible text reaches the xterm row edge. */
function reachesRightEdge(buf: BufferLike, y: number): boolean {
  const line = buf.getLine(y)
  if (!line) return false
  const t = trimmedRow(buf, y)
  const last = t[t.length - 1]
  return !!last && last.x >= line.length - 1
}

interface HardWrapContinuation {
  cells: Cell[]
  indent: number
}

/** The continuation cells of a HARD-wrapped URL row: a non-wrapped row that starts
 *  with 0-3 spaces then a CONTIGUOUS (space-free) run of URL characters. The
 *  space-free requirement is what stops "https://x/a" + "  and more prose" from
 *  merging — a wrapped URL continues as one token; prose has spaces. */
function hardWrapContinuation(buf: BufferLike, y: number): HardWrapContinuation | null {
  if (isWrapped(buf, y)) return null // soft wrap is handled separately
  const cells = trimmedRow(buf, y)
  let i = 0
  while (i < cells.length && cells[i]?.char === ' ' && i < 3) i += 1
  if (i >= cells.length) return null // blank/over-indented
  const run = cells.slice(i)
  if (run.some((c) => c.char === ' ')) return null // a space → prose, not a URL tail
  if (!URL_BODY.test(run[0]?.char ?? '')) return null
  return { cells: run, indent: i }
}

function hardWrapContinuationAfter(buf: BufferLike, previousY: number): Cell[] | null {
  if (!endsWithUrlChar(buf, previousY)) return null
  const cont = hardWrapContinuation(buf, previousY + 1)
  if (!cont) return null
  if (cont.indent === 0 && !reachesRightEdge(buf, previousY)) return null
  return cont.cells
}

/** Walk UP to the first row of the logical unit containing `row`. */
function logicalStart(buf: BufferLike, row: number): number {
  let y = row
  while (y > 0) {
    if (isWrapped(buf, y)) {
      y -= 1
      continue
    }
    // hard-wrap: this row is a continuation of a URL-ending row above
    if (hardWrapContinuationAfter(buf, y - 1)) {
      y -= 1
      continue
    }
    break
  }
  return y
}

/** Build the stitched cell sequence for the logical unit starting at `startY`,
 *  joining soft-wrapped rows whole and hard-wrapped rows with their indent stripped. */
function stitchUnit(buf: BufferLike, startY: number): Cell[] {
  const cells: Cell[] = [...trimmedRow(buf, startY)]
  let y = startY
  // Cap the stitch (provideLinks runs per render on hover; a URL is never this long).
  while (buf.getLine(y + 1) && cells.length < 2048) {
    if (isWrapped(buf, y + 1)) {
      cells.push(...trimmedRow(buf, y + 1))
      y += 1
      continue
    }
    const cont = hardWrapContinuationAfter(buf, y)
    if (cont) {
      cells.push(...cont)
      y += 1
      continue
    }
    break
  }
  return cells
}

/** All URL matches in a logical unit, each with the cells it occupies (real coords). */
export function findUrlMatches(cells: Cell[]): Array<{ url: string; cells: Cell[] }> {
  const text = cells.map((c) => c.char).join('')
  const out: Array<{ url: string; cells: Cell[] }> = []
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    let url = m[0]
    const trail = url.match(TRAILING)
    const end = start + url.length - (trail ? trail[0].length : 0)
    url = text.slice(start, end)
    if (url.length > 'https://'.length) out.push({ url, cells: cells.slice(start, end) })
  }
  return out
}

/** xterm ILinkProvider that links whole URLs across soft and hard wraps. */
export function makeUrlLinkProvider(
  getBuffer: () => BufferLike,
  getConfig: () => UrlLinkConfig | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const cfg = getConfig()
      if (!cfg) {
        callback(undefined)
        return
      }
      const buf = getBuffer()
      const row = bufferLineNumber - 1 // xterm rows are 1-based here
      const start = logicalStart(buf, row)
      const links: ILink[] = findUrlMatches(stitchUnit(buf, start))
        .filter((m) => m.cells.some((c) => c.y === row)) // only links touching the queried row
        .flatMap((m) => {
          const first = m.cells[0]
          const last = m.cells[m.cells.length - 1]
          if (!first || !last) return []
          return [
            {
              text: m.url,
              range: {
                start: { x: first.x + 1, y: first.y + 1 },
                end: { x: last.x + 1, y: last.y + 1 },
              },
              activate: (_e: MouseEvent, _t: string) => cfg.onOpen(m.url),
            },
          ]
        })
      callback(links.length ? links : undefined)
    },
  }
}
