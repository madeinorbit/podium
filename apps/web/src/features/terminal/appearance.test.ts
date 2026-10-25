// Defensive parsing of the persisted terminal-appearance blob: a malformed or
// out-of-range stored value must never break the terminal — bad fields fall
// back to "default" (absent), numeric fields clamp to their bounds.
import { DEFAULT_THEME } from '@podium/terminal-client/appearance'
import { describe, expect, it, vi } from 'vitest'
import {
  applyInitialTerminalAppearance,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
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

describe('terminal palette helpers', () => {



  it('withBackground merges the tint over the full palette, cursorAccent tracking', () => {
    const a = withBackground({ fontSize: 15 }, '#1a1622')
    expect(a.fontSize).toBe(15)
    expect(a.theme?.background).toBe('#1a1622')
    expect(a.theme?.cursorAccent).toBe('#1a1622')
    expect(a.theme?.foreground).toBe(DEFAULT_THEME.foreground)
  })
})

describe('initial terminal appearance application', () => {
  // REWRITTEN FOR POD-3239 B4. The three cases below used to be about WHEN this
  // helper was allowed to measure: theme-only (never), a custom metric on a
  // visible pane (once, with a resize), a custom metric on a hidden one (never).
  // It measures in none of them now — there is one ask path and this is not it,
  // so the helper does the one thing its name says and the mount's own
  // `setAppearance` trigger asks, under the eligibility gate that lives there.
  it('applies the appearance, and does nothing else', () => {
    const setAppearance = vi.fn()

    applyInitialTerminalAppearance(
      { setAppearance },
      { theme: { ...DEFAULT_THEME, background: '#1a1622' } },
    )

    expect(setAppearance).toHaveBeenCalledTimes(1)
    expect(setAppearance).toHaveBeenCalledWith({
      theme: { ...DEFAULT_THEME, background: '#1a1622' },
    })
  })

  it('does the same for a custom font metric — measuring is not its job', () => {
    const setAppearance = vi.fn()

    applyInitialTerminalAppearance({ setAppearance }, { fontSize: 18 })

    expect(setAppearance).toHaveBeenCalledTimes(1)
    expect(setAppearance).toHaveBeenCalledWith({ fontSize: 18 })
  })
})
