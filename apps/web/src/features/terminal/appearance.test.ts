// Defensive parsing of the persisted terminal-appearance blob: a malformed or
// out-of-range stored value must never break the terminal — bad fields fall
// back to "default" (absent), numeric fields clamp to their bounds.
import { DEFAULT_THEME } from '@podium/terminal-client/terminal-view'
import { describe, expect, it } from 'vitest'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  mixHex,
  paneTintedBackground,
  parseTerminalAppearance,
  TERMINAL_DEFAULTS,
  toTerminalAppearance,
  withBackground,
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

describe('pane-tinted terminal background (native-pane spec §2.5)', () => {
  it('mixHex mirrors color-mix(in srgb): pct% of colour over base', () => {
    expect(mixHex('#ffffff', '#000000', 50)).toBe('#808080')
    expect(mixHex('#8b5cf6', '#0e0e12', 0)).toBe('#0e0e12')
    expect(mixHex('#8b5cf6', '#0e0e12', 100)).toBe('#8b5cf6')
  })

  it('tints 12% of a coloured issue over the terminal base', () => {
    // violet #8b5cf6 12% over #0e0e12 → channel-wise (0.12*c + 0.88*b)
    expect(paneTintedBackground('#8b5cf6')).toBe(mixHex('#8b5cf6', '#0e0e12', 12))
    expect(paneTintedBackground('#8b5cf6')).not.toBe(TERMINAL_DEFAULTS.background)
  })

  it('uncoloured issues get the neutral 9% slate flow, never flat black', () => {
    expect(paneTintedBackground(undefined)).toBe(mixHex('#94a3b8', '#0e0e12', 9))
  })

  it('withBackground merges the tint over the full palette, cursorAccent tracking', () => {
    const a = withBackground({ fontSize: 15 }, '#1a1622')
    expect(a.fontSize).toBe(15)
    expect(a.theme?.background).toBe('#1a1622')
    expect(a.theme?.cursorAccent).toBe('#1a1622')
    expect(a.theme?.foreground).toBe(DEFAULT_THEME.foreground)
  })
})
