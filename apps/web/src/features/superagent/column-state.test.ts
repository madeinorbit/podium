import { describe, expect, it } from 'vitest'
import { readSectionOpen, readTrayHeight } from './column-state'

describe('engraved column persistence readers', () => {
  it('sections default OPEN and only an explicit false collapses them', () => {
    expect(readSectionOpen(null)).toBe(true)
    expect(readSectionOpen('true')).toBe(true)
    expect(readSectionOpen('garbage')).toBe(true)
    expect(readSectionOpen('false')).toBe(false)
    expect(readSectionOpen('0')).toBe(false)
  })

  it('tray height accepts only sane pixel values (else size-to-content)', () => {
    expect(readTrayHeight(null)).toBeNull()
    expect(readTrayHeight('not-a-number')).toBeNull()
    expect(readTrayHeight('12')).toBeNull() // below the clamp — ignore
    expect(readTrayHeight('220.6')).toBe(221)
  })

  // The feed cursor left this module at POD-1380: it is per-user state, not a
  // device-local key. Its parse (of the legacy blob this file used to write) is
  // covered where it now lives — packages/client-core/src/read-position.test.ts.
})
