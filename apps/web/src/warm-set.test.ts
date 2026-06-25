import { describe, expect, it } from 'vitest'
import { computeWarmSet, updateRecency } from './warm-set'

describe('updateRecency', () => {
  it('moves active ids to the front, preserving order of the rest', () => {
    expect(updateRecency(['a', 'b', 'c'], ['c'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })
  it('adds a newly-active id not seen before to the front', () => {
    expect(updateRecency(['a', 'b'], ['d'], ['a', 'b', 'd'])).toEqual(['d', 'a', 'b'])
  })
  it('keeps multiple active ids in their given order at the front', () => {
    expect(updateRecency(['a', 'b', 'c'], ['c', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a'])
  })
  it('drops ids no longer present', () => {
    expect(updateRecency(['a', 'b', 'c'], ['a'], ['a', 'c'])).toEqual(['a', 'c'])
  })
  it('is idempotent when active is already at the front', () => {
    expect(updateRecency(['a', 'b', 'c'], ['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('computeWarmSet', () => {
  it('keeps the N most-recent, always including active', () => {
    expect(computeWarmSet(['a', 'b', 'c', 'd', 'e'], ['a'], 3)).toEqual(new Set(['a', 'b', 'c']))
  })
  it('always includes all active ids even beyond capacity', () => {
    expect(computeWarmSet(['a', 'b', 'c'], ['a', 'b'], 1)).toEqual(new Set(['a', 'b']))
  })
  it('fills remaining capacity from recency after active', () => {
    expect(computeWarmSet(['x', 'a', 'b', 'c'], ['c'], 3)).toEqual(new Set(['c', 'x', 'a']))
  })
  it('returns all when fewer than capacity', () => {
    expect(computeWarmSet(['a', 'b'], ['a'], 8)).toEqual(new Set(['a', 'b']))
  })
})
