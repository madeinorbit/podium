import { anyRefMatcher, parseAnyRef } from '@podium/protocol'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import type { BufferLike, Cell } from './buffer-line'
import { RefHoverTooltip } from './ref-hover-tooltip'

/**
 * Clickable human-facing ref tokens in terminal output (#474, area 6b):
 * `PREFIX-N`, `PREFIX-N-LETTER`, `PREFIX-DRAFT-N`. Only tokens whose prefix is
 * registered (a real repo) are linked — otherwise every `UTF-8` would light up.
 *
 * Refs are short single-line tokens, so — unlike the URL provider — there is no
 * soft/hard-wrap stitching: a match is found within one buffer row.
 */

export interface RefLinkConfig {
  /** Only tokens with a registered repo prefix become links. */
  isKnownPrefix: (prefix: string) => boolean
  /** Activate a ref token; the MouseEvent carries the modifier (Cmd/Ctrl). */
  onActivate: (ref: string, event: MouseEvent) => void
}

// A ref token is short; cap the scanned row so a pathological line can't drive
// expensive work in provideLinks (xterm calls it per render on hover).
const MAX_ROW_CELLS = 2048

/** Visible cells of a row (skips wide-glyph spacer halves). Exported for the
 *  persistent underline overlay, which scans the same cells per viewport row. */
export function rowCells(buf: BufferLike, y: number): Cell[] {
  const line = buf.getLine(y)
  if (!line) return []
  const out: Cell[] = []
  for (let x = 0; x < line.length && out.length < MAX_ROW_CELLS; x += 1) {
    const c = line.getCell(x)
    if (!c) continue
    if (c.getWidth() === 0) continue
    out.push({ char: c.getChars() || ' ', x, y, styled: false })
  }
  return out
}

/** All ref matches in a single row's cells, each with the cells it occupies. */
export function findRefMatches(
  cells: Cell[],
  isKnownPrefix: (prefix: string) => boolean,
): Array<{ ref: string; cells: Cell[] }> {
  // A cell's char can hold a whole grapheme cluster (base + combining marks),
  // so joined-text indices and cell indices diverge. Map every text index back
  // to its cell so link rectangles don't shift right of the token.
  let text = ''
  const cellForTextIndex: number[] = []
  for (let ci = 0; ci < cells.length; ci++) {
    const chars = cells[ci]?.char || ' ' // defensive: an empty cell still occupies one column
    for (let k = 0; k < chars.length; k++) cellForTextIndex.push(ci)
    text += chars
  }
  const out: Array<{ ref: string; cells: Cell[] }> = []
  for (const m of text.matchAll(anyRefMatcher())) {
    const tok = m[0]
    const parsed = parseAnyRef(tok)
    if (!parsed || !isKnownPrefix(parsed.prefix)) continue
    const start = m.index ?? 0
    const firstCell = cellForTextIndex[start]
    const lastCell = cellForTextIndex[start + tok.length - 1]
    if (firstCell === undefined || lastCell === undefined) continue
    out.push({ ref: tok, cells: cells.slice(firstCell, lastCell + 1) })
  }
  return out
}

/** Build an xterm ILinkProvider for human-facing refs. */
export function makeRefLinkProvider(
  getBuffer: () => BufferLike,
  getConfig: () => RefLinkConfig | null,
): ILinkProvider {
  // One tooltip per provider (= per terminal); xterm guarantees leave fires
  // before the next hover, so a single element suffices.
  const tooltip = new RefHoverTooltip()
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const cfg = getConfig()
      if (!cfg) {
        callback(undefined)
        return
      }
      const row = bufferLineNumber - 1 // xterm rows are 1-based here
      const links: ILink[] = findRefMatches(rowCells(getBuffer(), row), cfg.isKnownPrefix).flatMap(
        (m) => {
          const first = m.cells[0]
          const last = m.cells[m.cells.length - 1]
          if (!first || !last) return []
          return [
            {
              text: m.ref,
              range: {
                start: { x: first.x + 1, y: first.y + 1 },
                end: { x: last.x + 1, y: last.y + 1 },
              },
              decorations: { pointerCursor: true, underline: true },
              activate: (event: MouseEvent) => {
                tooltip.hide()
                cfg.onActivate(m.ref, event)
              },
              hover: (event: MouseEvent) => tooltip.show(event),
              leave: () => tooltip.hide(),
            },
          ]
        },
      )
      callback(links.length ? links : undefined)
    },
  }
}
