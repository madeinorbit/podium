import type { UsageBucketWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  bucketCostUsd,
  bucketProvider,
  costWeightRatio,
  formatCostWeightRatio,
  formatShare,
  formatTick,
  formatTokens,
  formatUsdTick,
  niceAxisMax,
  usageSummary,
} from './usage'

// The chart's scale (POD-365). Before this the chart had no axis at all — you
// could compare bars and not read a value — so these three functions are the
// whole readability of it and every one of them has an edge that bites.

const ZERO_BUCKET = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as const

describe('niceAxisMax', () => {
  it.each([
    // [peak, expected top of axis] — on the finer POD-596 ramp, which exists so
    // a 350M peak does not take a 500M ceiling and waste a third of the plot.
    [1, 1],
    [7, 8],
    [10, 10], // exactly on a step: takes it, never the next one up
    [11, 15],
    [200, 200],
    [201, 250],
    [350_000_000, 400_000_000], // the case the finer ramp was added for
    [826_200_000, 1_000_000_000], // the case that exposed the missing B tier
    [1_000_000_000, 1_000_000_000],
    [1_000_000_001, 1_500_000_000],
  ])('rounds a peak of %i up to %i', (peak, expected) => {
    expect(niceAxisMax(peak)).toBe(expected)
  })

  it('leaves a mid gridline a person can read — every step halves to a round number', () => {
    for (const peak of [7, 11, 201, 350_000_000, 826_200_000]) {
      const half = niceAxisMax(peak) / 2
      // No third decimal place: 400→200, 250→125, 150→75 all pass; a ramp step
      // that halved to 1.333… would put three digits of noise on the axis.
      expect(formatTick(half)).not.toMatch(/\.\d\d/)
    }
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
    // POD-718: every Opus this matches is $5/$25. The row sat at the retired
    // Opus 4.1 tier of $15/$75, which tripled the sheet's whole Anthropic side.
    ['claude-opus-5', 5],
    ['claude-opus-4-8', 5],
    ['claude-opus-4-5', 5],
    // Anthropic made the launch tier permanent; this must precede `sonnet`.
    ['claude-sonnet-5', 2],
    ['claude-sonnet-4-5', 3],
    // POD-670: fable's id names no family the other rows match, so it used to
    // land on the Sonnet-priced fallback at a third of its real rate.
    ['claude-fable-5', 10],
    ['gpt-5', 1.25],
    // Retired, but historical buckets still carry the id and it billed here.
    ['gpt-5-codex', 1.25],
    // POD-718: the gpt-5.6 family reached the gpt-5 row by substring fallback;
    // each current tier has its own rate and the narrower ids must win.
    ['gpt-5.6-sol', 5],
    ['gpt-5.6-terra', 2.5],
    ['gpt-5.6-luna', 1],
    // The bare alias routes to Sol, so it prices as Sol.
    ['gpt-5.6', 5],
    ['gpt-5.5', 5],
    ['gpt-5.3-codex', 1.75],
    // Narrower ids precede the family, so these keep their own price.
    ['gpt-5.4-nano', 0.2],
    ['gpt-5.4-mini', 0.75],
    ['gpt-5.4', 2.5],
    ['gpt-5-mini', 0.25],
    ['gpt-5-nano', 0.05],
    ['grok-4.6', 2],
    ['grok-4.6-build', 2],
    ['grok-4.5', 2],
    ['grok-4.3', 1.25],
    ['grok-4.20-0309-reasoning', 1.25],
    ['grok-build-0.1', 1],
  ])('prices %s at $%d per MTok of input', (model, expected) => {
    expect(bucketCostUsd(bucket(model))).toBeCloseTo(expected, 6)
  })

  // OpenAI publishes no price for the Codex guardian's id. It takes the fallback
  // and gets NAMED as unpriced rather than being quietly charged an invented
  // rate that the sheet would then present as a list price.
  it('leaves codex-auto-review on the flagged fallback, not an invented rate', () => {
    expect(bucketCostUsd(bucket('codex-auto-review'))).toBeCloseTo(3, 6)
    const s = usageSummary(
      [{ ...bucket('codex-auto-review'), hour: new Date(2026, 7, 7, 10).toISOString() }],
      new Date(2026, 7, 7, 14, 30).getTime(),
    )
    expect(s.unpricedModels).toEqual(['codex-auto-review'])
  })

  it('bills cache reads at a tenth of input, on both providers', () => {
    const cached = { inputTokens: 0, cacheReadTokens: 1_000_000 }
    expect(bucketCostUsd(bucket('gpt-5', cached))).toBeCloseTo(0.125, 6)
    expect(bucketCostUsd(bucket('claude-sonnet-4-5', cached))).toBeCloseTo(0.3, 6)
    expect(bucketCostUsd(bucket('claude-opus-5', cached))).toBeCloseTo(0.5, 6)
    expect(bucketCostUsd(bucket('gpt-5.6-sol', cached))).toBeCloseTo(0.5, 6)
    // xAI's grok-4.6 cached-input rate is $0.50, a quarter of input, not a tenth.
    expect(bucketCostUsd(bucket('grok-4.6', cached))).toBeCloseTo(0.5, 6)
  })

  // The 1.25x cache-write multiplier used to be hardcoded for every model, which
  // invented a charge OpenAI does not make on anything outside gpt-5.6 — and
  // stayed invisible only because Codex reports the field as zero.
  it('bills cache writes only where the provider actually charges for them', () => {
    const written = { inputTokens: 0, cacheCreationTokens: 1_000_000 }
    expect(bucketCostUsd(bucket('claude-opus-5', written))).toBeCloseTo(6.25, 6)
    expect(bucketCostUsd(bucket('gpt-5.6-sol', written))).toBeCloseTo(6.25, 6)
    expect(bucketCostUsd(bucket('gpt-5', written))).toBeCloseTo(0, 6)
    expect(bucketCostUsd(bucket('gpt-5-mini', written))).toBeCloseTo(0, 6)
  })

  it('bills Anthropic 5-minute writes at 1.25x and 1-hour writes at 2x input', () => {
    const fiveMinute = { inputTokens: 0, cacheCreationTokens: 1_000_000 }
    const oneHour = {
      inputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
    }
    expect(bucketCostUsd(bucket('claude-sonnet-5', fiveMinute))).toBeCloseTo(2.5, 6)
    expect(bucketCostUsd(bucket('claude-sonnet-5', oneHour))).toBeCloseTo(4, 6)
    expect(bucketCostUsd(bucket('claude-opus-5', fiveMinute))).toBeCloseTo(6.25, 6)
    expect(bucketCostUsd(bucket('claude-opus-5', oneHour))).toBeCloseTo(10, 6)
  })

  it('prices Sonnet 5 output at its permanent $10 tier', () => {
    const out = { inputTokens: 0, outputTokens: 1_000_000 }
    expect(bucketCostUsd(bucket('claude-sonnet-5', out))).toBeCloseTo(10, 6)
  })

  // The fallback understated fable's output rate by more than its input rate,
  // and output is where the dollars are — so the output side gets its own case.
  it('bills fable output at its own rate, not the fallback', () => {
    const out = { inputTokens: 0, outputTokens: 1_000_000 }
    expect(bucketCostUsd(bucket('claude-fable-5', out))).toBeCloseTo(50, 6)
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

// POD-596: the sheet's shape moved from seven day totals to 168 hour slots, a
// token/cost composition and a cost-ranked model list. Each of the cases below
// is a way the old summary got one of those wrong.
describe('usageSummary', () => {
  // A fixed local clock: 2026-08-07 14:00 local, so "now" sits inside a day and
  // the trailing hours of it are genuinely in the future.
  const now = new Date(2026, 7, 7, 14, 30).getTime()
  const atLocal = (d: number, h: number): string => new Date(2026, 7, d, h).toISOString()
  const bucket = (over: Partial<UsageBucketWire> = {}): UsageBucketWire => ({
    hour: atLocal(7, 10),
    model: 'claude-opus-5',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 3,
    ...over,
  })

  it('lays out seven local days of 24 hours, oldest first', () => {
    const s = usageSummary([], now)
    expect(s.days).toHaveLength(7)
    expect(s.days.every((d) => d.hours.length === 24)).toBe(true)
    expect(s.days[0]?.day).toBe('2026-08-01')
    expect(s.days[6]?.day).toBe('2026-08-07')
    expect(s.days[6]?.label).toBe('Fri 07')
  })

  it('marks the tail of today as future, which is not the same as empty', () => {
    const s = usageSummary([], now)
    const today = s.days[6]!
    // 14:30 now, so 00:00–14:00 have happened and 15:00 onward have not.
    expect(today.hours.filter((h) => h.future)).toHaveLength(9)
    expect(today.hours[14]?.future).toBe(false)
    expect(today.hours[15]?.future).toBe(true)
    // No earlier day has a future hour — the whole day is behind the clock.
    expect(
      s.days
        .slice(0, 6)
        .flatMap((d) => d.hours)
        .some((h) => h.future),
    ).toBe(false)
  })

  it('lands a bucket in the local hour that contains it, and peaks off the busiest', () => {
    const s = usageSummary([bucket({ hour: atLocal(6, 3) }), bucket({ hour: atLocal(7, 10) })], now)
    expect(s.days[5]?.hours[3]?.totalTokens).toBe(1_000_000)
    expect(s.days[6]?.hours[10]?.totalTokens).toBe(1_000_000)
    expect(s.peakHourTokens).toBe(1_000_000)
    expect(s.days[6]?.totalTokens).toBe(1_000_000)
  })

  it('drops the `<synthetic>` placeholder from the models AND from the reply counts', () => {
    // The bug this exists for: a 0-token row that outranked nothing but was
    // permanently in the table, and 9 replies nobody's agent ever received.
    const s = usageSummary(
      [
        bucket(),
        bucket({
          model: '<synthetic>',
          inputTokens: 0,
          messages: 9,
        }),
      ],
      now,
    )
    expect(s.models.map((m) => m.model)).toEqual(['claude-opus-5'])
    expect(s.week.messages).toBe(3)
    expect(s.fiveHour.messages).toBe(3)
  })

  it('ranks models by cost, not by tokens — the measure the sheet leads with', () => {
    // A cheap model with far more tokens must not outrank an expensive one: 20
    // MTok of Luna input is $20, 5 MTok of Opus input is $25.
    const s = usageSummary(
      [
        bucket({ model: 'gpt-5.6-luna', inputTokens: 20_000_000 }),
        bucket({ model: 'claude-opus-5', inputTokens: 5_000_000 }),
      ],
      now,
    )
    expect(s.models.map((m) => m.model)).toEqual(['claude-opus-5', 'gpt-5.6-luna'])
    expect(s.models[0]?.totalTokens).toBeLessThan(s.models[1]!.totalTokens)
  })

  it('splits token share from cost share — the reading the sheet exists to show', () => {
    // 10 MTok of Sonnet cache reads ($3) against 1 MTok of output ($15): the
    // cache reads are 91% of the tokens and 17% of the bill.
    const s = usageSummary(
      [
        bucket({ model: 'claude-sonnet-4-5', inputTokens: 0, cacheReadTokens: 10_000_000 }),
        bucket({ model: 'claude-sonnet-4-5', inputTokens: 0, outputTokens: 1_000_000 }),
      ],
      now,
    )
    const byKey = Object.fromEntries(s.composition.map((c) => [c.key, c]))
    expect(byKey.cacheRead?.tokens).toBe(10_000_000)
    expect(byKey.cacheRead?.estCostUsd).toBeCloseTo(3, 6)
    expect(byKey.cacheRead?.costWeightRatio).toBeCloseTo(11 / 60, 6)
    expect(byKey.output?.tokens).toBe(1_000_000)
    expect(byKey.output?.estCostUsd).toBeCloseTo(15, 6)
    expect(byKey.output?.costWeightRatio).toBeCloseTo(55 / 6, 6)
    // Every class is present even at zero, so the block holds its four rows —
    // in list-price order, cheapest token first. A cache write bills at 1.25x
    // input for 5m or 2x for Anthropic's 1h tier, so it is the second DEAREST
    // kind, never the second cheapest (POD-755).
    expect(s.composition.map((c) => c.key)).toEqual(['cacheRead', 'input', 'cacheWrite', 'output'])
  })

  it.each([
    {
      name: 'one active day',
      buckets: [{ hour: atLocal(7, 10), inputTokens: 1_000_000 }],
      days: 1,
      rate: 5,
    },
    {
      name: 'two active days',
      buckets: [
        { hour: atLocal(6, 10), inputTokens: 1_000_000 },
        { hour: atLocal(7, 10), inputTokens: 3_000_000 },
      ],
      days: 2,
      rate: 10,
    },
    {
      name: 'no active days',
      buckets: [{ hour: atLocal(7, 10), inputTokens: 0 }],
      days: 0,
      rate: null,
    },
  ])('derives the per-active-day reading for $name', ({ buckets, days, rate }) => {
    const s = usageSummary(
      buckets.map((over) => bucket({ ...ZERO_BUCKET, ...over })),
      now,
    )
    expect(s.activeDayCount).toBe(days)
    if (rate === null) expect(s.costPerActiveDayUsd).toBeNull()
    else expect(s.costPerActiveDayUsd).toBeCloseTo(rate, 6)
  })

  // Opus: input $5, cache read $0.50, output $25. A cached MTok therefore saves
  // $4.50 — read off the two rates, not off a hardcoded "nine times the charge".
  it.each([
    { cacheReadTokens: 1_000_000, outputTokens: 0, savings: 4.5, multiple: 9 },
    { cacheReadTokens: 1_000_000, outputTokens: 1_000_000, savings: 4.5, multiple: 4.5 / 25.5 },
    { cacheReadTokens: 0, outputTokens: 1_000_000, savings: 0, multiple: 0 },
  ])('derives cache savings from $cacheReadTokens cached tokens', ({
    cacheReadTokens,
    outputTokens,
    savings,
    multiple,
  }) => {
    const s = usageSummary([bucket({ inputTokens: 0, cacheReadTokens, outputTokens })], now)
    expect(s.cacheSavingsUsd).toBeCloseTo(savings, 6)
    expect(s.cacheSavingsMultiple).toBeCloseTo(multiple, 6)
  })

  it('groups models by provider and ranks the rollup by cost', () => {
    const s = usageSummary(
      [
        // Sol at $5 and Luna at $1 are 5x apart, so the rollup is also the
        // check that the two are not being flattened onto one gpt-5.6 rate.
        bucket({ model: 'gpt-5.6-sol', inputTokens: 8_000_000, messages: 2 }),
        bucket({ model: 'gpt-5.6-luna', inputTokens: 4_000_000, messages: 3 }),
        bucket({ model: 'claude-opus-5', inputTokens: 10_000_000, messages: 5 }),
        bucket({ model: 'grok-4.6', inputTokens: 2_000_000, messages: 4 }),
        bucket({ model: 'future-vendor', inputTokens: 1_000_000, messages: 7 }),
      ],
      now,
    )

    // Anthropic ($50) outranks OpenAI ($44) here even though the OpenAI rows
    // came first, so this fails if the rollup ever stops sorting by cost.
    // xAI at $4 sits between OpenAI and the unpriced leftover.
    expect(s.providers.map((provider) => provider.provider)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'other',
    ])
    expect(s.providers[1]).toMatchObject({ totalTokens: 12_000_000, messages: 5 })
    expect(s.providers[1]?.estCostUsd).toBeCloseTo(44, 6)
    expect(s.unpricedModels).toEqual(['future-vendor'])
  })

  // The sheet flags unpriced models so an approximate figure says so. Fable was
  // being flagged AND charged the fallback rate; now it is neither.
  it('no longer lists fable as unpriced', () => {
    const s = usageSummary([bucket({ model: 'claude-fable-5', inputTokens: 1_000_000 })], now)
    expect(s.unpricedModels).toEqual([])
  })
})

describe('costWeightRatio', () => {
  it.each([
    [25, 100, 50, 100, 2],
    [50, 100, 25, 100, 0.5],
    [50, 100, 0, 100, 0],
    [0, 100, 25, 100, null],
    [25, 0, 25, 100, null],
    [25, 100, 25, 0, null],
  ])('divides cost share by token share for %d/%d tokens and %d/%d cost', (tokens, totalTokens, cost, totalCost, expected) => {
    expect(costWeightRatio(tokens, totalTokens, cost, totalCost)).toBe(expected)
  })

  it.each([
    [42, '42x'],
    [10, '10x'],
    [0.7, '0.7x'],
    [null, '—'],
  ])('formats %s as %s', (ratio, expected) => {
    expect(formatCostWeightRatio(ratio)).toBe(expected)
  })
})

describe('bucketProvider', () => {
  it.each([
    ['claude-opus-5', 'anthropic'],
    ['gpt-5.6-sol', 'openai'],
    // The guardian subagent's id names neither family in the usual place.
    ['codex-auto-review', 'openai'],
    ['grok-4.6', 'xai'],
    ['grok-4.6-build', 'xai'],
    // An id belonging to neither is not guessed into one.
    ['some-new-model', 'other'],
  ])('reads %s as %s', (model, expected) => {
    expect(bucketProvider(model)).toBe(expected)
  })
})

describe('formatShare', () => {
  it('keeps a sliver from reading as zero', () => {
    expect(formatShare(973, 1000)).toBe('97.3%')
    expect(formatShare(3, 1000)).toBe('0.3%')
    // Below a tenth of a percent it is still not nothing, and must not say 0.0%.
    expect(formatShare(1, 100_000)).toBe('<0.1%')
    expect(formatShare(0, 1000)).toBe('0%')
    // A whole of zero is the cold sheet — no division, no NaN.
    expect(formatShare(0, 0)).toBe('0%')
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

describe('formatUsdTick', () => {
  it.each([
    [700, '$700'],
    [75, '$75'],
    [2.5, '$2.5'],
    [0.25, '$0.25'],
    [0, '$0'],
  ])('formats the dollar ruler mark %d as %s', (value, expected) => {
    expect(formatUsdTick(value)).toBe(expected)
  })
})
