import type { QuotaSample } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

const SAMPLING = 15 * 60_000

let store: SessionStore

beforeEach(() => {
  store = openTestStore(':memory:')
})

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

describe('recording samples', () => {
  it('folds repeated readings into one row', () => {
    for (let i = 0; i < 5; i++) {
      store.quotaHistory.record(sample({ usedPercent: 10 + i, atMs: 1_000 + i * 60_000 }), SAMPLING)
    }
    expect(store.quotaHistory.countAll()).toBe(1)
    const rows = store.quotaHistory.list(0, Date.now())
    expect(rows[0]?.peakPercent).toBe(14)
    expect(rows[0]?.sampleCount).toBe(5)
  })

  it('survives reset-time jitter that crosses a bucket boundary', () => {
    // The measured Claude trace straddles an hour: 01:00:00.039 → 00:59:59.325.
    // The row's bucket is assigned once at insert and must never be recomputed,
    // or the jitter mints a duplicate row for a window already being tracked.
    const drift = ['01:00:00.039', '00:59:59.325', '00:59:59.714', '01:00:00.097']
    drift.forEach((t, i) => {
      store.quotaHistory.record(
        sample({ resetsAtMs: Date.parse(`2026-08-25T${t}Z`), atMs: 1_000 + i * 60_000 }),
        SAMPLING,
      )
    })
    expect(store.quotaHistory.countAll()).toBe(1)
  })

  it('opens a second row when the window actually resets', () => {
    const first = store.quotaHistory.record(
      sample({ windowKey: 'session', windowMinutes: 300, usedPercent: 12, atMs: 1_000 }),
      SAMPLING,
    )
    const second = store.quotaHistory.record(
      sample({
        windowKey: 'session',
        windowMinutes: 300,
        usedPercent: 1,
        resetsAtMs: Date.parse('2026-08-25T06:00:00.000Z'),
        atMs: 2_000,
      }),
      SAMPLING,
    )
    expect(first.openedWindow).toBe(true)
    expect(second.openedWindow).toBe(true)
    expect(store.quotaHistory.countAll()).toBe(2)
  })

  it('keeps two accounts and two windows apart', () => {
    store.quotaHistory.record(sample(), SAMPLING)
    store.quotaHistory.record(sample({ accountKey: 'codex::a@b.c', agent: 'codex' }), SAMPLING)
    store.quotaHistory.record(sample({ windowKey: 'session', windowMinutes: 300 }), SAMPLING)
    expect(store.quotaHistory.countAll()).toBe(3)
  })

  it('keeps backfilled windows separate from the live one that was written first', () => {
    // THE ORDER THIS RUNS IN IS THE PRODUCT ORDER: the sampler boots at 30 s and
    // the backfill at 60 s, so the current window is always in the table before
    // any recovered sample arrives. With a one-sided tolerance every one of those
    // older samples matched the live row and was folded into it — no history was
    // ever created, AND the live row inherited a peak from a window that closed a
    // fortnight earlier, which the ledger then reported as "best".
    store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z'), usedPercent: 5, atMs: 9_000 }),
      SAMPLING,
    )
    for (const [reset, percent] of [
      ['2026-08-11T01:00:00Z', 40],
      ['2026-08-18T01:00:00Z', 93],
    ] as const) {
      store.quotaHistory.record(
        {
          ...sample({ resetsAtMs: Date.parse(reset), usedPercent: percent }),
          atMs: Date.parse(reset) - 3_600_000,
          source: 'backfill',
        },
        SAMPLING,
      )
    }
    const rows = store.quotaHistory.list(0, Date.parse('2026-08-24T00:00:00Z'))
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.peakPercent).sort((a, b) => a - b)).toEqual([5, 40, 93])
    const live = rows.find((r) => r.resetsAt.startsWith('2026-08-25'))
    expect(live?.peakPercent).toBe(5)
    expect(live?.source).toBe('live')
  })

  it('folds a repeated backfill sample into the window it already recovered', () => {
    const reset = Date.parse('2026-08-11T01:00:00Z')
    const back = { ...sample({ resetsAtMs: reset, usedPercent: 40 }), source: 'backfill' as const }
    store.quotaHistory.record({ ...back, atMs: reset - 7_200_000 }, SAMPLING)
    store.quotaHistory.record({ ...back, usedPercent: 55, atMs: reset - 3_600_000 }, SAMPLING)
    expect(store.quotaHistory.countAll()).toBe(1)
    expect(store.quotaHistory.list(0, Date.now())[0]?.peakPercent).toBe(55)
  })

  it('converges when two machines report the same account', () => {
    // The dedupe the ledger depends on: one pool, two reporters, one row.
    const shared = sample({ usedPercent: 46 })
    store.quotaHistory.record({ ...shared, atMs: 1_000 }, SAMPLING)
    store.quotaHistory.record({ ...shared, atMs: 1_500 }, SAMPLING)
    expect(store.quotaHistory.countAll()).toBe(1)
  })
})

describe('reading back', () => {
  it('marks a window closed once now is past its reset', () => {
    const resetsAtMs = Date.parse('2026-08-25T01:00:00.000Z')
    store.quotaHistory.record(sample({ resetsAtMs }), SAMPLING)
    expect(store.quotaHistory.list(0, resetsAtMs - 1_000)[0]?.closed).toBe(false)
    expect(store.quotaHistory.list(0, resetsAtMs + 1_000)[0]?.closed).toBe(true)
  })

  it('derives the window start from the reported duration', () => {
    store.quotaHistory.record(sample(), SAMPLING)
    const [wire] = store.quotaHistory.list(0, Date.now())
    expect(wire?.startedAt).toBe('2026-08-18T01:00:00.000Z')
  })

  it('omits a start the provider gave no duration for', () => {
    store.quotaHistory.record(sample({ windowMinutes: 0 }), SAMPLING)
    expect(store.quotaHistory.list(0, Date.now())[0]?.startedAt).toBeUndefined()
  })

  it('honours the lookback', () => {
    store.quotaHistory.record(sample({ resetsAtMs: Date.parse('2026-01-01T00:00:00Z') }), SAMPLING)
    store.quotaHistory.record(sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z') }), SAMPLING)
    expect(store.quotaHistory.list(Date.parse('2026-08-01T00:00:00Z'), Date.now())).toHaveLength(1)
  })

  it('stores the burn curve for a window it has not been asked to draw yet', () => {
    const resetsAtMs = Date.parse('2026-08-25T01:00:00.000Z')
    for (let i = 0; i < 4; i++) {
      store.quotaHistory.record(
        sample({ resetsAtMs, usedPercent: i * 10, atMs: 1_000 + i * 60_000 }),
        SAMPLING,
      )
    }
    // The trail is deliberately not on the list wire — it is captured now so the
    // burn-curve view has data the day it is built, since it cannot be recovered.
    expect(store.quotaHistory.trail('claude-code::a@b.c', 'weekly-all', resetsAtMs)).toHaveLength(4)
  })
})

describe('retention', () => {
  it('drops windows that reset before the cutoff', () => {
    store.quotaHistory.record(sample({ resetsAtMs: Date.parse('2026-01-01T00:00:00Z') }), SAMPLING)
    store.quotaHistory.record(sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z') }), SAMPLING)
    expect(store.quotaHistory.prune(Date.parse('2026-08-01T00:00:00Z'))).toBe(1)
    expect(store.quotaHistory.countAll()).toBe(1)
  })
})
