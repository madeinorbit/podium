import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, readStoredTheme, resolveDark, THEME_MODE_KEY, THEME_PRESET_KEY } from './theme'

afterEach(() => localStorage.clear())

describe('readStoredTheme', () => {
  it('defaults to superade/dark when nothing stored', () => {
    expect(readStoredTheme()).toEqual({ preset: 'superade', mode: 'dark' })
  })
  it('reads stored valid values', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'shadcn')
    localStorage.setItem(THEME_MODE_KEY, 'light')
    expect(readStoredTheme()).toEqual({ preset: 'shadcn', mode: 'light' })
  })
  it('reads the superade preset', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'superade')
    expect(readStoredTheme().preset).toBe('superade')
  })
  it('falls back on garbage', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'bogus')
    expect(readStoredTheme().preset).toBe('superade')
  })
})

describe('resolveDark', () => {
  it('follows the system preference in system mode', () => {
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
  it('honors explicit light/dark regardless of system', () => {
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('light', true)).toBe(false)
  })
})

describe('applyTheme', () => {
  it('sets data-theme for podium, removes for shadcn, toggles dark', () => {
    const el = document.createElement('html')
    applyTheme({ preset: 'podium', mode: 'dark' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme({ preset: 'shadcn', mode: 'light' }, el)
    expect(el.getAttribute('data-theme')).toBe(null)
    expect(el.classList.contains('dark')).toBe(false)
  })
  it('sets data-theme for superade', () => {
    const el = document.createElement('html')
    applyTheme({ preset: 'superade', mode: 'dark' }, el)
    expect(el.getAttribute('data-theme')).toBe('superade')
    expect(el.classList.contains('dark')).toBe(true)
  })
  // The macOS vibrancy layer renders with the window's NSAppearance, not the page
  // theme, so applyTheme forwards the resolved mode to the shell. System hands
  // control back (null): forcing an appearance flips prefers-color-scheme, which
  // would lock system mode to whatever was last forced.
  it('forwards explicit modes to the desktop shell and releases system mode', () => {
    const calls: Array<'light' | 'dark' | null> = []
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      setTheme: (theme: 'light' | 'dark' | null) => {
        calls.push(theme)
        return Promise.resolve()
      },
    }
    try {
      const el = document.createElement('html')
      applyTheme({ preset: 'superade', mode: 'dark' }, el)
      applyTheme({ preset: 'superade', mode: 'light' }, el)
      applyTheme({ preset: 'superade', mode: 'system' }, el, true)
      expect(calls).toEqual(['dark', 'light', null])
    } finally {
      delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
    }
  })
  it('tolerates shells older than the setTheme bridge method', () => {
    ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }
    try {
      const el = document.createElement('html')
      expect(() => applyTheme({ preset: 'superade', mode: 'dark' }, el)).not.toThrow()
    } finally {
      delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
    }
  })
})
