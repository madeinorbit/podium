import { describe, expect, it } from 'vitest'
import type { KeyEvent } from './events.js'
import { decodeInput } from './parser.js'

function keys(input: string | number[]): KeyEvent[] {
  const buf = typeof input === 'string' ? Buffer.from(input, 'latin1') : Buffer.from(input)
  const { events, rest } = decodeInput(buf)
  expect(rest.length).toBe(0)
  return events as KeyEvent[]
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
