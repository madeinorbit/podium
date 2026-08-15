import { describe, expect, it } from 'vitest'
import {
  isSortKey,
  SORT_KEY_COMPACT_LEN,
  SORT_KEY_MAX_LEN,
  sortKeyBetween,
  spreadSortKeys,
} from './sort-key'

describe('sortKeyBetween — fractional keys (POD-168)', () => {
  it('seeds an empty scope with a well-formed key', () => {
    const k = sortKeyBetween(null, null)
    expect(isSortKey(k)).toBe(true)
  })

  it('mints strictly above the scope minimum (new-at-top, R2)', () => {
    let top = sortKeyBetween(null, null)
    for (let i = 0; i < 50; i++) {
      const next = sortKeyBetween(null, top)
      expect(next < top).toBe(true)
      expect(isSortKey(next)).toBe(true)
      top = next
    }
  })

  it('mints strictly below the scope maximum', () => {
    let bottom = sortKeyBetween(null, null)
    for (let i = 0; i < 50; i++) {
      const next = sortKeyBetween(bottom, null)
      expect(next > bottom).toBe(true)
      expect(isSortKey(next)).toBe(true)
      bottom = next
    }
  })

  it('always lands strictly between two neighbors, repeatedly', () => {
    // Repeated bisection between ever-closer neighbors must never collide.
    let a = sortKeyBetween(null, null)
    let b = sortKeyBetween(a, null)
    for (let i = 0; i < 60; i++) {
      const mid = sortKeyBetween(a, b)
      expect(a < mid && mid < b).toBe(true)
      expect(isSortKey(mid)).toBe(true)
      if (i % 2 === 0) b = mid
      else a = mid
    }
  })

  it('handles adjacent-digit neighbors', () => {
    expect(() => sortKeyBetween('i', 'j')).not.toThrow()
    const mid = sortKeyBetween('i', 'j')
    expect(mid > 'i' && mid < 'j').toBe(true)
  })

  it('handles prefix neighbors (a is a prefix of b)', () => {
    const mid = sortKeyBetween('i', 'i5')
    expect(mid > 'i' && mid < 'i5').toBe(true)
  })

  it('rejects out-of-order or malformed bounds', () => {
    expect(() => sortKeyBetween('j', 'i')).toThrow()
    expect(() => sortKeyBetween('i', 'i')).toThrow()
    expect(() => sortKeyBetween('I', null)).toThrow()
    expect(() => sortKeyBetween('i0', null)).toThrow()
    expect(() => sortKeyBetween(null, 'a b')).toThrow()
  })

  it('never produces keys ending in the minimum digit', () => {
    const a: string | null = null
    let b: string | null = '1'
    for (let i = 0; i < 40; i++) {
      const mid: string = sortKeyBetween(a, b)
      expect(mid.endsWith('0')).toBe(false)
      b = mid
    }
  })
})

describe('spreadSortKeys — scope compaction (POD-1102)', () => {
  it('head-inserts alone drive a scope past the wire cap — the regression', () => {
    // What `mintSortKey` does on every create: mint strictly above the scope
    // minimum. Six hundred-odd issues into one repo and the key it produces is
    // longer than `issues.update` accepts, so every reorder planned against
    // those rows comes back 400 and the row snaps home under an error toast.
    let min: string | null = null
    let creates = 0
    while ((min?.length ?? 0) <= SORT_KEY_MAX_LEN) {
      min = sortKeyBetween(null, min)
      creates += 1
    }
    expect(creates).toBeLessThan(700)
  })

  it('spreads well-formed, strictly ascending keys', () => {
    for (const count of [1, 2, 17, 35, 36, 37, 400, 1296, 5000]) {
      const keys = spreadSortKeys(count)
      expect(keys).toHaveLength(count)
      expect(keys.every(isSortKey)).toBe(true)
      for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true)
    }
  })

  it('stays short, and leaves a midpoint between every adjacent pair', () => {
    const keys = spreadSortKeys(400)
    expect(keys.every((k) => k.length <= 3)).toBe(true)
    for (let i = 1; i < keys.length; i++) {
      const mid = sortKeyBetween(keys[i - 1]!, keys[i]!)
      expect(mid.length).toBeLessThanOrEqual(keys[i]!.length)
    }
  })

  it('re-opens the head of the space a long scope had closed', () => {
    const compacted = spreadSortKeys(400)
    const top = sortKeyBetween(null, compacted[0]!)
    expect(isSortKey(top)).toBe(true)
    expect(top < compacted[0]!).toBe(true)
    expect(top.length).toBeLessThan(SORT_KEY_MAX_LEN)
  })

  it('holds a scope writable across thousands of creates once compaction is in play', () => {
    // The invariant the server's mint now maintains: compact when the minimum
    // reaches SORT_KEY_COMPACT_LEN, and the head of the space never closes.
    let keys = spreadSortKeys(50)
    for (let i = 0; i < 5000; i++) {
      if ((keys[0]?.length ?? 0) >= SORT_KEY_COMPACT_LEN) keys = spreadSortKeys(keys.length)
      keys = [sortKeyBetween(null, keys[0] ?? null), ...keys]
    }
    expect(keys.every(isSortKey)).toBe(true)
    expect(keys.every((k) => k.length <= SORT_KEY_MAX_LEN)).toBe(true)
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true)
  })

  it('returns nothing for an empty scope', () => {
    expect(spreadSortKeys(0)).toEqual([])
  })
})
