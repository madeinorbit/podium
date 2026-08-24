import { quotaLedger } from '@podium/client-core/viewmodels'
import type { QuotaWindowHistoryWire } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuotaLedger } from './QuotaLedger'

/**
 * What the ledger promises visually: a column is a groove with a ceiling, the
 * empty part of it is the capacity nobody spent, and none of it borrows the live
 * meter's alarm colours.
 */

afterEach(cleanup)

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

const figure = () => document.querySelector('.quota-ledger') as HTMLElement

describe('cold and empty', () => {
  it('draws the region with its readings unfilled while the read is in flight', () => {
    render(<QuotaLedger ledger={null} cold />)
    expect(figure().querySelectorAll('.usage-reading-value .usage-unfilled')).toHaveLength(3)
    expect(figure().querySelectorAll('.quota-groove')).toHaveLength(0)
  })

  it('says a pool has not reset yet rather than showing an empty chart', () => {
    // Quota history has to be COLLECTED — nothing on this path was ever written
    // down before — so an empty ledger is a fact about elapsed time, not a fault.
    render(<QuotaLedger ledger={quotaLedger([])} cold={false} />)
    expect(screen.getByText(/No pool has reset yet/)).toBeTruthy()
    expect(figure().querySelectorAll('.usage-unfilled')).toHaveLength(0)
  })

  it('admits a failing read instead of reading forever', () => {
    // A persistent error leaves `data` null, which is indistinguishable from a
    // slow first read — so the region sat on "Reading the window ledger…" with no
    // error and no way out, unlike the trace beside it.
    const retry = vi.fn()
    render(<QuotaLedger ledger={null} cold feed={{ failed: true, retry }} />)
    expect(screen.getByText(/Couldn't read the window ledger/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('stays in the loading state while a slow read is merely slow', () => {
    render(<QuotaLedger ledger={null} cold feed={{ failed: false, retry: vi.fn() }} />)
    expect(screen.getByText(/Reading the window ledger/)).toBeTruthy()
  })

  it('does not show a pending rule for a number that is known to be nil', () => {
    // `0%` would claim the pools were used and came to nothing; an unfilled rule
    // would claim a number is still coming. Neither is true.
    render(<QuotaLedger ledger={quotaLedger([])} cold={false} />)
    expect(figure().querySelectorAll('.usage-unfilled')).toHaveLength(0)
    expect(screen.getAllByTitle('No window has completed yet').length).toBeGreaterThan(0)
  })
})

describe('columns', () => {
  it('fills each groove to the peak the window reached', () => {
    render(<QuotaLedger ledger={quotaLedger([row({ peakPercent: 71 })])} cold={false} />)
    const fill = figure().querySelector('.quota-groove i') as HTMLElement
    expect(fill.style.getPropertyValue('--u')).toBe('71%')
  })

  it('keeps a barely-touched window visible instead of reading as no data', () => {
    render(<QuotaLedger ledger={quotaLedger([row({ peakPercent: 0 })])} cold={false} />)
    const fill = figure().querySelector('.quota-groove i') as HTMLElement
    expect(fill.style.getPropertyValue('--u')).toBe('1.5%')
  })

  it('marks the running window and leaves completed ones unmarked', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ resetsAt: '2026-08-17T07:00:00Z' }),
          row({ resetsAt: '2026-08-24T07:00:00Z', closed: false }),
        ])}
        cold={false}
      />,
    )
    expect(figure().querySelectorAll('.quota-groove[data-now]')).toHaveLength(1)
  })

  it('hatches a window whose start was never observed', () => {
    render(<QuotaLedger ledger={quotaLedger([row({ partial: true })])} cold={false} />)
    expect(figure().querySelectorAll('.quota-groove[data-partial]')).toHaveLength(1)
  })

  it('gives every column a readable summary without a tooltip component', () => {
    render(<QuotaLedger ledger={quotaLedger([row({ peakPercent: 71 })])} cold={false} />)
    const groove = figure().querySelector('.quota-groove') as HTMLElement
    expect(groove.title).toMatch(/71% of plan spent/)
  })
})

describe('identity without colour', () => {
  it('separates harnesses into strips carrying their own mark', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row(),
          row({ accountKey: 'grok::a@b.c', agent: 'grok', peakPercent: 41 }),
        ])}
        cold={false}
      />,
    )
    expect(figure().querySelectorAll('.quota-pool')).toHaveLength(2)
    expect(screen.getByText('CX')).toBeTruthy()
    expect(screen.getByText('GR')).toBeTruthy()
  })

  it('never reuses the live meter tone classes', () => {
    // In the live meter, near-full means "about to be cut off". Here a window
    // that ended at 95% is the best outcome there is — the mapping inverts, so
    // borrowing that ramp would state the opposite of the truth.
    render(<QuotaLedger ledger={quotaLedger([row({ peakPercent: 97 })])} cold={false} />)
    const html = figure().innerHTML
    expect(html).not.toContain('bg-destructive')
    expect(html).not.toContain('bg-warning')
    expect(html).not.toContain('data-tone')
  })
})
