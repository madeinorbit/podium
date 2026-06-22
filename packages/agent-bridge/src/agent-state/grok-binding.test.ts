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

  it('skips a dir already claimed by another live session', () => {
    // 'old' has the freshest mtime so it would normally win, but another session
    // already bound it — fall through to the next eligible dir.
    expect(
      chooseGrokSessionDir({ dirs, watermarkMs: 0, excludeIds: new Set(['old']) }),
    ).toBe('new')
  })

  it('stays unbound rather than stealing when the only eligible dir is claimed', () => {
    // Two unbound sessions reattaching with watermark 0 must NOT converge on the
    // same dir — once one claims it, the other finds nothing eligible and waits.
    expect(
      chooseGrokSessionDir({
        dirs: [{ id: 'only', createdMs: 5_000, mtimeMs: 6_000 }],
        watermarkMs: 0,
        excludeIds: new Set(['only']),
      }),
    ).toBeUndefined()
  })

  it('never excludes its own already-bound dir', () => {
    // A session keeps its own binding even if its id appears in the exclude set
    // (its own claim must not be read as someone else's).
    expect(
      chooseGrokSessionDir({ dirs, watermarkMs: 4_000, boundId: 'old', excludeIds: new Set(['old']) }),
    ).toBe('old')
  })
})
