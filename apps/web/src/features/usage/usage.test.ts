import { describe, expect, it } from 'vitest'
import { formatTick, formatTokens, niceAxisMax } from './usage'

// The chart's scale (POD-365). Before this the chart had no axis at all — you
// could compare bars and not read a value — so these three functions are the
// whole readability of it and every one of them has an edge that bites.

describe('niceAxisMax', () => {
  it.each([
    // [peak, expected top of axis]
    [1, 1],
    [7, 10],
    [10, 10], // exactly on a step: takes it, never the next one up
    [11, 20],
    [200, 200],
    [201, 500],
    [826_200_000, 1_000_000_000], // the case that exposed the missing B tier
    [1_000_000_000, 1_000_000_000],
    [1_000_000_001, 2_000_000_000],
  ])('rounds a peak of %i up to %i', (peak, expected) => {
    expect(niceAxisMax(peak)).toBe(expected)
  })

  it('always lands at or above the peak, so no bar can overflow the plot', () => {
    for (const peak of [3, 42, 999, 1234, 87_654, 5_000_001, 999_999_999]) {
      expect(niceAxisMax(peak)).toBeGreaterThanOrEqual(peak)
    }
  })

  it('never returns zero or a non-finite ceiling — the bar heights divide by it', () => {
    for (const peak of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const max = niceAxisMax(peak)
      expect(Number.isFinite(max)).toBe(true)
      expect(max).toBeGreaterThan(0)
    }
  })
})

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_500, '2k'],
    [1_500_000, '1.5M'],
    // A busy week used to print "1000.0M": four digits and a unit that had
    // stopped doing its job.
    [1_000_000_000, '1.0B'],
    [1_240_000_000, '1.2B'],
  ])('formats %i as %s', (n, expected) => {
    expect(formatTokens(n)).toBe(expected)
  })
})

describe('formatTick', () => {
  it('drops a decimal ZERO, because an axis is a ruler and not a readout', () => {
    expect(formatTick(1_000_000_000)).toBe('1B')
    expect(formatTick(500_000_000)).toBe('500M')
    expect(formatTick(0)).toBe('0')
  })

  it('keeps a genuine half — 2.5B is a tick niceAxisMax/2 really produces', () => {
    expect(formatTick(2_500_000_000)).toBe('2.5B')
    expect(formatTick(250_000_000)).toBe('250M')
    expect(formatTick(1_500_000)).toBe('1.5M')
  })
})
