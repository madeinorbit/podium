/**
 * The headless VT screen every terminal-screen reader shares (P2c).
 *
 * MOVED from `apps/daemon/src/composer-sync.ts` (`createHeadlessScreen` and
 * `ScreenReader`): it wraps `@xterm/headless` and was already shared with
 * `terminal-screen-observer.ts`, so it was a shared thing living in the wrong
 * module. This file is its one home; the daemon imports the type and the
 * factory from `@podium/process/screen` and constructs no emulator of its own.
 *
 * Harness-agnostic on purpose: no SessionId, no protocol frame, no daemon
 * context. Usable from a test that never creates a Podium session.
 */

import { Terminal } from '@xterm/headless'

/** A minimal headless VT screen: feed it PTY bytes, read the rendered lines. */
export interface ScreenReader {
  write(data: Uint8Array | string): void
  resize(cols: number, rows: number): void
  /** The rendered screen, one string per row. With `dropDim`, dim cells are blanked
   *  (matching the browser's `screenText({ dropDim })` so extraction carries over). */
  lines(dropDim: boolean): string[]
  /** Resolve once all queued writes are parsed into the buffer (the emulator parses
   *  writes asynchronously). The engine's coalesced scrape fires well after the
   *  emulator's own flush, so it doesn't need this — but a synchronous reader does. */
  flush(): Promise<void>
  dispose(): void
}

/** Read a headless Terminal's active buffer into lines — the daemon-side twin of
 *  TerminalView.screenText(), so the extractors behave identically. */
function readLines(term: Terminal, dropDim: boolean): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i += 1) {
    const line = buf.getLine(i)
    if (!dropDim || !line) {
      out.push(line?.translateToString(true) ?? '')
      continue
    }
    let row = ''
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      if (!cell) continue
      if (cell.getWidth() === 0) continue // spacer half of a wide glyph
      const chars = cell.getChars() || ' '
      row += cell.isDim() ? ' '.repeat(chars.length) : chars
    }
    out.push(row.replace(/\s+$/, ''))
  }
  return out
}

export function createHeadlessScreen(cols: number, rows: number): ScreenReader {
  // scrollback: 0 keeps the buffer bounded to the visible screen — the composer is
  // always on screen, so history would only add per-scrape cost.
  const term = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    allowProposedApi: true,
    scrollback: 0,
  })
  return {
    write: (data) => term.write(data as string),
    resize: (c, r) => term.resize(Math.max(1, c), Math.max(1, r)),
    lines: (dropDim) => readLines(term, dropDim),
    // An empty write's callback fires after all previously-queued writes are parsed.
    flush: () => new Promise<void>((resolve) => term.write('', () => resolve())),
    dispose: () => term.dispose(),
  }
}
