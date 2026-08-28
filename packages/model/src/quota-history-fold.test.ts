import { describe, expect, it } from 'vitest'
import {
  foldSample,
  foldSamples,
  isPartial,
  isSameInstance,
  openInstance,
  type QuotaSample,
  RESET_DROP_PP,
  resetToleranceMs,
  TRAIL_MAX_POINTS,
  windowStartMs,
} from './quota-history-fold'

const MINUTE = 60_000
const SAMPLING = 15 * MINUTE

function sample(over: Partial<QuotaSample> = {}): QuotaSample {
  return {
    accountKey: 'claude-code::a@b.c',
    agent: 'claude-code',
    windowKey: 'weekly-all',
    label: 'Weekly',
    usedPercent: 10,
    resetsAtMs: Date.parse('2026-08-25T01:00:00.000Z'),
    windowMinutes: 10080,
    atMs: Date.parse('2026-08-24T10:45:00.000Z'),
    source: 'live',
    ...over,
  }
}

describe('reset-time jitter', () => {
  // The measured traces. If these ever split into separate windows, the ledger
  // draws one column per poll instead of one per reset.
  it('holds one instance across Claude sub-second drift in both directions', () => {
    const drift = ['01:00:00.039', '00:59:59.325', '00:59:59.714', '01:00:00.097']
    const samples = drift.map((t, i) =>
      sample({
        resetsAtMs: Date.parse(`2026-08-25T${t}Z`),
        usedPercent: 46 + i,
        atMs: Date.parse('2026-08-24T10:53:00.000Z') + i * 2 * MINUTE,
      }),
    )
    const windows = foldSamples(samples, SAMPLING)
    expect(windows).toHaveLength(1)
    expect(windows[0]?.sampleCount).toBe(4)
    expect(windows[0]?.peakPercent).toBe(49)
  })

  it('holds one instance across the Codex whole-second wobble', () => {
    const drift = ['07:00:43', '07:00:44', '07:00:43', '07:00:44']
    const samples = drift.map((t, i) =>
      sample({
        agent: 'codex',
        windowKey: 'weekly',
        resetsAtMs: Date.parse(`2026-08-31T${t}.000Z`),
        usedPercent: 30,
        atMs: Date.parse('2026-08-24T10:45:00.000Z') + i * MINUTE,
      }),
    )
    expect(foldSamples(samples, SAMPLING)).toHaveLength(1)
  })

  it('rounding to the minute would have split the Claude trace — tolerance does not', () => {
    // 01:00:00.039 and 00:59:59.325 truncate to DIFFERENT minutes.
    const a = sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00.039Z') })
    const b = sample({ resetsAtMs: Date.parse('2026-08-25T00:59:59.325Z') })
    expect(Math.floor(a.resetsAtMs / MINUTE)).not.toBe(Math.floor(b.resetsAtMs / MINUTE))
    expect(isSameInstance(openInstance(a, SAMPLING), b)).toBe(true)
  })
})

describe('reset detection', () => {
  // The rollover measured live: 12% @ resets 11:00 → 1% @ resets 16:00.
  it('opens a new window when the reset time advances by a whole window', () => {
    const before = sample({
      windowKey: 'session',
      windowMinutes: 300,
      usedPercent: 12,
      resetsAtMs: Date.parse('2026-08-24T11:00:00.097Z'),
      atMs: Date.parse('2026-08-24T11:01:40Z'),
    })
    const after = sample({
      windowKey: 'session',
      windowMinutes: 300,
      usedPercent: 1,
      resetsAtMs: Date.parse('2026-08-24T16:00:00.504Z'),
      atMs: Date.parse('2026-08-24T11:02:42Z'),
    })
    const windows = foldSamples([before, after], SAMPLING)
    expect(windows).toHaveLength(2)
    expect(windows[0]?.peakPercent).toBe(12)
    expect(windows[1]?.firstPercent).toBe(1)
  })

  it('treats a percent DROP with a steady reset time as decay, not a reset', () => {
    // A rolling window shedding old turns must not be sliced into two columns.
    const steady = Date.parse('2026-08-25T01:00:00.000Z')
    const windows = foldSamples(
      [
        sample({ usedPercent: 40, resetsAtMs: steady, atMs: 1_000 }),
        sample({ usedPercent: 31, resetsAtMs: steady + 200, atMs: 2_000 }),
      ],
      SAMPLING,
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]?.peakPercent).toBe(40)
    expect(windows[0]?.lastPercent).toBe(31)
  })

  it('opens a new window when the pool empties, even if the reset time barely moves', () => {
    // A provider whose reset time tracks when the oldest usage ages out can empty
    // its pool without the reset ever advancing past the tolerance. Measured on
    // real Codex readings: 94% → 0% with the reset creeping, not jumping.
    const steady = Date.parse('2026-08-31T07:00:00Z')
    const windows = foldSamples(
      [
        sample({ usedPercent: 94, resetsAtMs: steady, atMs: 1_000 }),
        sample({ usedPercent: 0, resetsAtMs: steady + 30_000, atMs: 2_000 }),
        sample({ usedPercent: 12, resetsAtMs: steady + 30_000, atMs: 3_000 }),
      ],
      SAMPLING,
    )
    expect(windows).toHaveLength(2)
    expect(windows[0]?.peakPercent).toBe(94)
    expect(windows[1]?.peakPercent).toBe(12)
  })

  it('leaves ordinary oscillation alone — the threshold sits above it', () => {
    // 2,587 of the measured decreases were 2 points or less. None may split a row.
    const steady = Date.parse('2026-08-31T07:00:00Z')
    const wobble = [58, 57, 58, 57, 59, 58]
    const windows = foldSamples(
      wobble.map((usedPercent, i) =>
        sample({ usedPercent, resetsAtMs: steady, atMs: 1_000 + i * 1_000 }),
      ),
      SAMPLING,
    )
    expect(windows).toHaveLength(1)
    expect(RESET_DROP_PP).toBeGreaterThan(20)
  })

  it('does not let an out-of-order backfill sample fake a reset', () => {
    // An older, lower reading arriving late is not the pool emptying.
    const opened = openInstance(sample({ usedPercent: 90, atMs: 5_000 }), SAMPLING)
    expect(isSameInstance(opened, sample({ usedPercent: 5, atMs: 1_000 }))).toBe(true)
  })

  it('does not swallow a window from weeks ago into the current one', () => {
    // The tolerance has to be two-sided. A one-sided `sample - instance <= tol`
    // is true for ANY older sample, so the live window absorbed the entire
    // backfill: no history, and a current row claiming a fortnight-old peak.
    const live = openInstance(
      sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z'), usedPercent: 5, atMs: 9_000 }),
      SAMPLING,
    )
    const old = sample({
      resetsAtMs: Date.parse('2026-08-11T01:00:00Z'),
      usedPercent: 93,
      atMs: 1_000,
    })
    expect(isSameInstance(live, old)).toBe(false)
  })

  it('still absorbs the backwards half of the jitter', () => {
    // Two-sided must not mean intolerant: sub-second drift runs both ways.
    const a = sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00.039Z') })
    const b = sample({ resetsAtMs: Date.parse('2026-08-25T00:59:59.325Z') })
    expect(isSameInstance(openInstance(a, SAMPLING), b)).toBe(true)
    expect(isSameInstance(openInstance(b, SAMPLING), a)).toBe(true)
  })

  it('does not merge two adjacent 5-hour windows', () => {
    const first = sample({ windowMinutes: 300, resetsAtMs: Date.parse('2026-08-24T11:00:00Z') })
    const second = sample({ windowMinutes: 300, resetsAtMs: Date.parse('2026-08-24T16:00:00Z') })
    expect(isSameInstance(openInstance(first, SAMPLING), second)).toBe(false)
  })

  it('clamps tolerance below a quarter-window so short windows stay separable', () => {
    expect(resetToleranceMs(10080)).toBe(5 * MINUTE)
    expect(resetToleranceMs(300)).toBe(5 * MINUTE)
    expect(resetToleranceMs(8)).toBe(2 * MINUTE)
    expect(resetToleranceMs(0)).toBe(5 * MINUTE)
  })
})

describe('peak, not last', () => {
  it('keeps the high-water mark when the closing sample is stale', () => {
    const windows = foldSamples(
      [
        sample({ usedPercent: 70, atMs: 1_000 }),
        sample({ usedPercent: 92, atMs: 2_000 }),
        sample({ usedPercent: 92, atMs: 3_000 }),
      ],
      SAMPLING,
    )
    expect(windows[0]?.peakPercent).toBe(92)
  })

  it('never lowers the peak on an out-of-order sample', () => {
    const opened = openInstance(sample({ usedPercent: 80, atMs: 5_000 }), SAMPLING)
    const folded = foldSample(opened, sample({ usedPercent: 20, atMs: 1_000 }), SAMPLING)
    expect(folded.peakPercent).toBe(80)
    expect(folded.lastPercent).toBe(80) // the older sample is not "latest"
    expect(folded.firstPercent).toBe(20) // but it does extend the window backwards
    expect(folded.firstSeenMs).toBe(1_000)
  })
})

describe('partial rows', () => {
  const started = Date.parse('2026-08-24T06:00:00Z')

  it('does not flag a window that simply opened above zero', () => {
    // The measured rollover opened at 1% with nothing missed.
    expect(isPartial(started + MINUTE, started, SAMPLING)).toBe(false)
  })

  it('flags a window first seen well after it started', () => {
    expect(isPartial(started + 3 * 60 * MINUTE, started, SAMPLING)).toBe(true)
  })

  it('cannot judge a window whose duration the provider never reported', () => {
    expect(isPartial(started, undefined, SAMPLING)).toBe(false)
    expect(windowStartMs(started, 0)).toBeUndefined()
  })
})

describe('purity and re-derivation', () => {
  it('does not mutate the instance it was handed', () => {
    // `appendTrail` used to write `last[0] = minutes` straight through into the
    // caller's array, so a "pure" fold quietly edited its own input.
    const opened = openInstance(sample({ usedPercent: 20, atMs: 1_000 }), SAMPLING)
    const before = JSON.stringify(opened.trail)
    foldSample(opened, sample({ usedPercent: 20, atMs: 2_000 }), SAMPLING)
    expect(JSON.stringify(opened.trail)).toBe(before)
  })

  it('clears `partial` when a later sample proves the start was observed', () => {
    // A row that keeps a stale `partial` goes on claiming "start not observed"
    // about a start we can now show we watched.
    const startedAt = Date.parse('2026-08-18T01:00:00Z')
    const late = openInstance(sample({ atMs: startedAt + 5 * 60 * MINUTE }), SAMPLING)
    expect(late.partial).toBe(true)
    const withEarly = foldSample(late, sample({ atMs: startedAt + MINUTE }), SAMPLING)
    expect(withEarly.partial).toBe(false)
  })
})

describe('trail', () => {
  it('records changes rather than poll cadence', () => {
    const base = Date.parse('2026-08-24T06:00:00Z')
    const windows = foldSamples(
      [
        sample({ usedPercent: 1, atMs: base }),
        sample({ usedPercent: 1, atMs: base + MINUTE }),
        sample({ usedPercent: 1, atMs: base + 2 * MINUTE }),
        sample({ usedPercent: 4, atMs: base + 3 * MINUTE }),
      ],
      SAMPLING,
    )
    const trail = windows[0]?.trail ?? []
    expect(trail.map((p) => p[1])).toEqual([1, 4])
  })

  it('decimates without losing the open or the tail', () => {
    const base = Date.parse('2026-08-24T06:00:00Z')
    const samples = Array.from({ length: TRAIL_MAX_POINTS * 3 }, (_, i) =>
      sample({ usedPercent: i * 0.1, atMs: base + i * MINUTE }),
    )
    const trail = foldSamples(samples, SAMPLING)[0]?.trail ?? []
    expect(trail.length).toBeLessThanOrEqual(TRAIL_MAX_POINTS)
    expect(trail[0]?.[1]).toBe(0)
    expect(trail[trail.length - 1]?.[1]).toBeCloseTo((TRAIL_MAX_POINTS * 3 - 1) * 0.1)
  })
})

describe('backfill meeting live sampling', () => {
  it('promotes a recovered window to live once it is genuinely observed', () => {
    const opened = openInstance(sample({ source: 'backfill', atMs: 1_000 }), SAMPLING)
    expect(opened.source).toBe('backfill')
    expect(foldSample(opened, sample({ source: 'live', atMs: 2_000 }), SAMPLING).source).toBe(
      'live',
    )
  })

  it('folds an unordered backfill into windows in the order they happened', () => {
    const early = sample({ resetsAtMs: Date.parse('2026-08-17T07:00:00Z'), atMs: 1_000 })
    const late = sample({ resetsAtMs: Date.parse('2026-08-24T07:00:00Z'), atMs: 9_000 })
    const windows = foldSamples([late, early], SAMPLING)
    expect(windows).toHaveLength(2)
    expect(windows[0]?.resetsAtMs).toBeLessThan(windows[1]?.resetsAtMs ?? 0)
  })
})
