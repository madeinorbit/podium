// @vitest-environment happy-dom
//
// Browser key -> bytes fidelity. This is the hop the PTY-level keyecho suite cannot
// see: keyecho injects raw bytes into agent-bridge, so it proves "byte X survives to
// the agent" but says nothing about whether xterm produces the RIGHT bytes for a given
// physical key + modifiers + keyboard layout. That translation lives in xterm's
// keydown handler (governed by `macOptionIsMeta`), and it is exactly where the
// "Option/Alt keys do nothing on a Swiss Mac" bug lived.
//
// Two fidelity gotchas this harness has to defeat to behave like a real browser:
//  1. xterm computes `isMac` ONCE at module load from navigator.platform, but it
//     short-circuits to platform='node' (isMac=false) whenever `process.title` exists
//     -- which it always does under vitest. We delete process.title BEFORE importing
//     xterm so it reads navigator and believes it is on macOS. Without this the test
//     silently exercises the Linux Alt-as-Meta path and the macOS branch is never hit.
//  2. On macOS the composed character (Option+5 -> "[") does NOT arrive on `keydown`;
//     the OS composes it and fires a follow-up `input` event -- but only if xterm let
//     the keydown through (didn't preventDefault). `pressKey` models that contract.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let savedTitle: string | undefined

beforeAll(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    configurable: true,
  })
  savedTitle = process.title
  // Force xterm's isMac=true (see header note 1).
  delete (process as { title?: string }).title
  // xterm's renderer touches ResizeObserver, which happy-dom lacks.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterAll(() => {
  if (savedTitle !== undefined) process.title = savedTitle
})

interface PhysicalKey {
  /** KeyboardEvent.key the browser reports (already composed on macOS, e.g. "["). */
  key: string
  /** KeyboardEvent.code -- the physical key, layout-independent (e.g. "Digit5"). */
  code: string
  /** Legacy keyCode -- the physical key code xterm's keydown handler reads. */
  keyCode: number
  altKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * Drive one physical keypress through xterm the way a real browser would and return
 * the bytes xterm emits on `onData` (i.e. what Podium sends over the WebSocket).
 *
 * `composed` is the character the OS keyboard layer would insert (the `input` event
 * payload). It is delivered only when xterm does not preventDefault the keydown --
 * the same gate the real browser applies for third-level-shift (Option/AltGr) compose.
 */
function pressKey(
  textarea: HTMLTextAreaElement,
  out: string[],
  pk: PhysicalKey,
  composed?: string,
): string {
  const start = out.length
  const kd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...pk })
  textarea.dispatchEvent(kd)
  if (!kd.defaultPrevented) {
    // A real browser fires keypress for Enter unless the keydown was
    // default-prevented. This is how the "shift-enter submits anyway" bug
    // escaped: xterm's keypress path emits a bare CR for Enter even when the
    // custom keydown handler returned false — only preventDefault stops it.
    // (Printable keys are modeled by the `input` event below instead; a
    // synthetic keypress lacks the charCode fidelity xterm needs for those.)
    if (pk.key === 'Enter') {
      textarea.dispatchEvent(
        new KeyboardEvent('keypress', { bubbles: true, cancelable: true, ...pk }),
      )
    }
    if (composed !== undefined) {
      textarea.dispatchEvent(
        new InputEvent('input', { data: composed, inputType: 'insertText', bubbles: true }),
      )
    }
  }
  textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...pk }))
  return out.slice(start).join('')
}

describe('TerminalView keyboard fidelity (macOS)', () => {
  let view: { mount(el: HTMLElement): void; onData(cb: (d: string) => void): () => void }
  let textarea: HTMLTextAreaElement
  const out: string[] = []

  beforeAll(async () => {
    const { TerminalView } = await import('./terminal-view')
    const el = document.createElement('div')
    document.body.appendChild(el)
    view = new TerminalView({ cols: 80, rows: 24 })
    view.mount(el)
    view.onData((d) => out.push(d))
    const ta = el.querySelector('textarea')
    if (!ta) throw new Error('xterm helper textarea not found')
    textarea = ta
  })

  it('sends a plain character unchanged', () => {
    expect(pressKey(textarea, out, { key: 'a', code: 'KeyA', keyCode: 65 }, 'a')).toBe('a')
  })

  // The regression. On non-US Mac layouts these glyphs are ONLY reachable via Option,
  // so they are essential for coding. With macOptionIsMeta:true xterm hijacked Option
  // as Meta and emitted ESC+<digit> (e.g. "\x1b5") -- the character never arrived and
  // the keystroke read as a dead Meta chord. macOptionIsMeta:false lets the OS compose.
  const swiss: Array<[string, PhysicalKey, string]> = [
    ['Option+5 -> [', { key: '[', code: 'Digit5', keyCode: 53, altKey: true }, '['],
    ['Option+6 -> ]', { key: ']', code: 'Digit6', keyCode: 54, altKey: true }, ']'],
    ['Option+8 -> {', { key: '{', code: 'Digit8', keyCode: 56, altKey: true }, '{'],
    ['Option+9 -> }', { key: '}', code: 'Digit9', keyCode: 57, altKey: true }, '}'],
  ]
  for (const [name, pk, composed] of swiss) {
    it(`composes ${name} (Option as third-level shift, not Meta)`, () => {
      expect(pressKey(textarea, out, pk, composed)).toBe(composed)
    })
  }

  // Option must still behave as Meta for non-composing special keys (keyCode < 48), so
  // Claude Code's Option+Enter = newline keeps working. This is the half of the tradeoff
  // that macOptionIsMeta:false must NOT break.
  it('keeps Option+Enter as Meta+Enter (ESC CR) for Claude Code newline', () => {
    expect(
      pressKey(textarea, out, { key: 'Enter', code: 'Enter', keyCode: 13, altKey: true }),
    ).toBe('\x1b\r')
  })

  // Shift+Enter is the everyday "newline without submitting" chord. The browser
  // hands xterm a bare CR for it (same as Enter), so without intervention Claude
  // Code submits. We rewrite it to the same ESC CR newline Option+Enter sends.
  it('rewrites Shift+Enter to a newline (ESC CR), not a submit', () => {
    expect(
      pressKey(textarea, out, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true }),
    ).toBe('\x1b\r')
  })

  // Plain Enter must still submit (bare CR) — the rewrite is Shift-only.
  it('leaves plain Enter as a submit (CR)', () => {
    expect(pressKey(textarea, out, { key: 'Enter', code: 'Enter', keyCode: 13 })).toBe('\r')
  })

  // Cmd+Backspace = "delete to line start" on macOS. The browser never delivers
  // the chord to xterm's keydown path, so we rewrite it to Ctrl+U (0x15) — the
  // kill-line byte Claude Code and readline expect.
  it('rewrites Cmd+Backspace to kill-line (Ctrl+U)', () => {
    expect(
      pressKey(textarea, out, { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true }),
    ).toBe('\x15')
  })

  // Cmd+Left/Right = jump to line start/end on macOS. xterm has no encoding for
  // a Meta-modified arrow (the chord otherwise dies), so we rewrite to the emacs
  // line-motion bytes Claude Code and readline honor.
  it('rewrites Cmd+Left to beginning-of-line (Ctrl+A)', () => {
    expect(
      pressKey(textarea, out, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, metaKey: true }),
    ).toBe('\x01')
  })

  it('rewrites Cmd+Right to end-of-line (Ctrl+E)', () => {
    expect(
      pressKey(textarea, out, {
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 39,
        metaKey: true,
      }),
    ).toBe('\x05')
  })

  // Plain arrows must keep their normal cursor sequences — the rewrite is Cmd-only.
  it('leaves plain Left/Right as CSI cursor moves', () => {
    expect(pressKey(textarea, out, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })).toBe(
      '\x1b[D',
    )
    expect(pressKey(textarea, out, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })).toBe(
      '\x1b[C',
    )
  })

  // Plain Backspace must stay a single-char delete (DEL).
  it('leaves plain Backspace as DEL (0x7f)', () => {
    expect(pressKey(textarea, out, { key: 'Backspace', code: 'Backspace', keyCode: 8 })).toBe(
      '\x7f',
    )
  })
})
