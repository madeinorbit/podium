import { describe, expect, it } from 'vitest'
import { computeArrivals, MAX_ARRIVALS } from './use-feed-arrivals'

// ARRIVAL (POD-423). The whole risk here is false positives: this feed mounts
// three hundred rows on open, pages four hundred more in above on scroll, and
// re-renders on a 700ms poll. Only an APPEND is news; everything else must stay
// still, or the surface a user watches all day flickers.

describe('computeArrivals', () => {
  it('arrives nothing on the first pass — an opened transcript is history', () => {
    expect(computeArrivals(null, ['a', 'b', 'c'])).toEqual([])
  })

  it('arrives rows appended after the ones already on screen', () => {
    expect(computeArrivals(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c'])
    expect(computeArrivals(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd'])
  })

  it('arrives nothing for an older page paged in above', () => {
    expect(computeArrivals(['c', 'd'], ['a', 'b', 'c', 'd'])).toEqual([])
  })

  it('arrives only the tail when a page loads above and a row lands below', () => {
    expect(computeArrivals(['c', 'd'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['e'])
  })

  it('arrives nothing when the whole list is replaced — that is a new transcript', () => {
    expect(computeArrivals(['a', 'b'], ['x', 'y'])).toEqual([])
  })

  it('arrives nothing when rows only scroll out of the render window', () => {
    expect(computeArrivals(['a', 'b', 'c'], ['b', 'c'])).toEqual([])
  })

  it('holds still for a backfill — a reconnect replaying its cache is not speech', () => {
    const many = Array.from({ length: MAX_ARRIVALS + 1 }, (_, i) => `n${i}`)
    expect(computeArrivals(['a'], ['a', ...many])).toEqual([])
    expect(computeArrivals(['a'], ['a', ...many.slice(1)])).toHaveLength(MAX_ARRIVALS)
  })

  it('is stable for an unchanged list — a poll that changed nothing arrives nothing', () => {
    expect(computeArrivals(['a', 'b'], ['a', 'b'])).toEqual([])
  })
})
