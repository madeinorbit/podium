import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { computeWarmSet, updateRecency } from './warm-set'

describe('updateRecency', () => {
  it('moves active ids to the front, preserving order of the rest', () => {
    expect(updateRecency([asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('c')], [asSessionId('a'), asSessionId('b'), asSessionId('c')])).toEqual(['c', 'a', 'b'])
  })
  it('adds a newly-active id not seen before to the front', () => {
    expect(updateRecency([asSessionId('a'), asSessionId('b')], [asSessionId('d')], [asSessionId('a'), asSessionId('b'), asSessionId('d')])).toEqual(['d', 'a', 'b'])
  })
  it('keeps multiple active ids in their given order at the front', () => {
    expect(updateRecency([asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('c'), asSessionId('b')], [asSessionId('a'), asSessionId('b'), asSessionId('c')])).toEqual(['c', 'b', 'a'])
  })
  it('drops ids no longer present', () => {
    expect(updateRecency([asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('a')], [asSessionId('a'), asSessionId('c')])).toEqual(['a', 'c'])
  })
  it('is idempotent when active is already at the front', () => {
    expect(updateRecency([asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('a')], [asSessionId('a'), asSessionId('b'), asSessionId('c')])).toEqual(['a', 'b', 'c'])
  })
})

describe('computeWarmSet', () => {
  it('keeps the N most-recent, always including active', () => {
    expect(computeWarmSet([asSessionId('a'), asSessionId('b'), asSessionId('c'), asSessionId('d'), asSessionId('e')], [asSessionId('a')], 3)).toEqual(new Set(['a', 'b', 'c']))
  })
  it('always includes all active ids even beyond capacity', () => {
    expect(computeWarmSet([asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('a'), asSessionId('b')], 1)).toEqual(new Set(['a', 'b']))
  })
  it('fills remaining capacity from recency after active', () => {
    expect(computeWarmSet([asSessionId('x'), asSessionId('a'), asSessionId('b'), asSessionId('c')], [asSessionId('c')], 3)).toEqual(new Set(['c', 'x', 'a']))
  })
  it('returns all when fewer than capacity', () => {
    expect(computeWarmSet([asSessionId('a'), asSessionId('b')], [asSessionId('a')], 8)).toEqual(new Set(['a', 'b']))
  })
})
