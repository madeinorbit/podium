import type { QuotaSample } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

const SAMPLING = 15 * 60_000

let store: SessionStore

beforeEach(async () => {
  store = await openTestStore(':memory:')
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
  it('folds repeated readings into one row', async () => {
    for (let i = 0; i < 5; i++) {
      await store.quotaHistory.record(
        sample({ usedPercent: 10 + i, atMs: 1_000 + i * 60_000 }),
        SAMPLING,
      )
    }
    expect(await store.quotaHistory.countAll()).toBe(1)
    const rows = await store.quotaHistory.list(0, Date.now())
    expect(rows[0]?.peakPercent).toBe(14)
    expect(rows[0]?.sampleCount).toBe(5)
  })

  it('survives reset-time jitter that crosses a bucket boundary', async () => {
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
    expect(await store.quotaHistory.countAll()).toBe(1)
  })

  it('opens a second row when the window actually resets', async () => {
    const first = await store.quotaHistory.record(
      sample({ windowKey: 'session', windowMinutes: 300, usedPercent: 12, atMs: 1_000 }),
      SAMPLING,
    )
    const second = await store.quotaHistory.record(
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
    expect(await store.quotaHistory.countAll()).toBe(2)
  })

  it('keeps two accounts and two windows apart', async () => {
    await store.quotaHistory.record(sample(), SAMPLING)
    await store.quotaHistory.record(
      sample({ accountKey: 'codex::a@b.c', agent: 'codex' }),
      SAMPLING,
    )
    await store.quotaHistory.record(sample({ windowKey: 'session', windowMinutes: 300 }), SAMPLING)
    expect(await store.quotaHistory.countAll()).toBe(3)
  })

  it('keeps backfilled windows separate from the live one that was written first', async () => {
    // THE ORDER THIS RUNS IN IS THE PRODUCT ORDER: the sampler boots at 30 s and
    // the backfill at 60 s, so the current window is always in the table before
    // any recovered sample arrives. With a one-sided tolerance every one of those
    // older samples matched the live row and was folded into it — no history was
    // ever created, AND the live row inherited a peak from a window that closed a
    // fortnight earlier, which the ledger then reported as "best".
    await store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z'), usedPercent: 5, atMs: 9_000 }),
      SAMPLING,
    )
    for (const [reset, percent] of [
      ['2026-08-11T01:00:00Z', 40],
      ['2026-08-18T01:00:00Z', 93],
    ] as const) {
      await store.quotaHistory.record(
        {
          ...sample({ resetsAtMs: Date.parse(reset), usedPercent: percent }),
          atMs: Date.parse(reset) - 3_600_000,
          source: 'backfill',
        },
        SAMPLING,
      )
    }
    const rows = await store.quotaHistory.list(0, Date.parse('2026-08-24T00:00:00Z'))
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.peakPercent).sort((a, b) => a - b)).toEqual([5, 40, 93])
    const live = rows.find((r) => r.resetsAt.startsWith('2026-08-25'))
    expect(live?.peakPercent).toBe(5)
    expect(live?.source).toBe('live')
  })

  it('folds a repeated backfill sample into the window it already recovered', async () => {
    const reset = Date.parse('2026-08-11T01:00:00Z')
    const back = { ...sample({ resetsAtMs: reset, usedPercent: 40 }), source: 'backfill' as const }
    await store.quotaHistory.record({ ...back, atMs: reset - 7_200_000 }, SAMPLING)
    await store.quotaHistory.record({ ...back, usedPercent: 55, atMs: reset - 3_600_000 }, SAMPLING)
    expect(await store.quotaHistory.countAll()).toBe(1)
    expect((await store.quotaHistory.list(0, Date.now()))[0]?.peakPercent).toBe(55)
  })

  it('converges when two machines report the same account', async () => {
    // The dedupe the ledger depends on: one pool, two reporters, one row.
    const shared = sample({ usedPercent: 46 })
    await store.quotaHistory.record({ ...shared, atMs: 1_000 }, SAMPLING)
    await store.quotaHistory.record({ ...shared, atMs: 1_500 }, SAMPLING)
    expect(await store.quotaHistory.countAll()).toBe(1)
  })
})

describe('reading back', () => {
  it('marks a window closed once now is past its reset', async () => {
    const resetsAtMs = Date.parse('2026-08-25T01:00:00.000Z')
    await store.quotaHistory.record(sample({ resetsAtMs }), SAMPLING)
    expect((await store.quotaHistory.list(0, resetsAtMs - 1_000))[0]?.closed).toBe(false)
    expect((await store.quotaHistory.list(0, resetsAtMs + 1_000))[0]?.closed).toBe(true)
  })

  it('derives the window start from the reported duration', async () => {
    await store.quotaHistory.record(sample(), SAMPLING)
    const [wire] = await store.quotaHistory.list(0, Date.now())
    expect(wire?.startedAt).toBe('2026-08-18T01:00:00.000Z')
  })

  it('omits a start the provider gave no duration for', async () => {
    await store.quotaHistory.record(sample({ windowMinutes: 0 }), SAMPLING)
    expect((await store.quotaHistory.list(0, Date.now()))[0]?.startedAt).toBeUndefined()
  })

  it('honours the lookback', async () => {
    await store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-01-01T00:00:00Z') }),
      SAMPLING,
    )
    await store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z') }),
      SAMPLING,
    )
    expect(
      await store.quotaHistory.list(Date.parse('2026-08-01T00:00:00Z'), Date.now()),
    ).toHaveLength(1)
  })

  it('stores the burn curve for a window it has not been asked to draw yet', async () => {
    const resetsAtMs = Date.parse('2026-08-25T01:00:00.000Z')
    for (let i = 0; i < 4; i++) {
      await store.quotaHistory.record(
        sample({ resetsAtMs, usedPercent: i * 10, atMs: 1_000 + i * 60_000 }),
        SAMPLING,
      )
    }
    // The trail is deliberately not on the list wire — it is captured now so the
    // burn-curve view has data the day it is built, since it cannot be recovered.
    expect(
      await store.quotaHistory.trail('claude-code::a@b.c', 'weekly-all', resetsAtMs),
    ).toHaveLength(4)
  })
})

describe('retention', () => {
  it('drops windows that reset before the cutoff', async () => {
    await store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-01-01T00:00:00Z') }),
      SAMPLING,
    )
    await store.quotaHistory.record(
      sample({ resetsAtMs: Date.parse('2026-08-25T01:00:00Z') }),
      SAMPLING,
    )
    expect(await store.quotaHistory.prune(Date.parse('2026-08-01T00:00:00Z'))).toBe(1)
    expect(await store.quotaHistory.countAll()).toBe(1)
  })
})

/**
 * THE CONFLICT ARM OF `insert`, which no test walked before [POD-3392].
 *
 * `record` reaches `insert` only when the sample opens a NEW window instance,
 * and it normally opens one whose bucket is free — so the `ON CONFLICT
 * (account_key, window_key, resets_at_bucket) DO UPDATE` clause, and the three
 * folds in it, were never executed. Found by mutation: replacing
 * `MAX(peak_percent, excluded.peak_percent)` with a plain `excluded.peak_percent`
 * left all 13 tests in this file green.
 *
 * That matters because the clause is not decoration. Two window INSTANCES can
 * land in one 60-second bucket — a pool that empties keeps almost the same reset
 * time, so `isSameInstance` says "new instance" (the drop exceeds `RESET_DROP_PP`)
 * while `bucketOf` says "same bucket". The row that already exists must then
 * absorb the new one and KEEP ITS PEAK, because the peak is what the ledger's bar
 * height is drawn from; taking `excluded`'s value would let a reset to 3% erase a
 * 90% week.
 */
describe('two instances in one bucket', () => {
  const RESETS = Date.parse('2026-08-25T01:00:00.000Z')

  it('folds into the existing row and keeps the higher peak', async () => {
    // A window observed high, then a pool reset that keeps the same reset time.
    await store.quotaHistory.record(
      sample({ usedPercent: 90, resetsAtMs: RESETS, atMs: 1_000 }),
      SAMPLING,
    )
    // usedPercent drops by more than RESET_DROP_PP (25), so this is a NEW
    // instance by `isSameInstance` — but `bucketOf` puts it in the same bucket.
    const second = await store.quotaHistory.record(
      sample({ usedPercent: 5, resetsAtMs: RESETS, atMs: 2_000 }),
      SAMPLING,
    )

    expect(second.openedWindow).toBe(true)
    // One row, because the bucket is the row's identity.
    expect(await store.quotaHistory.countAll()).toBe(1)

    const rows = await store.quotaHistory.list(0, Date.now())
    // The fold, one assertion per `DO UPDATE SET` clause.
    expect(rows[0]?.peakPercent).toBe(90)
    expect(rows[0]?.sampleCount).toBe(2)
    expect(rows[0]?.lastSeenAt).toBe(new Date(2_000).toISOString())
  })
})

/**
 * `partial` IS THE WAVE'S ONLY `mode: 'boolean'` COLUMN [POD-3221 spec rule 28].
 *
 * `quota_windows.partial` is declared `integer({ mode: 'boolean' })`, so drizzle's
 * own execution path returns TRUE or FALSE where the raw driver returned 1 or 0.
 * The pre-conversion mapper compared `row.partial === 1` and wrote
 * `instance.partial ? 1 : 0`; both are gone, because against a boolean
 * `true === 1` is FALSE and every row would have read as not partial.
 *
 * NOTHING ASSERTED THIS COLUMN BEFORE. A grep of this file for `partial` returned
 * only the fixture, so the mistake rule 28 describes would have been invisible
 * here: no error, no type error, and a wrong answer that looks like the ordinary
 * one. Both arms are pinned below, because a test that only ever saw `false`
 * cannot tell a working mapper from one that always returns `false`.
 */
describe('the partial flag survives the round trip', () => {
  const RESETS = Date.parse('2026-09-01T00:00:00.000Z')
  const WINDOW_MINUTES = 300
  const STARTED = RESETS - WINDOW_MINUTES * 60_000

  it('a window first seen long after it started is PARTIAL', async () => {
    // Well past `max(samplingInterval, window * PARTIAL_MISSED_FRACTION)`.
    await store.quotaHistory.record(
      sample({
        resetsAtMs: RESETS,
        windowMinutes: WINDOW_MINUTES,
        atMs: STARTED + 4 * 60 * 60_000,
      }),
      SAMPLING,
    )

    const rows = await store.quotaHistory.list(0, Date.now())
    expect(rows[0]?.partial).toBe(true)
  })

  it('a window caught at its start is NOT partial', async () => {
    await store.quotaHistory.record(
      sample({ resetsAtMs: RESETS, windowMinutes: WINDOW_MINUTES, atMs: STARTED }),
      SAMPLING,
    )

    const rows = await store.quotaHistory.list(0, Date.now())
    expect(rows[0]?.partial).toBe(false)
  })
})
