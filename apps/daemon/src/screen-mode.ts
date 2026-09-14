/**
 * Which screen the program is painting: the scrolling shell history, or the
 * full-screen canvas every agent TUI owns (POD-3918 P1b).
 *
 * The ONLY signal is DECSET/DECRST 1049 (`CSI ? 1049 h` / `CSI ? 1049 l`) read
 * off the output stream. 1047 is the older switch and the policy does not use
 * it, so it is deliberately ignored here.
 *
 * Split-safe: an escape sequence broken across two output chunks is still
 * detected. The tracker carries the tail of the previous chunk and rescans it
 * with the next one. Re-scanning is safe because transitions are idempotent
 * and last-wins, so seeing an old sequence again can never move the mode
 * backwards.
 */

/** The screen a session's program is currently painting. */
export type ScreenMode = 'normal' | 'alternate'

/**
 * Matches a complete DECSET/DECRST private-mode sequence and captures its
 * parameter list and final byte, e.g. `\x1b[?1049h` or `\x1b[?1049;2004l`.
 * Multi-parameter sets are real (a TUI may enable 1049 and 2004 together),
 * so 1049 is matched as a member of the list, not as the whole of it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const PRIVATE_MODE_SEQUENCE = /\x1b\[\?([0-9;]*)([hl])/g

/**
 * How much of the previous chunk is rescanned with the next one. The 1049
 * sequences real programs emit are 8 bytes (`ESC [ ? 1049 h`); 64 covers a
 * multi-parameter set with room to spare. A parameter run longer than this
 * split across three or more chunks would be missed — no TUI emits one.
 */
const CARRY_BYTES = 64

export class ScreenModeTracker {
  private mode: ScreenMode = 'normal'
  /** Latin-1 tail of the previous chunk, so a split sequence still matches. */
  private carry = ''

  /** The mode after everything written so far. */
  get current(): ScreenMode {
    return this.mode
  }

  /**
   * Feed one output chunk and return the resulting mode. Accepts the raw
   * bytes (decoded losslessly as latin1) or a string carrying the same
   * code points.
   */
  write(chunk: Uint8Array | string): ScreenMode {
    const text = this.carry + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'))
    PRIVATE_MODE_SEQUENCE.lastIndex = 0
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic exec loop
    while ((match = PRIVATE_MODE_SEQUENCE.exec(text)) !== null) {
      const params = (match[1] ?? '').split(';')
      if (!params.includes('1049')) continue
      this.mode = match[2] === 'h' ? 'alternate' : 'normal'
    }
    this.carry = text.slice(-CARRY_BYTES)
    return this.mode
  }

  /** Forget everything: back to a fresh `normal`, with no carried tail. */
  reset(): void {
    this.mode = 'normal'
    this.carry = ''
  }
}
