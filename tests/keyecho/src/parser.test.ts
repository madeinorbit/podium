import { describe, expect, it } from 'vitest'
import type { KeyEvent, MouseEvent, PasteEvent } from './events.js'
import { decodeInput } from './parser.js'

function keys(input: string | number[]): KeyEvent[] {
  const buf = typeof input === 'string' ? Buffer.from(input, 'latin1') : Buffer.from(input)
  const { events, rest } = decodeInput(buf)
  expect(rest.length).toBe(0)
  return events as KeyEvent[]
}

function mouse(input: string): MouseEvent {
  const { events, rest } = decodeInput(Buffer.from(input, 'latin1'))
  expect(rest.length).toBe(0)
  return events[0] as MouseEvent
}

describe('parser: control characters', () => {
  it('Ctrl+C', () => {
    const [e] = keys([0x03])
    expect(e).toMatchObject({ kind: 'key', name: 'c', ctrl: true, label: 'Ctrl+C' })
  })

  it('Enter (CR) vs Ctrl+J (LF)', () => {
    expect(keys([0x0d])[0]).toMatchObject({ name: 'enter', label: 'Enter' })
    expect(keys([0x0a])[0]).toMatchObject({ name: 'j', ctrl: true, label: 'Ctrl+J' })
  })

  it('Tab and Backspace', () => {
    expect(keys([0x09])[0]).toMatchObject({ name: 'tab', label: 'Tab' })
    expect(keys([0x7f])[0]).toMatchObject({ name: 'backspace', label: 'Backspace' })
    expect(keys([0x08])[0]).toMatchObject({ name: 'backspace', label: 'Backspace' })
  })

  it('Ctrl+A and Ctrl+Z', () => {
    expect(keys([0x01])[0]).toMatchObject({ ctrl: true, label: 'Ctrl+A' })
    expect(keys([0x1a])[0]).toMatchObject({ ctrl: true, label: 'Ctrl+Z' })
  })

  it('two Ctrl+C in one chunk → two events', () => {
    const evs = keys([0x03, 0x03])
    expect(evs).toHaveLength(2)
    expect(evs[0]?.label).toBe('Ctrl+C')
    expect(evs[1]?.label).toBe('Ctrl+C')
  })
})

describe('parser: CSI', () => {
  it('arrows', () => {
    expect(keys('\x1b[A')[0]).toMatchObject({ name: 'up', label: 'Up' })
    expect(keys('\x1b[B')[0]).toMatchObject({ name: 'down', label: 'Down' })
    expect(keys('\x1b[C')[0]).toMatchObject({ name: 'right', label: 'Right' })
    expect(keys('\x1b[D')[0]).toMatchObject({ name: 'left', label: 'Left' })
  })

  it('Shift+Tab is ESC [ Z', () => {
    expect(keys('\x1b[Z')[0]).toMatchObject({ name: 'tab', shift: true, label: 'Shift+Tab' })
  })

  it('Home/End and PageUp/PageDown', () => {
    expect(keys('\x1b[H')[0]).toMatchObject({ name: 'home', label: 'Home' })
    expect(keys('\x1b[F')[0]).toMatchObject({ name: 'end', label: 'End' })
    expect(keys('\x1b[5~')[0]).toMatchObject({ name: 'pageup', label: 'PageUp' })
    expect(keys('\x1b[6~')[0]).toMatchObject({ name: 'pagedown', label: 'PageDown' })
  })

  it('modified arrow: Ctrl+Up = ESC [ 1 ; 5 A', () => {
    expect(keys('\x1b[1;5A')[0]).toMatchObject({ name: 'up', ctrl: true, label: 'Ctrl+Up' })
  })

  it('Shift+Enter via modifyOtherKeys ESC [ 27 ; 2 ; 13 ~', () => {
    expect(keys('\x1b[27;2;13~')[0]).toMatchObject({ name: 'enter', shift: true, label: 'Shift+Enter' })
  })

  it('partial CSI returns rest', () => {
    const { events, rest } = decodeInput(Buffer.from('\x1b[1;5', 'latin1'))
    expect(events).toHaveLength(0)
    expect(rest.toString('latin1')).toBe('\x1b[1;5')
  })
})

describe('parser: SS3 / escape / meta', () => {
  it('F1–F4 via SS3', () => {
    expect(keys('\x1bOP')[0]).toMatchObject({ name: 'f1', label: 'F1' })
    expect(keys('\x1bOS')[0]).toMatchObject({ name: 'f4', label: 'F4' })
  })

  it('SS3 Home/End', () => {
    expect(keys('\x1bOH')[0]).toMatchObject({ name: 'home', label: 'Home' })
    expect(keys('\x1bOF')[0]).toMatchObject({ name: 'end', label: 'End' })
  })

  it('lone Escape', () => {
    expect(keys('\x1b')[0]).toMatchObject({ name: 'escape', label: 'Escape' })
  })

  it('double Escape → two Escape events', () => {
    const evs = keys('\x1b\x1b')
    expect(evs).toHaveLength(2)
    expect(evs[0]?.label).toBe('Escape')
    expect(evs[1]?.label).toBe('Escape')
  })

  it('Alt/Option+Enter is ESC CR', () => {
    expect(keys('\x1b\r')[0]).toMatchObject({ name: 'enter', meta: true, label: 'Alt+Enter' })
  })

  it('Alt+a is ESC a', () => {
    expect(keys('\x1ba')[0]).toMatchObject({ name: 'a', meta: true, label: 'Alt+a' })
  })
})

describe('parser: SGR mouse', () => {
  it('left press and release', () => {
    expect(mouse('\x1b[<0;12;3M')).toMatchObject({ kind: 'mouse', action: 'press', button: 'left', x: 12, y: 3 })
    expect(mouse('\x1b[<0;12;3m')).toMatchObject({ kind: 'mouse', action: 'release', button: 'left', x: 12, y: 3 })
  })

  it('wheel up and down', () => {
    expect(mouse('\x1b[<64;5;5M')).toMatchObject({ action: 'wheel', button: 'wheelUp' })
    expect(mouse('\x1b[<65;5;5M')).toMatchObject({ action: 'wheel', button: 'wheelDown' })
  })

  it('label includes coordinates', () => {
    expect(mouse('\x1b[<0;12;3M').label).toBe('Mouse left press @ (12,3)')
  })

  it('incomplete mouse returns rest', () => {
    const { events, rest } = decodeInput(Buffer.from('\x1b[<0;12', 'latin1'))
    expect(events).toHaveLength(0)
    expect(rest.toString('latin1')).toBe('\x1b[<0;12')
  })
})

describe('parser: paste + printable', () => {
  it('printable ASCII', () => {
    expect(keys('a')[0]).toMatchObject({ kind: 'key', name: 'a', label: 'a' })
    expect(keys('/')[0]).toMatchObject({ name: '/', label: '/' })
  })

  it('multi-byte UTF-8 (é) is one event', () => {
    // Real terminals send UTF-8 bytes; pass them explicitly (the latin1 helper is
    // only correct for single-byte control/escape sequences).
    const evs = keys([0xc3, 0xa9]) // 'é'
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ name: 'é', label: 'é' })
  })

  it('bracketed paste yields a paste event', () => {
    const { events } = decodeInput(Buffer.from('\x1b[200~hello\x1b[201~', 'latin1'))
    const p = events[0] as PasteEvent
    expect(p).toMatchObject({ kind: 'paste', text: 'hello' })
    expect(p.label).toContain('Paste')
  })

  it('incomplete paste returns rest', () => {
    const { events, rest } = decodeInput(Buffer.from('\x1b[200~hel', 'latin1'))
    expect(events).toHaveLength(0)
    expect(rest.toString('latin1')).toBe('\x1b[200~hel')
  })
})
