// @vitest-environment happy-dom
//
// OSC 52 → system clipboard (#24, #31). An in-terminal app's "copy to clipboard"
// (Claude Code's copy action, tmux set-clipboard) emits ESC ] 52 ; Pc ; <base64>
// BEL|ST. xterm.js parses it but ships NO handler, so without ours the agent
// reports "sent N chars via OSC 52" while the payload is silently dropped.
//
// The write is gesture-less (the sequence arrives async over the transport), and
// Safari/Firefox reject gesture-less clipboard writes (#31) — so a FAILED write
// must be held and completed inside the next real user gesture on the pane:
// the copy chord always, a mouseup only while the payload is fresh.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeOsc52, TerminalView } from './terminal-view'

const writeText = vi.fn(() => Promise.resolve())
const execCommand = vi.fn(() => true)

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  document.execCommand = execCommand as unknown as typeof document.execCommand
})

beforeEach(() => {
  writeText.mockClear()
  writeText.mockImplementation(() => Promise.resolve())
  execCommand.mockClear()
  execCommand.mockImplementation(() => true)
})

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('decodeOsc52', () => {
  it('decodes the clipboard payload', () => {
    expect(decodeOsc52(`c;${b64('hello osc52')}`)).toBe('hello osc52')
  })

  it('decodes multi-byte UTF-8 payloads', () => {
    expect(decodeOsc52(`c;${b64('héllo — ✓')}`)).toBe('héllo — ✓')
  })

  it('accepts any selection target (browser has only THE clipboard)', () => {
    expect(decodeOsc52(`p;${b64('primary')}`)).toBe('primary')
  })

  it('never answers a clipboard READ query', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('drops invalid base64 and malformed bodies without throwing', () => {
    expect(decodeOsc52('c;!!not-base64!!')).toBeNull()
    expect(decodeOsc52('no-separator')).toBeNull()
    expect(decodeOsc52('c;')).toBeNull()
  })

  it('drops payloads beyond the size bound', () => {
    expect(decodeOsc52(`c;${'A'.repeat(1_048_577)}`)).toBeNull()
  })
})

function mountView(): { view: TerminalView; el: HTMLElement } {
  const view = new TerminalView({ cols: 40, rows: 10 })
  const el = document.createElement('div')
  document.body.appendChild(el)
  view.mount(el)
  return { view, el }
}

/** The copy chord as xterm's custom key handler sees it (keydown on the pane). */
function pressCopyChord(el: HTMLElement): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: 'c',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  el.querySelector('textarea')?.dispatchEvent(ev)
  return ev
}

describe('TerminalView OSC 52 wiring', () => {
  it('a written OSC 52 sequence lands on the clipboard (BEL and ST terminators)', async () => {
    const { view } = mountView()
    view.write(`\x1b]52;c;${b64('via BEL')}\x07`)
    view.write(`\x1b]52;c;${b64('via ST')}\x1b\\`)
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('via ST'))
    expect(writeText).toHaveBeenCalledWith('via BEL')
    view.dispose()
  })

  it('a rejected gesture-less write is completed by the copy chord (execCommand)', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('NotAllowedError')))
    execCommand.mockImplementation(() => false) // gesture-less fallback fails too
    const { view, el } = mountView()

    view.write(`\x1b]52;c;${b64('held payload')}\x07`)
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(document.querySelector('textarea[readonly]')).toBeNull() // helper cleaned up

    // The chord is a real gesture: execCommand succeeds there.
    execCommand.mockClear()
    execCommand.mockImplementation(() => true)
    const ev = pressCopyChord(el)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(ev.defaultPrevented).toBe(true)
    // The flushed textarea carried the payload.
    // (legacyCopy removes it synchronously; assert via the value seen at copy time)
    view.dispose()
  })

  it('the chord flushes once — a second chord with nothing pending falls through', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('NotAllowedError')))
    execCommand.mockImplementation(() => false)
    const { view, el } = mountView()
    view.write(`\x1b]52;c;${b64('once')}\x07`)
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled())

    execCommand.mockClear()
    execCommand.mockImplementation(() => true)
    pressCopyChord(el)
    expect(execCommand).toHaveBeenCalledTimes(1)

    execCommand.mockClear()
    const second = pressCopyChord(el)
    expect(execCommand).not.toHaveBeenCalled()
    expect(second.defaultPrevented).toBe(false) // falls through to browser default
    view.dispose()
  })

  it('a fresh held payload is flushed by mouseup; a stale one is dropped', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('NotAllowedError')))
    execCommand.mockImplementation(() => false)
    const { view, el } = mountView()

    view.write(`\x1b]52;c;${b64('fresh')}\x07`)
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled())
    execCommand.mockClear()
    execCommand.mockImplementation(() => true)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(execCommand).toHaveBeenCalledWith('copy')

    // Stale: age the payload past the freshness bound — mouseup must NOT
    // clobber the clipboard, and must clear the payload.
    execCommand.mockImplementation(() => false)
    view.write(`\x1b]52;c;${b64('stale')}\x07`)
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled())
    execCommand.mockClear()
    execCommand.mockImplementation(() => true)
    const realNow = Date.now
    Date.now = () => realNow() + 60_000
    try {
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect(execCommand).not.toHaveBeenCalled()
      // …and it was dropped, not merely deferred: the chord finds nothing.
      const ev = pressCopyChord(el)
      expect(execCommand).not.toHaveBeenCalled()
      expect(ev.defaultPrevented).toBe(false)
    } finally {
      Date.now = realNow
    }
    view.dispose()
  })
})
