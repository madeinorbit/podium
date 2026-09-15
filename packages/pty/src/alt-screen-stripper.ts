/**
 * One-shot, split-safe strip of the alt-screen chrome the abduco client prints.
 *
 * MOVED from `packages/pty/src/abduco.ts` (`createAltScreenStripper`): a title/
 * alt-screen is output interpretation, so it belongs in `./screen` (P2c). The
 * implementation is verbatim; `abduco.ts` keeps re-exporting it so the move
 * changes no importer, and the screen door is its canonical home.
 */

const ATTACH_CHROME = Buffer.from('\x1b[?1049h\x1b[H', 'latin1')
const EMPTY = new Uint8Array(0)

/**
 * One-shot, split-safe strip of the alt-screen chrome the abduco client prints when
 * it attaches with a tty stdin. Forwarding it would push the whole session into
 * xterm.js's alternate buffer and kill scrollback — the exact bug class this module
 * exists to remove. Holds back at most ATTACH_CHROME.length bytes, only until the
 * first divergence, and is a pure passthrough afterward.
 */
export function createAltScreenStripper(): (data: Uint8Array) => Uint8Array {
  let held = Buffer.alloc(0)
  let done = false
  return (data: Uint8Array): Uint8Array => {
    if (done) return data
    held = Buffer.concat([held, Buffer.from(data)])
    if (
      held.length <= ATTACH_CHROME.length &&
      ATTACH_CHROME.subarray(0, held.length).equals(held)
    ) {
      if (held.length === ATTACH_CHROME.length) {
        done = true // full prefix seen — swallow it
        return EMPTY
      }
      return EMPTY // still a plausible prefix — keep holding
    }
    done = true
    return held.length >= ATTACH_CHROME.length &&
      held.subarray(0, ATTACH_CHROME.length).equals(ATTACH_CHROME)
      ? held.subarray(ATTACH_CHROME.length)
      : held
  }
}
