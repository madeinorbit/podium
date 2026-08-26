import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, readStoredTheme, resolveDark, THEME_MODE_KEY } from './theme'

afterEach(() => localStorage.clear())

describe('readStoredTheme', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(readStoredTheme()).toEqual({ mode: 'dark' })
  })
  it('reads a stored valid mode', () => {
    localStorage.setItem(THEME_MODE_KEY, 'light')
    expect(readStoredTheme()).toEqual({ mode: 'light' })
  })
  it('falls back on an invalid mode', () => {
    localStorage.setItem(THEME_MODE_KEY, 'bogus')
    expect(readStoredTheme()).toEqual({ mode: 'dark' })
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
  it('always applies the Podium theme and toggles dark mode', () => {
    const el = document.createElement('html')
    applyTheme({ mode: 'dark' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme({ mode: 'light' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(false)
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
      applyTheme({ mode: 'dark' }, el)
      applyTheme({ mode: 'light' }, el)
      applyTheme({ mode: 'system' }, el, true)
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
      expect(() => applyTheme({ mode: 'dark' }, el)).not.toThrow()
    } finally {
      delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
    }
  })
})
