import { describe, expect, it } from 'vitest'
import { isSortKey, sortKeyBetween } from './sort-key'

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
