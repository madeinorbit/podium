import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, readStoredTheme, THEME_MODE_KEY, THEME_PRESET_KEY } from './theme'

afterEach(() => localStorage.clear())

describe('readStoredTheme', () => {
  it('defaults to podium/dark when nothing stored', () => {
    expect(readStoredTheme()).toEqual({ preset: 'podium', mode: 'dark' })
  })
  it('reads stored valid values', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'shadcn')
    localStorage.setItem(THEME_MODE_KEY, 'light')
    expect(readStoredTheme()).toEqual({ preset: 'shadcn', mode: 'light' })
  })
  it('falls back on garbage', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'bogus')
    expect(readStoredTheme().preset).toBe('podium')
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
})
