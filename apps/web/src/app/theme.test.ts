import { afterEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  readStoredTheme,
  resolveDark,
  THEME_APPEARANCE_KEY,
  THEME_MODE_KEY,
} from './theme'

afterEach(() => localStorage.clear())

describe('readStoredTheme', () => {
  it('defaults to dark on the Podium appearance when nothing is stored', () => {
    expect(readStoredTheme()).toEqual({ mode: 'dark', appearance: 'podium' })
  })
  it('reads a stored valid mode', () => {
    localStorage.setItem(THEME_MODE_KEY, 'light')
    expect(readStoredTheme()).toEqual({ mode: 'light', appearance: 'podium' })
  })
  it('falls back on an invalid mode', () => {
    localStorage.setItem(THEME_MODE_KEY, 'bogus')
    expect(readStoredTheme()).toEqual({ mode: 'dark', appearance: 'podium' })
  })
  it('reads the stored appearance alongside the mode', () => {
    localStorage.setItem(THEME_MODE_KEY, 'light')
    localStorage.setItem(THEME_APPEARANCE_KEY, 'omarchy')
    expect(readStoredTheme()).toEqual({ mode: 'light', appearance: 'omarchy' })
  })
  it('falls back to the Podium appearance on an unknown profile', () => {
    localStorage.setItem(THEME_APPEARANCE_KEY, 'gruvbox')
    expect(readStoredTheme().appearance).toBe('podium')
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
  // Omarchy is one dark palette with no paper counterpart, so the profile
  // answers before the mode is consulted — and the stored mode SURVIVES, which
  // is what lets switching back restore the operator's light/system choice.
  it('is dark under Omarchy whatever the mode says', () => {
    expect(resolveDark('light', false, 'omarchy')).toBe(true)
    expect(resolveDark('system', false, 'omarchy')).toBe(true)
    expect(resolveDark('dark', false, 'omarchy')).toBe(true)
  })
})

describe('applyTheme', () => {
  it('applies the appearance and toggles dark mode', () => {
    const el = document.createElement('html')
    applyTheme({ mode: 'dark', appearance: 'podium' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme({ mode: 'light', appearance: 'podium' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(false)
  })
  // The whole point of the profile being an ATTRIBUTE: one switch moves every
  // token block, and the dark class comes with it whatever the mode was.
  it('switches the token block and forces dark under Omarchy', () => {
    const el = document.createElement('html')
    applyTheme({ mode: 'light', appearance: 'omarchy' }, el)
    expect(el.getAttribute('data-theme')).toBe('omarchy')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme({ mode: 'light', appearance: 'podium' }, el)
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
      applyTheme({ mode: 'dark', appearance: 'podium' }, el)
      applyTheme({ mode: 'light', appearance: 'podium' }, el)
      applyTheme({ mode: 'system', appearance: 'podium' }, el, true)
      // Omarchy is never 'system': the profile IS an explicit dark choice, and
      // handing the frame back to the OS would leave it light around a navy
      // window.
      applyTheme({ mode: 'system', appearance: 'omarchy' }, el, false)
      expect(calls).toEqual(['dark', 'light', null, 'dark'])
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
      expect(() => applyTheme({ mode: 'dark', appearance: 'podium' }, el)).not.toThrow()
    } finally {
      delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
    }
  })
})
