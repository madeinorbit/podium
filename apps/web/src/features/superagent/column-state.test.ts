import { describe, expect, it } from 'vitest'
import { readFeedCursor, readSectionOpen, readTrayHeight, writeFeedCursor } from './column-state'

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

  it('feed cursor round-trips and treats corruption as never-seen', () => {
    const stored = writeFeedCursor({ id: 41, ts: '2026-07-14T14:20:00Z' })
    expect(readFeedCursor(stored)).toEqual({ id: 41, ts: '2026-07-14T14:20:00Z' })
    expect(readFeedCursor(null)).toEqual({ id: 0, ts: null })
    expect(readFeedCursor('{broken')).toEqual({ id: 0, ts: null })
    expect(readFeedCursor('{"id":-3}')).toEqual({ id: 0, ts: null })
  })
})
