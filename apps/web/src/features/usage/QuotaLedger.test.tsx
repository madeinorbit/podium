import { quotaLedger } from '@podium/client-core/viewmodels'
import type { QuotaWindowHistoryWire } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QuotaLedger } from './QuotaLedger'

/**
 * Open a column's hover card and hand back everything it says.
 *
 * The details moved off a `title` attribute onto a real tooltip, so reading them
 * means driving the pointer rather than reading a string off the node. Rendering
 * inside a provider with no delay is what makes the open synchronous enough to
 * await.
 */
async function hoverCard(el: Element): Promise<string> {
  await act(async () => {
    fireEvent.pointerOver(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el)
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  return document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? ''
}

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
    expect(screen.getAllByText('–').length).toBeGreaterThan(0)
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

  it('gives every column a hover card rather than a browser title string', async () => {
    // Six facts joined by middots in a `title` arrived as one unpunctuated line
    // in the OS font. The card gives each of them a place instead.
    render(
      <TooltipProvider delay={0}>
        <QuotaLedger ledger={quotaLedger([row({ peakPercent: 71 })])} cold={false} />
      </TooltipProvider>,
    )
    const groove = figure().querySelector('.quota-groove') as HTMLElement
    expect(groove.title).toBe('')
    const card = await hoverCard(groove)
    expect(card).toMatch(/71%/)
    expect(card).toMatch(/of the plan spent/)
    // The negative space is the whole message of this chart, so the card says it.
    expect(card).toMatch(/29% went unused/)
  })

  it('says what a missed start means, not just that it happened', async () => {
    render(
      <TooltipProvider delay={0}>
        <QuotaLedger ledger={quotaLedger([row({ partial: true })])} cold={false} />
      </TooltipProvider>,
    )
    const card = await hoverCard(figure().querySelector('.quota-groove') as HTMLElement)
    expect(card).toMatch(/may understate what was really spent/)
  })

  it('hatches a running window whose start was never observed', () => {
    // Both states set the fill, and the running one used to win outright: the
    // column was painted solid while its own card said the start was missed.
    render(
      <QuotaLedger ledger={quotaLedger([row({ partial: true, closed: false })])} cold={false} />,
    )
    expect(figure().querySelectorAll('.quota-groove[data-partial][data-now]')).toHaveLength(1)
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

describe('width shows length', () => {
  const widths = () =>
    [...figure().querySelectorAll('.quota-groove')].map((el) =>
      (el as HTMLElement).style.getPropertyValue('--days'),
    )

  it('draws a seven-day window seven times a one-day one', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ resetsAt: '2026-08-17T07:00:00Z', windowMinutes: 1440 }),
          row({ resetsAt: '2026-08-24T07:00:00Z', windowMinutes: 10080 }),
        ])}
        cold={false}
      />,
    )
    expect(widths()).toEqual(['1', '7'])
  })

  it('draws a nominal week at the shorter time it actually remained active', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({
            resetsAt: '2026-09-07T07:00:00Z',
            firstSeenAt: '2026-08-31T07:00:00Z',
            closed: false,
          }),
          row({
            resetsAt: '2026-09-09T07:00:00Z',
            firstSeenAt: '2026-09-02T07:00:00Z',
            closed: false,
          }),
        ])}
        cold={false}
      />,
    )
    expect(widths()).toEqual(['2', '7'])
    expect(figure().querySelectorAll('.quota-groove[data-now]')).toHaveLength(1)
    expect(screen.getByText('1 window · avg 71%')).toBeTruthy()
    expect(screen.queryByText('no completed window yet')).toBeNull()
  })

  it('caps an offline observation gap at the provider duration', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ firstSeenAt: '2026-08-01T07:00:00Z', closed: false }),
          row({ firstSeenAt: '2026-08-20T07:00:00Z', closed: false }),
        ])}
        cold={false}
      />,
    )
    expect(widths()).toEqual(['7', '7'])
  })

  it('keeps the day labels on the same scale as their columns', () => {
    // Mismatched bases and the dates stop sitting under the columns they name.
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ resetsAt: '2026-08-17T07:00:00Z', windowMinutes: 1440 }),
          row({ resetsAt: '2026-08-24T07:00:00Z', windowMinutes: 10080 }),
        ])}
        cold={false}
      />,
    )
    const labels = [...figure().querySelectorAll('.quota-strip-days span')].map((el) =>
      (el as HTMLElement).style.getPropertyValue('--days'),
    )
    expect(labels).toEqual(widths())
  })

  it('marks a window whose length was never reported instead of faking a short one', () => {
    const r = row({ windowMinutes: 0 })
    delete (r as { startedAt?: string }).startedAt
    render(<QuotaLedger ledger={quotaLedger([r])} cold={false} />)
    expect(figure().querySelectorAll('.quota-groove[data-unknown-length]')).toHaveLength(1)
    // Drawn at the nominal week — a placeholder, not a measurement.
    expect(widths()).toEqual(['7'])
  })

  it('names the length on the card', async () => {
    render(
      <TooltipProvider delay={0}>
        <QuotaLedger ledger={quotaLedger([row({ windowMinutes: 2880 })])} cold={false} />
      </TooltipProvider>,
    )
    const card = await hoverCard(figure().querySelector('.quota-groove') as HTMLElement)
    expect(card).toMatch(/Ran for2 days/)
  })

  it('gives a sub-day window its length in hours instead of rounding it to zero', async () => {
    render(
      <TooltipProvider delay={0}>
        <QuotaLedger
          ledger={quotaLedger([
            row({ firstSeenAt: '2026-08-17T07:05:00Z', resetsAt: '2026-08-17T20:00:00Z' }),
            row({ firstSeenAt: '2026-08-18T00:05:00Z', resetsAt: '2026-08-24T07:00:00Z' }),
          ])}
          cold={false}
        />
      </TooltipProvider>,
    )
    const card = await hoverCard(figure().querySelector('.quota-groove') as HTMLElement)
    expect(card).toMatch(/Ran for17 h/)
  })
})

describe('cadence heading', () => {
  it('shows the rhythm the windows actually had', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ resetsAt: '2026-08-20T07:00:00Z', windowMinutes: 1440 }),
          row({ resetsAt: '2026-08-22T07:00:00Z', windowMinutes: 2880 }),
        ])}
        cold={false}
      />,
    )
    expect(screen.getByText('every 1–2 days')).toBeTruthy()
    expect(screen.queryByText('Weekly')).toBeNull()
  })

  it('omits the heading entirely when one window is all it has seen', () => {
    render(
      <QuotaLedger
        ledger={quotaLedger([
          row({ resetsAt: '2026-08-24T07:00:00Z' }),
          row({ resetsAt: '2026-08-31T07:00:00Z', closed: false }),
        ])}
        cold={false}
      />,
    )
    expect(figure().querySelectorAll('.quota-pool-window')).toHaveLength(0)
  })
})
