// Defensive parsing of the persisted terminal-appearance blob: a malformed or
// out-of-range stored value must never break the terminal — bad fields fall
// back to "default" (absent), numeric fields clamp to their bounds.
import { DEFAULT_THEME } from '@podium/terminal-client/terminal-view'
import { describe, expect, it } from 'vitest'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  parseTerminalAppearance,
  toTerminalAppearance,
} from './appearance'

describe('parseTerminalAppearance', () => {
  it('returns empty settings for null / malformed / non-object JSON', () => {
    expect(parseTerminalAppearance(null)).toEqual({})
    expect(parseTerminalAppearance('not json')).toEqual({})
    expect(parseTerminalAppearance('"a string"')).toEqual({})
    expect(parseTerminalAppearance('null')).toEqual({})
  })

  it('accepts valid fields and drops invalid ones', () => {
    const s = parseTerminalAppearance(
      JSON.stringify({
        fontSize: 16,
        fontFamily: 'Iosevka',
        lineHeight: 1.3,
        background: '#0a1a3a',
        unknown: 'ignored',
      }),
    )
    expect(s).toEqual({
      fontSize: 16,
      fontFamily: 'Iosevka',
      lineHeight: 1.3,
      background: '#0a1a3a',
    })
  })

  it('clamps out-of-range numbers and rejects non-hex backgrounds', () => {
    const s = parseTerminalAppearance(
      JSON.stringify({ fontSize: 200, lineHeight: 0.2, background: 'url(javascript:x)' }),
    )
    expect(s.fontSize).toBe(FONT_SIZE_MAX)
    expect(s.lineHeight).toBe(1)
    expect(s.background).toBeUndefined()
    expect(parseTerminalAppearance(JSON.stringify({ fontSize: 2 })).fontSize).toBe(FONT_SIZE_MIN)
  })

  it('drops empty/whitespace font family and non-finite numbers', () => {
    expect(parseTerminalAppearance(JSON.stringify({ fontFamily: '  ' }))).toEqual({})
    expect(parseTerminalAppearance('{"fontSize": "13"}')).toEqual({})
  })
})

describe('toTerminalAppearance', () => {
  it('maps only the set fields; background merges over the full default palette', () => {
    expect(toTerminalAppearance({})).toEqual({})
    const a = toTerminalAppearance({ fontSize: 15, background: '#001133' })
    expect(a.fontSize).toBe(15)
    expect(a.lineHeight).toBeUndefined()
    expect(a.theme?.background).toBe('#001133')
    expect(a.theme?.cursorAccent).toBe('#001133')
    expect(a.theme?.foreground).toBe(DEFAULT_THEME.foreground)
  })

  it('always terminates a custom font stack in monospace', () => {
    expect(toTerminalAppearance({ fontFamily: 'Iosevka' }).fontFamily).toBe('Iosevka, monospace')
  })
})
