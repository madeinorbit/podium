import type { UsageBucketWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { bucketCostUsd, formatTick, formatTokens, niceAxisMax } from './usage'

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

// POD-570: the table is substring-matched and first-match-wins, so the risk it
// carries is a model landing on the WRONG row — silently, at a plausible price.
describe('bucketCostUsd', () => {
  const bucket = (model: string, over: Partial<UsageBucketWire> = {}): UsageBucketWire => ({
    hour: '2026-06-12T10:00:00.000Z',
    model,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 1,
    ...over,
  })

  it.each([
    // [model id, $ for 1 MTok of input]
    ['claude-opus-4-5', 15],
    ['claude-sonnet-4-5', 3],
    // Codex ids must reach the gpt-5 family rather than the 3/15 fallback,
    // which would have overstated every Codex bucket by 2.4x.
    ['gpt-5', 1.25],
    ['gpt-5-codex', 1.25],
    ['gpt-5.6-sol', 1.25],
    // The ids this machine's own rollouts actually carry — the guardian
    // subagent's has no family name in it at all.
    ['gpt-5.6-luna', 1.25],
    ['codex-auto-review', 1.25],
    // Narrower ids precede the family, so these keep their own price.
    ['gpt-5-mini', 0.25],
    ['gpt-5-nano', 0.05],
  ])('prices %s at $%d per MTok of input', (model, expected) => {
    expect(bucketCostUsd(bucket(model))).toBeCloseTo(expected, 6)
  })

  it('bills cache reads at a tenth of input, on both providers', () => {
    const cached = { inputTokens: 0, cacheReadTokens: 1_000_000 }
    expect(bucketCostUsd(bucket('gpt-5', cached))).toBeCloseTo(0.125, 6)
    expect(bucketCostUsd(bucket('claude-sonnet-4-5', cached))).toBeCloseTo(0.3, 6)
  })

  it('falls back for an unrecognized model instead of charging nothing', () => {
    expect(bucketCostUsd(bucket('some-new-model'))).toBeCloseTo(3, 6)
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
