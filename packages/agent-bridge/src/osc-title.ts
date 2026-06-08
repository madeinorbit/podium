/**
 * Incremental scanner for OSC terminal-title sequences in a PTY byte stream.
 *
 * Agents announce their human name by setting the terminal title — Claude Code's
 * `/rename`, Codex's thread name, tmux windows, and custom shell prompts all do
 * it the same way: `ESC ] 0|1|2 ; <title> (BEL | ESC \)`. The daemon already sees
 * every decoded PTY chunk, so feeding them through this scanner is the one place
 * that turns "an agent renamed itself" into a value, regardless of which agent.
 *
 * `push` returns each *completed* title found in the chunk, in order. Titles are
 * returned verbatim (spinner/brand glyphs and all); the caller decides how to
 * filter and present them. The scanner only observes — it never mutates or
 * consumes the stream the terminal also renders.
 */

const ESC = '\x1b'
const BEL = '\x07'

type State = 'ground' | 'esc' | 'osc' | 'oscEsc'

export interface TitleScanner {
  /** Feed one raw PTY chunk; returns titles completed within it, in order. */
  push(chunk: string): string[]
}

export function createTitleScanner(options: { maxLength?: number } = {}): TitleScanner {
  // Bound on the OSC body so a malformed, never-terminated sequence can't grow
  // the buffer without limit. Real titles are short; anything longer is junk.
  const maxLength = options.maxLength ?? 4096
  let state: State = 'ground'
  let body = ''

  const complete = (out: string[]): void => {
    // body is "<Ps>;<text>"; only the window/icon-title commands carry a name.
    const sep = body.indexOf(';')
    if (sep !== -1) {
      const ps = body.slice(0, sep).trim()
      if (ps === '0' || ps === '1' || ps === '2') out.push(body.slice(sep + 1))
    }
    body = ''
    state = 'ground'
  }

  const abort = (): void => {
    body = ''
    state = 'ground'
  }

  return {
    push(chunk: string): string[] {
      const out: string[] = []
      // Iterate by code point so multi-byte glyphs survive intact.
      for (const ch of chunk) {
        switch (state) {
          case 'ground':
            if (ch === ESC) state = 'esc'
            break
          case 'esc':
            if (ch === ']') {
              state = 'osc'
              body = ''
            } else if (ch !== ESC) {
              // Some other escape (CSI, etc.) — not ours. A repeated ESC keeps us
              // waiting for the next byte.
              state = 'ground'
            }
            break
          case 'osc':
            if (ch === BEL) {
              complete(out)
            } else if (ch === ESC) {
              state = 'oscEsc'
            } else {
              body += ch
              if (body.length > maxLength) abort()
            }
            break
          case 'oscEsc':
            if (ch === '\\') {
              complete(out) // ST terminator: ESC \
            } else if (ch === ESC) {
              // Malformed; this ESC may begin a fresh sequence.
              body = ''
              state = 'esc'
            } else {
              abort()
            }
            break
        }
      }
      return out
    },
  }
}
