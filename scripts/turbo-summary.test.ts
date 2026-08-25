import { describe, expect, it } from 'vitest'
import { isFullHit, isFullMiss, parseTurboSummary } from './turbo-summary'

const full =
  ' Tasks:    24 successful, 24 total\nCached:    24 cached, 24 total\n  Time:    735ms >>> FULL TURBO\n'
const cold =
  ' Tasks:    24 successful, 24 total\nCached:    0 cached, 24 total\n  Time:    8m0.915s \n'
const partial =
  ' Tasks:    24 successful, 24 total\nCached:    23 cached, 24 total\n  Time:    41s \n'
const single =
  ' Tasks:    1 successful, 1 total\nCached:    1 cached, 1 total\n  Time:    120ms >>> FULL TURBO\n'

describe('parseTurboSummary', () => {
  it('reads the counts, not the words', () => {
    expect(parseTurboSummary(full)).toEqual({ successful: 24, total: 24, cached: 24 })
    expect(parseTurboSummary(cold)).toEqual({ successful: 24, total: 24, cached: 0 })
  })

  it('returns null when the run never reached turbo', () => {
    expect(parseTurboSummary('typecheck refused: node-pty is a dangling symlink\n')).toBeNull()
    expect(parseTurboSummary('')).toBeNull()
  })

  it('separates a full hit from one recomputed task', () => {
    // The distinction a "cache hit" grep cannot make: this run recomputed something.
    expect(isFullHit(parseTurboSummary(partial))).toBe(false)
    expect(isFullMiss(parseTurboSummary(partial))).toBe(false)
    expect(isFullHit(parseTurboSummary(full))).toBe(true)
    expect(isFullMiss(parseTurboSummary(cold))).toBe(true)
  })

  it('a run that executed no task is neither a hit nor a miss', () => {
    const empty = ' Tasks:    0 successful, 0 total\nCached:    0 cached, 0 total\n'
    expect(isFullHit(parseTurboSummary(empty))).toBe(false)
    expect(isFullMiss(parseTurboSummary(empty))).toBe(false)
  })

  it('carries the task count a single-package proof depends on', () => {
    expect(parseTurboSummary(single)?.total).toBe(1)
  })
})
