/**
 * POD-6256: the daemon's headless screen threw `lines.get(ybase + y)` is
 * undefined (`.isWrapped = false` in xterm's lineFeed) from a parse timer, and
 * only the safety net kept the daemon alive.
 *
 * Cause: xterm 5.5.0's `_reflowSmaller` can move `ybase` down by one without
 * room for it when the buffer holds exactly `rows` lines, which is what
 * `scrollback: 0` means. Narrowing the grid with a long line above a cursor on
 * the second-to-last row leaves `ybase + rows` one past the end of the line
 * list; the next line feed onto the bottom row then reads a missing line.
 *
 * xterm parses writes on its own timer, so the tests drive that timer with
 * fake timers: the parse error then surfaces in the test instead of as an
 * uncaught exception.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessScreen, type HeadlessScreen } from './screen-model.js'

/** Write, then run xterm's parse timer so the bytes are in the buffer now. */
function feed(screen: HeadlessScreen, data: string): void {
  screen.write(data)
  vi.runAllTimers()
}

describe('headless screen model (POD-6256)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a line feed onto the bottom row after a narrowing resize does not throw', () => {
    // The shortest sequence found from the fuzz below that throws the exact
    // daemon error. A long line wraps off the bottom, the cursor goes home
    // (leaving the alternate screen restores the saved cursor), the grid
    // narrows (reflow), then grows again.
    const screen = createHeadlessScreen(62, 3)
    feed(screen, `\x1b[3;11H${'x'.repeat(53)}\x1b[?1049l`)
    screen.resize(21, 2)
    screen.resize(37, 34)
    // Before the fix: TypeError … lines.get(ybase + y).isWrapped = false.
    expect(() => feed(screen, '\x1b[33;28H\r\n')).not.toThrow()
    expect(screen.lines(false)).toHaveLength(34)
    screen.dispose()
  })

  it('two viewers at 74x40 and 30x34 taking turns, as on 2026-11-03', () => {
    // Session 3708f8d4's applied size flipped between a 74x40 and a 30x34
    // viewer; the crash came 10 s after the flip back to 74x40.
    const screen = createHeadlessScreen(74, 40)
    // A shell after `clear` and ~1500 characters of output: the prompt sits
    // mid-screen under a long wrapped line.
    feed(screen, `\x1b[H\x1b[2J${'x'.repeat(1500)}\r\n$ `)
    screen.resize(30, 34)
    screen.resize(74, 40)
    expect(screen.lines(false)).toHaveLength(40)
    // Before the fix: the model has 39 lines for 40 rows and this throws.
    expect(() => feed(screen, '\x1b[39;1H\nOK')).not.toThrow()
    expect(screen.lines(false)[39]).toBe('OK')
    screen.dispose()
  })

  it('a row painted after narrowing the grid lands on that row', () => {
    const screen = createHeadlessScreen(10, 3)
    // A full 10-column line on row 1, then the cursor on row 2 of 3.
    feed(screen, `${'a'.repeat(10)}\x1b[2;1H`)
    // Narrowing to 4 columns reflows that line into three rows.
    screen.resize(4, 3)
    // Line-feed from row 2 onto the bottom row and paint there.
    feed(screen, '\x1b[2;1H\nZ')

    const lines = screen.lines(false)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('Z')
    screen.dispose()
  })

  it('random writes, cursor moves and resizes keep the screen readable', () => {
    let seed = 6256
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let run = 0; run < 300; run += 1) {
      let rows = 3 + rnd(30)
      let cols = 10 + rnd(60)
      const screen = createHeadlessScreen(cols, rows)
      for (let step = 0; step < 40; step += 1) {
        const kind = rnd(5)
        if (kind === 0) {
          cols = 5 + rnd(80)
          rows = 2 + rnd(40)
          screen.resize(cols, rows)
        } else if (kind === 1) feed(screen, `\x1b[${1 + rnd(rows)};${1 + rnd(cols)}H`)
        else if (kind === 2) feed(screen, 'x'.repeat(rnd(200)))
        else if (kind === 3) feed(screen, '\r\n'.repeat(1 + rnd(3)))
        else feed(screen, rnd(2) ? '\x1b[?1049h' : '\x1b[?1049l')
        // The model is the visible screen: exactly one line per row.
        expect(screen.lines(false)).toHaveLength(rows)
      }
      screen.dispose()
    }
  })
})
