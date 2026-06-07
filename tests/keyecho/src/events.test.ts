import { describe, expect, it } from 'vitest'
import { formatEvent, type KeyEvent, toCaret, toHex } from './events.js'

describe('formatters', () => {
  it('toHex renders space-separated lowercase bytes', () => {
    expect(toHex([0x1b, 0x5b, 0x5a])).toBe('1b 5b 5a')
  })

  it('toCaret renders control chars in caret notation', () => {
    expect(toCaret([0x03])).toBe('^C')
    expect(toCaret([0x1b])).toBe('^[')
    expect(toCaret([0x7f])).toBe('^?')
    expect(toCaret([0x61])).toBe('a')
  })

  it('formatEvent produces one tagged line with hex and label', () => {
    const e: KeyEvent = {
      kind: 'key',
      source: 'raw',
      seq: 1,
      bytes: [0x03],
      name: 'c',
      ctrl: true,
      meta: false,
      shift: false,
      label: 'Ctrl+C',
    }
    const line = formatEvent(e)
    expect(line).toContain('[raw]')
    expect(line).toContain('Ctrl+C')
    expect(line).toContain('03')
  })
})
