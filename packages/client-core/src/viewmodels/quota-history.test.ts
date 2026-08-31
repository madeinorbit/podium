import type { QuotaWindowHistoryWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  cadenceLabel,
  formatLedgerSpan,
  isLedgerWindow,
  quotaLedger,
  windowDurationDays,
} from './quota-history'

function row(over: Partial<QuotaWindowHistoryWire> = {}): QuotaWindowHistoryWire {
  return {
    accountKey: 'codex::a@b.c',
    agent: 'codex',
    windowKey: 'weekly',
    label: 'Weekly',
    resetsAt: '2026-08-24T07:00:00.000Z',
    startedAt: '2026-08-17T07:00:00.000Z',
    windowMinutes: 10080,
    firstSeenAt: '2026-08-17T07:05:00.000Z',
    lastSeenAt: '2026-08-24T06:50:00.000Z',
    firstPercent: 0,
    peakPercent: 71,
    lastPercent: 71,
    sampleCount: 400,
    closed: true,
    partial: false,
    source: 'live',
    ...over,
  }
}

describe('scope', () => {
  it('charts weekly pools and leaves the 5-hour session out', () => {
    expect(isLedgerWindow({ windowKey: 'weekly' })).toBe(true)
    expect(isLedgerWindow({ windowKey: 'weekly-all' })).toBe(true)
    expect(isLedgerWindow({ windowKey: 'session' })).toBe(false)
    // Model-scoped weekly windows are extra capacity for one model, not the pool
    // that gates the harness — charting them beside it would double-count.
    expect(isLedgerWindow({ windowKey: 'weekly-scoped:model:fable' })).toBe(false)
  })

  it('drops out-of-scope rows before they reach a strip', () => {
    const view = quotaLedger([
      row(),
      row({ windowKey: 'session', resetsAt: '2026-08-24T11:00:00Z' }),
    ])
    expect(view.strips).toHaveLength(1)
    expect(view.completedCount).toBe(1)
  })
})

describe('strips', () => {
  it('groups by account and window, oldest column first', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-24T07:00:00Z', peakPercent: 71 }),
      row({ resetsAt: '2026-08-10T07:00:00Z', peakPercent: 40 }),
      row({ resetsAt: '2026-08-17T07:00:00Z', peakPercent: 100 }),
    ])
    expect(view.strips).toHaveLength(1)
    expect(view.strips[0]?.columns.map((c) => c.peakPercent)).toEqual([40, 100, 71])
  })

  it('keeps two harnesses in separate strips with their own marks', () => {
    const view = quotaLedger([
      row(),
      row({ accountKey: 'claude-code::a@b.c', agent: 'claude-code', windowKey: 'weekly-all' }),
    ])
    expect(view.strips.map((s) => s.mark)).toEqual(['CC', 'CX'])
    expect(view.strips.map((s) => s.agentLabel)).toEqual(['Claude Code', 'Codex'])
  })

  it('averages completed windows only — a running one has no final answer', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-17T07:00:00Z', peakPercent: 80 }),
      row({ resetsAt: '2026-08-24T07:00:00Z', peakPercent: 4, closed: false }),
    ])
    expect(view.completedCount).toBe(1)
    expect(view.averagePeak).toBe(80)
    expect(view.strips[0]?.columns).toHaveLength(2)
  })

  it('marks the running window in its span label', () => {
    const view = quotaLedger([row({ closed: false })])
    expect(view.strips[0]?.columns[0]?.spanLabel).toMatch(/ · now$/)
  })

  it('labels the axis with the reset date alone, so it fits a 96px column', () => {
    // The full span truncated to `Aug 24 – 31…`, cutting off exactly the part
    // that tells one column from the next. Consecutive windows are identified by
    // their reset; the whole period stays on the hover title.
    const view = quotaLedger([row({ resetsAt: '2026-08-24T07:00:00Z' })])
    const column = view.strips[0]?.columns[0]
    expect(column?.endLabel).toMatch(/^\w{3} \d{1,2}$/)
    expect(column?.endLabel.length).toBeLessThanOrEqual(7)
    expect(column?.spanLabel).toContain('–')
  })

  it('labels the running window `now` rather than a future date', () => {
    const view = quotaLedger([row({ closed: false })])
    expect(view.strips[0]?.columns[0]?.endLabel).toBe('now')
  })
})

describe('headline readings', () => {
  it('reports unused capacity in whole windows', () => {
    // Two windows averaging 50% left one window's worth of plan unspent.
    const view = quotaLedger([
      row({ resetsAt: '2026-08-17T07:00:00Z', peakPercent: 40 }),
      row({ resetsAt: '2026-08-24T07:00:00Z', peakPercent: 60 }),
    ])
    expect(view.averagePeak).toBe(50)
    expect(view.unusedWindows).toBeCloseTo(1)
  })

  it('names the best window across every strip', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-17T07:00:00Z', peakPercent: 62 }),
      row({
        accountKey: 'grok::a@b.c',
        agent: 'grok',
        resetsAt: '2026-08-19T12:35:00Z',
        startedAt: '2026-08-12T12:35:00Z',
        peakPercent: 93,
      }),
    ])
    expect(view.bestPeak).toBe(93)
    expect(view.bestLabel).toContain('Grok')
  })

  it('says nothing rather than zero when no window has completed', () => {
    const view = quotaLedger([row({ closed: false })])
    expect(view.averagePeak).toBeUndefined()
    expect(view.bestPeak).toBeUndefined()
    expect(view.unusedWindows).toBeUndefined()
    expect(view.completedCount).toBe(0)
  })

  it('is empty, not broken, with no rows at all', () => {
    const view = quotaLedger([])
    expect(view.strips).toEqual([])
    expect(view.completedCount).toBe(0)
    expect(view.hasBackfill).toBe(false)
  })
})

describe('plan changes', () => {
  it('marks the column where the pool underneath changed size', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-10T07:00:00Z', plan: 'prolite' }),
      row({ resetsAt: '2026-08-17T07:00:00Z', plan: 'prolite' }),
      row({ resetsAt: '2026-08-24T07:00:00Z', plan: 'pro' }),
    ])
    expect(view.strips[0]?.columns.map((c) => c.planBreak)).toEqual([false, false, true])
  })

  it('does not mark a break when the plan was simply never reported', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-17T07:00:00Z' }),
      row({ resetsAt: '2026-08-24T07:00:00Z' }),
    ])
    expect(view.strips[0]?.columns.every((c) => !c.planBreak)).toBe(true)
  })
})

describe('formatLedgerSpan', () => {
  it('drops the repeated month within one', () => {
    expect(formatLedgerSpan('2026-08-17T07:00:00Z', '2026-08-24T07:00:00Z')).toMatch(/Aug 17.*24/)
  })

  it('keeps both months when the window crosses one', () => {
    expect(formatLedgerSpan('2026-08-28T07:00:00Z', '2026-09-04T07:00:00Z')).toMatch(
      /Aug 28.*Sep 4/,
    )
  })

  it('falls back to the reset alone when no start was derivable', () => {
    // `windowMinutes: 0` is a legitimate "the provider did not say".
    expect(formatLedgerSpan(undefined, '2026-08-24T07:00:00Z')).toMatch(/Aug 24/)
  })

  it('returns nothing rather than "Invalid Date" for an unparsable reset', () => {
    expect(formatLedgerSpan(undefined, '')).toBe('')
  })
})

describe('window length', () => {
  it('reads the duration the provider reported', () => {
    expect(windowDurationDays(row({ windowMinutes: 10080 }))).toBe(7)
    expect(windowDurationDays(row({ windowMinutes: 1440 }))).toBe(1)
  })

  it('falls back to the observed span when no duration was reported', () => {
    const derived = windowDurationDays(
      row({
        windowMinutes: 0,
        startedAt: '2026-08-22T07:00:00.000Z',
        resetsAt: '2026-08-24T07:00:00.000Z',
      }),
    )
    expect(derived).toBe(2)
  })

  it('says nothing when neither a duration nor a start is known', () => {
    // `windowMinutes: 0` is a legitimate "the provider did not say". A column
    // that cannot claim a length must not be drawn as a measured short one.
    const r = row({ windowMinutes: 0 })
    delete (r as { startedAt?: string }).startedAt
    expect(windowDurationDays(r)).toBeUndefined()
  })

  it('carries the length onto every column, for the width', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-17T07:00:00Z', windowMinutes: 1440 }),
      row({ resetsAt: '2026-08-24T07:00:00Z', windowMinutes: 10080 }),
    ])
    const days = view.strips[0]?.columns.map((c) => c.durationDays)
    expect(days).toEqual([1, 7])
    // Linear: the seven-day column is drawn seven times the one-day column.
    expect((days?.[1] as number) / (days?.[0] as number)).toBe(7)
  })

  it('uses the observed successor when a nominal week ended after two days', () => {
    const view = quotaLedger([
      // The successor arrives first and advertises an earlier reset. Observation
      // order, not provider reset order or input order, defines the succession.
      row({
        resetsAt: '2026-09-09T07:00:00Z',
        firstSeenAt: '2026-09-02T07:00:00Z',
        windowMinutes: 10080,
        peakPercent: 32,
        closed: false,
      }),
      row({
        resetsAt: '2026-09-10T07:00:00Z',
        firstSeenAt: '2026-08-31T07:00:00Z',
        windowMinutes: 10080,
        peakPercent: 71,
        closed: false,
      }),
    ])
    expect(view.strips[0]?.columns.map((column) => column.peakPercent)).toEqual([71, 32])
    expect(view.strips[0]?.columns.map((column) => column.durationDays)).toEqual([2, 7])
    expect(view.strips[0]?.columns.map((column) => column.closed)).toEqual([true, false])
    expect(view.strips[0]?.columns[0]?.endLabel).toMatch(/Sep 2/)
    expect(view.completedCount).toBe(1)
  })

  it('does not mistake an offline observation gap for a longer-than-plan window', () => {
    const current = row({ firstSeenAt: '2026-08-01T07:00:00Z', windowMinutes: 10080 })
    const successor = row({ firstSeenAt: '2026-08-20T07:00:00Z' })
    expect(windowDurationDays(current, successor)).toBe(7)
  })
})

describe('cadence label', () => {
  it('says Weekly plainly when every window really was a week', () => {
    expect(cadenceLabel([7, 7, 6.9, 7.1])).toBe('Weekly')
  })

  it('softens to a tendency when the windows vary around a week', () => {
    expect(cadenceLabel([7, 5, 8, 7])).toBe('typically weekly')
  })

  it('gives the observed range when the rhythm is not weekly at all', () => {
    expect(cadenceLabel([1, 2, 3])).toBe('1–3 days')
    expect(cadenceLabel([2, 2])).toBe('2 days')
  })

  it('says NOTHING from a single observation', () => {
    // One window cannot establish a rhythm, and a hedge would still be a claim.
    expect(cadenceLabel([7])).toBeUndefined()
    expect(cadenceLabel([])).toBeUndefined()
  })

  it('ignores lengths that were never reported', () => {
    expect(cadenceLabel([7, Number.NaN, 0, 7])).toBe('Weekly')
  })

  it('never repeats the provider label when the data disagrees', () => {
    // Every harness calls its big pool "Weekly". Codex was measured emptying
    // its pool several times in an afternoon; the strip must not echo the word.
    const view = quotaLedger([
      row({ resetsAt: '2026-08-20T07:00:00Z', windowMinutes: 1440, label: 'Weekly' }),
      row({ resetsAt: '2026-08-22T07:00:00Z', windowMinutes: 2880, label: 'Weekly' }),
    ])
    expect(view.strips[0]?.windowLabel).toBe('1–2 days')
  })

  it('derives cadence from observed handoffs when every provider duration says weekly', () => {
    const view = quotaLedger([
      row({ firstSeenAt: '2026-08-20T07:00:00Z', closed: false }),
      row({ firstSeenAt: '2026-08-21T07:00:00Z', closed: false }),
      row({ firstSeenAt: '2026-08-23T07:00:00Z', closed: false }),
    ])
    expect(view.strips[0]?.columns.map((column) => column.durationDays)).toEqual([1, 2, 7])
    expect(view.strips[0]?.windowLabel).toBe('1–2 days')
  })

  it('withholds the cadence until a second window has closed', () => {
    const view = quotaLedger([
      row({ resetsAt: '2026-08-24T07:00:00Z' }),
      row({ resetsAt: '2026-08-31T07:00:00Z', closed: false }),
    ])
    expect(view.strips[0]?.windowLabel).toBeUndefined()
  })
})
