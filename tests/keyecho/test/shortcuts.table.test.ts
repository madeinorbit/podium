import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from './shortcuts.js'

describe('shortcut table', () => {
  it('every entry has a name, bytes, and an expected label', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(15)
    for (const s of SHORTCUTS) {
      expect(s.name).toBeTruthy()
      expect(typeof s.bytes).toBe('string')
      expect(s.bytes.length).toBeGreaterThan(0)
      expect(s.expectLabel).toBeTruthy()
    }
  })

  it('names are unique', () => {
    const names = SHORTCUTS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
