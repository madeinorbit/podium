import type { QuotaWindowHistoryWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { formatLedgerSpan, isLedgerWindow, quotaLedger } from './quota-history'

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
