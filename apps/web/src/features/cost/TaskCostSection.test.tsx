import type { CostAmount, TaskCostView } from '@podium/client-core/viewmodels'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { costSectionMeta, TaskCostSection } from './TaskCostSection'

/**
 * What this section promises, in the order the design argues for it.
 *
 * The load-bearing assertions are the NEGATIVE ones: no state collapses to a
 * zero figure, `pending` draws no motion, and a childless task draws no split.
 * Each of those is a specific way this feature was able to lie, and each is one
 * edit away from coming back.
 */

const amount = (over: Partial<CostAmount> = {}): CostAmount => ({
  estCostUsd: 0,
  totalTokens: 0,
  messages: 0,
  sessionCount: 0,
  models: [],
  ...over,
})

const view = (over: Partial<TaskCostView> = {}): TaskCostView => ({
  state: 'costed',
  own: amount(),
  rollup: amount(),
  descendantCount: 0,
  provisional: false,
  floor: 'none',
  harnesses: ['claude-code'],
  sessions: [],
  ratePerReplyUsd: null,
  rateVsMedian: null,
  ...over,
})

/** POD-1574: own = rollup = 225.81, no children, two models. */
const pod1574 = (over: Partial<TaskCostView> = {}): TaskCostView => {
  const models = [
    {
      model: 'claude-opus-5',
      provider: 'anthropic' as const,
      estCostUsd: 171.51,
      totalTokens: 9,
      messages: 6,
    },
    {
      model: 'claude-fable-5',
      provider: 'anthropic' as const,
      estCostUsd: 54.29,
      totalTokens: 4,
      messages: 3,
    },
  ]
  const totals = amount({ estCostUsd: 225.8, messages: 9, sessionCount: 10, models })
  return view({ own: totals, rollup: totals, ...over })
}

afterEach(cleanup)

describe('TaskCostSection · the states that are words', () => {
  it('says "No sessions" and never a zero figure', () => {
    render(<TaskCostSection view={view({ state: 'no-sessions' })} />)

    expect(screen.getByTestId('cost-word').textContent).toBe('No sessions')
    // The sharpest way this feature can lie. POD-1608 changed 126 files and
    // truthfully cost this task nothing, because the agent was bound elsewhere.
    expect(screen.queryByText(/\$0/)).toBeNull()
    expect(screen.queryByTestId('cost-figure')).toBeNull()
  })

  it('says "Not recorded", which is a different fact from zero', () => {
    render(<TaskCostSection view={view({ state: 'not-recorded' })} />)

    expect(screen.getByTestId('cost-word').textContent).toBe('Not recorded')
    expect(screen.queryByText(/\$0/)).toBeNull()
  })

  it('draws pending as an unfilled slot, with no motion and no figure', () => {
    // Half the tasks on this machine are pending right now, and the backfill
    // that fixes it is not promoted. A spinner here would spin for the life of
    // the surface and promise an arrival that is not coming.
    const { container } = render(<TaskCostSection view={view({ state: 'pending' })} />)

    expect(container.querySelector('.usage-unfilled')).not.toBeNull()
    expect(container.querySelector('[data-testid="working-mark"]')).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('draws a cold first paint exactly as it draws pending', () => {
    // From the reader's side "not harvested" and "not fetched" are one fact:
    // there is no figure. Two treatments would be a distinction invented to
    // look busy.
    const { container } = render(<TaskCostSection view={null} />)

    expect(container.querySelector('.usage-unfilled')).not.toBeNull()
    expect(screen.getByTestId('cost-section').dataset.state).toBe('cold')
  })
})

describe('TaskCostSection · the costed reading', () => {
  it('leads with the rounded rollup and the hedge, verbatim', () => {
    render(<TaskCostSection view={pod1574()} />)

    expect(screen.getByTestId('cost-figure').textContent).toBe('≈$226')
    expect(screen.getByTestId('cost-hedge').textContent).toBe(
      'at list price for the same tokens — not what you were billed',
    )
  })

  it('draws no split bar for a task with no children', () => {
    // A two-segment bar with one empty segment is a question the reader has to
    // answer before they can read the number.
    render(<TaskCostSection view={pod1574()} />)

    expect(screen.queryByTestId('cost-split')).toBeNull()
  })

  it('splits own against descendants, both labelled with their figure', () => {
    // POD-1402: the epic lead outspent all 32 children put together.
    render(
      <TaskCostSection
        view={view({
          own: amount({ estCostUsd: 142.09, sessionCount: 6 }),
          rollup: amount({ estCostUsd: 262.88, sessionCount: 38 }),
          descendantCount: 32,
        })}
      />,
    )

    const split = screen.getByTestId('cost-split')
    expect(split.textContent).toContain('This task $142.09')
    expect(split.textContent).toContain('32 sub-tasks $120.79')
  })

  it('shows a $0 own share rather than rendering the parent free', () => {
    // POD-1484 has no sessions of its own; its whole figure is its 33
    // descendants'. Showing own cost as the headline would render it free.
    render(
      <TaskCostSection
        view={view({
          own: amount({ estCostUsd: 0 }),
          rollup: amount({ estCostUsd: 92.64, sessionCount: 40 }),
          descendantCount: 33,
        })}
      />,
    )

    expect(screen.getByTestId('cost-figure').textContent).toBe('≈$93')
    expect(screen.getByTestId('cost-split').textContent).toContain('This task $0')
  })

  it('prices each model exactly, since those rows are checked against the whole', () => {
    render(<TaskCostSection view={pod1574()} />)

    const rows = screen.getAllByTestId('cost-row').map((r) => r.textContent)
    expect(rows).toContain('claude-opus-5$171.51')
    expect(rows).toContain('claude-fable-5$54.29')
  })

  it('reads the rate off the viewmodel and never computes one', () => {
    render(<TaskCostSection view={pod1574({ rateVsMedian: 2.34 })} />)

    expect(screen.getAllByTestId('cost-row').map((r) => r.textContent)).toContain('Rate2.3× median')
  })

  it('drops the rate row entirely rather than showing a multiple with no cohort', () => {
    render(<TaskCostSection view={pod1574({ rateVsMedian: null })} />)

    expect(screen.queryByText(/median/)).toBeNull()
  })

  it('marks the figure as a floor, and names the harnesses that made it one', () => {
    render(<TaskCostSection view={pod1574({ floor: 'partial', harnesses: ['codex', 'grok'] })} />)

    expect(screen.getAllByTestId('cost-row').map((r) => r.textContent)).toContain(
      'Attribution≥ floor · Codex + Grok',
    )
  })

  it('draws no attribution row for a task that is fully counted', () => {
    render(<TaskCostSection view={pod1574()} />)

    expect(screen.queryByText(/floor/)).toBeNull()
  })
})

describe('TaskCostSection · the disclosure', () => {
  const sessions = [
    {
      sessionId: 'a',
      title: 'M2: Gallery grid',
      harness: 'claude-code' as const,
      running: false,
      estCostUsd: 58.2,
      totalTokens: 1,
      messages: 1,
      firstTsMs: 0,
      lastTsMs: 1,
    },
    {
      sessionId: 'b',
      title: 'Epic lead',
      harness: 'claude-code' as const,
      running: true,
      estCostUsd: 50.1,
      totalTokens: 1,
      messages: 1,
      firstTsMs: 0,
      lastTsMs: 1,
    },
    {
      sessionId: null,
      title: null,
      harness: 'codex' as const,
      running: false,
      estCostUsd: 4.4,
      totalTokens: 1,
      messages: 1,
      firstTsMs: 0,
      lastTsMs: 1,
    },
  ]

  it('is the only place that lists every session that ever ran', () => {
    render(<TaskCostSection view={pod1574({ sessions })} />)

    expect(screen.queryByTestId('cost-session-row')).toBeNull()
    fireEvent.click(screen.getByTestId('cost-disclosure'))

    const rows = screen.getAllByTestId('cost-session-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('M2: Gallery grid')
    expect(rows[0]?.textContent).toContain('≈$58')
  })

  it('keeps a live session in the list, with its mark AND its figure', () => {
    // Inside a section headed Cost, sorted by cost, a figure is what the row is
    // for. The section's "so far" carries the tense for all of them at once.
    render(<TaskCostSection view={pod1574({ sessions })} />)
    fireEvent.click(screen.getByTestId('cost-disclosure'))

    const live = screen.getAllByTestId('cost-session-row')[1]
    expect(live?.textContent).toContain('≈$50')
    expect(live?.querySelector('[data-testid="working-mark"]')).not.toBeNull()
  })

  it('says a transcript with no surviving session is unnamed rather than inventing one', () => {
    render(<TaskCostSection view={pod1574({ sessions })} />)
    fireEvent.click(screen.getByTestId('cost-disclosure'))

    expect(screen.getAllByTestId('cost-session-row')[2]?.textContent).toContain('Unnamed session')
  })

  it('counts what it lists, not what the headline rolled up', () => {
    // The wire carries OWN sessions only. Under a rolled-up headline, a bare
    // "3 sessions" invites the reader to add the list up and find it short.
    render(
      <TaskCostSection
        view={pod1574({
          sessions,
          descendantCount: 32,
          rollup: amount({ estCostUsd: 262.88, sessionCount: 38 }),
        })}
      />,
    )

    expect(screen.getByTestId('cost-disclosure').textContent).toContain(
      '3 own sessions, most expensive first',
    )
  })

  it('drops "own" when there are no children to distinguish it from', () => {
    render(<TaskCostSection view={pod1574({ sessions })} />)

    expect(screen.getByTestId('cost-disclosure').textContent).toContain(
      '3 sessions, most expensive first',
    )
  })
})

describe('costSectionMeta', () => {
  it('carries the tense for every row at once while anything is running', () => {
    expect(costSectionMeta(view({ provisional: true }))).toBe('so far')
  })

  it('says nothing about a finished task, whose figure will not move', () => {
    expect(costSectionMeta(view({ provisional: false }))).toBeUndefined()
    expect(costSectionMeta(null)).toBeUndefined()
  })
})
