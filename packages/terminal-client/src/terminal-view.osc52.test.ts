// @vitest-environment happy-dom
//
// OSC 52 → system clipboard (#24). An in-terminal app's "copy to clipboard"
// (Claude Code's copy action, tmux set-clipboard) emits ESC ] 52 ; Pc ; <base64>
// BEL|ST. xterm.js parses it but ships NO handler, so without ours the agent
// reports "sent N chars via OSC 52" while the payload is silently dropped.
// These tests cover the handler's decode/guard logic and the full write path
// through a live terminal.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleOsc52, TerminalView } from './terminal-view'

const writeText = vi.fn(() => Promise.resolve())

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
})

beforeEach(() => writeText.mockClear())

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('handleOsc52', () => {
  it('decodes the clipboard payload and writes it', () => {
    expect(handleOsc52(`c;${b64('hello osc52')}`)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello osc52')
  })

  it('decodes multi-byte UTF-8 payloads', () => {
    handleOsc52(`c;${b64('héllo — ✓')}`)
    expect(writeText).toHaveBeenCalledWith('héllo — ✓')
  })

  it('accepts any selection target (browser has only THE clipboard)', () => {
    handleOsc52(`p;${b64('primary')}`)
    expect(writeText).toHaveBeenCalledWith('primary')
  })

  it('never answers a clipboard READ query', () => {
    expect(handleOsc52('c;?')).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('drops invalid base64 and malformed bodies without throwing', () => {
    expect(handleOsc52('c;!!not-base64!!')).toBe(true)
    expect(handleOsc52('no-separator')).toBe(true)
    expect(handleOsc52(`c;`)).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('drops payloads beyond the size bound', () => {
    handleOsc52(`c;${'A'.repeat(1_048_577)}`)
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('TerminalView OSC 52 wiring', () => {
  it('a written OSC 52 sequence lands on the clipboard (BEL and ST terminators)', async () => {
    const view = new TerminalView({ cols: 40, rows: 10 })
    const el = document.createElement('div')
    document.body.appendChild(el)
    view.mount(el)

    view.write(`\x1b]52;c;${b64('via BEL')}\x07`)
    view.write(`\x1b]52;c;${b64('via ST')}\x1b\\`)
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('via ST'))
    expect(writeText).toHaveBeenCalledWith('via BEL')
    view.dispose()
  })
})
