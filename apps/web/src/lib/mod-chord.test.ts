import { afterEach, describe, expect, it, vi } from 'vitest'
import { modChord } from './mod-chord'

describe('modChord', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses ⌘ on Apple hardware', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    expect(modChord('K')).toBe('⌘K')
    expect(modChord('↵')).toBe('⌘↵')
  })

  it('uses Ctrl on Windows and Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' })
    expect(modChord('K')).toBe('Ctrl+K')
    expect(modChord('↵')).toBe('Ctrl+Enter')
  })
})
