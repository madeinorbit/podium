import { describe, expect, it } from 'vitest'
import { chooseGrokSessionDir } from './grok-binding'

const dirs = [
  { id: 'old', createdMs: 1_000, mtimeMs: 9_000 }, // pre-existing, still being written
  { id: 'new', createdMs: 5_000, mtimeMs: 6_000 },
]

describe('chooseGrokSessionDir', () => {
  it('binds the session created after the spawn watermark, not the freshest mtime', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 4_000 })).toBe('new')
  })
  it('keeps an already-bound dir even when a newer dir appears', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 4_000, boundId: 'old' })).toBe('old')
  })
  it('returns undefined when nothing is newer than the watermark', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 99_000 })).toBeUndefined()
  })
})
