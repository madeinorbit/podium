import type { UsageBucketWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { bucketCostUsd, formatTokens, localDay, usageSummary } from '../src/usage'

const NOW = Date.parse('2026-06-12T12:30:00.000Z')
const bucket = (hour: string, over: Partial<UsageBucketWire> = {}): UsageBucketWire => ({
  hour,
  model: 'claude-sonnet-4-5',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 10_000,
  cacheCreationTokens: 2000,
  messages: 3,
  ...over,
})

describe('usageSummary', () => {
  it('splits the rolling 5h window from the 7d window', () => {
    const s = usageSummary(
      [
        bucket('2026-06-12T11:00:00.000Z'), // inside 5h
        bucket('2026-06-12T01:00:00.000Z'), // outside 5h, inside 7d
        bucket('2026-06-01T00:00:00.000Z'), // outside both
      ],
      NOW,
    )
    expect(s.fiveHour.totalTokens).toBe(13_500)
    expect(s.fiveHour.messages).toBe(3)
    expect(s.week.totalTokens).toBe(27_000)
    expect(s.week.messages).toBe(6)
  })

  it('produces 7 day slots oldest-first and per-model rows', () => {
    const s = usageSummary([bucket('2026-06-12T11:00:00.000Z')], NOW)
    expect(s.days).toHaveLength(7)
    // Slots and attribution are in the runner's local day, so derive the
    // expected keys via localDay rather than hardcoding a UTC date string.
    expect(s.days.at(-1)?.day).toBe(localDay(NOW))
    const bucketDay = s.days.find((d) => d.day === localDay(Date.parse('2026-06-12T11:00:00.000Z')))
    expect(bucketDay?.totalTokens).toBe(13_500)
    expect(s.models[0]?.model).toBe('claude-sonnet-4-5')
  })
})

describe('bucketCostUsd', () => {
  it('prices by model family with cache discounts', () => {
    const sonnet = bucketCostUsd(
      bucket('2026-06-12T11:00:00.000Z', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    )
    expect(sonnet).toBeCloseTo(3)
    const opus = bucketCostUsd(
      bucket('2026-06-12T11:00:00.000Z', {
        model: 'claude-opus-4-8',
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    )
    expect(opus).toBeCloseTo(75)
    const cacheRead = bucketCostUsd(
      bucket('2026-06-12T11:00:00.000Z', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 0,
      }),
    )
    expect(cacheRead).toBeCloseTo(0.3)
  })
})

describe('formatTokens', () => {
  it('uses M/k shorthand', () => {
    expect(formatTokens(1_234_000)).toBe('1.2M')
    expect(formatTokens(840_000)).toBe('840k')
    expect(formatTokens(312)).toBe('312')
  })
})
