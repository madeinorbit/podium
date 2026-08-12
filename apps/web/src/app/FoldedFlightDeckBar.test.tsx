// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'

const state = {
  rows: [{ liveAgentCount: 3, workingAgentCount: 1, actionableCount: 2 }],
  progress: { total: 5, done: 1, run: 2, block: 0, wait: 2 },
}

vi.mock('./store', () => ({
  useStoreSelector: (select: (store: Record<string, unknown>) => unknown) =>
    select({ sessions: [], selectedIssueId: 'root' }),
  useReplicaIssues: () => [],
}))

vi.mock('@podium/client-core/viewmodels', () => ({
  missionRootFor: () => ({ id: 'root', seq: 710, linearIdentifier: 'POD-710', title: 'Mission' }),
  buildFlightDeckRows: () => state.rows,
  missionProgress: () => state.progress,
  missionCrewLabel: (live: number, working: number) =>
    working > 0 ? `${working} working` : `${live} agent${live === 1 ? '' : 's'}`,
}))

afterEach(() => {
  state.rows = [{ liveAgentCount: 3, workingAgentCount: 1, actionableCount: 2 }]
  state.progress = { total: 5, done: 1, run: 2, block: 0, wait: 2 }
  cleanup()
})

const ticks = (): string[] =>
  screen.getAllByTestId('deck-tick').map((tick) => tick.getAttribute('data-s') ?? '')

describe('folded Flight Deck', () => {
  it('reports the mission on the closed rail: identity, gauge, foot', () => {
    const onExpand = vi.fn()
    render(<FoldedFlightDeckBar onExpand={onExpand} />)

    // The mission's own ID square, not a column label.
    expect(screen.getByTestId('issue-id-square').getAttribute('data-number')).toBe('710')

    // One tick per task, in the open gauge's state order, and the exact datum.
    const gauge = screen.getByTestId('flight-deck-gauge')
    expect(gauge.getAttribute('data-resolution')).toBe('task')
    expect(ticks()).toEqual(['done', 'run', 'run', 'wait', 'wait'])
    expect(gauge.textContent).toContain('1/5')
    expect(gauge.getAttribute('aria-label')).toContain('1 of 5 tasks done, 2 running, 2 to go')

    const activity = screen.getByTestId('flight-deck-activity')
    const attention = screen.getByTestId('flight-deck-attention')
    expect(activity.getAttribute('aria-label')).toContain('1 working')
    expect(attention.getAttribute('aria-label')).toContain('2 need you')
    expect(activity.textContent).toContain('1')
    expect(attention.textContent).toContain('2')

    fireEvent.click(activity)
    fireEvent.click(attention)
    fireEvent.click(gauge)
    expect(onExpand).toHaveBeenCalledTimes(3)
  })

  it('draws no attention stack when nothing is asking', () => {
    state.rows = [{ liveAgentCount: 1, workingAgentCount: 0, actionableCount: 0 }]
    render(<FoldedFlightDeckBar onExpand={vi.fn()} />)

    expect(screen.queryByTestId('flight-deck-attention')).toBeNull()
    expect(screen.getByTestId('flight-deck-activity')).not.toBeNull()
  })

  it('keeps the reading when a mission outgrows one tick per task', () => {
    state.progress = { total: 60, done: 30, run: 10, block: 0, wait: 20 }
    render(<FoldedFlightDeckBar onExpand={vi.fn()} />)

    const gauge = screen.getByTestId('flight-deck-gauge')
    expect(gauge.getAttribute('data-resolution')).toBe('share')
    // Four states at most, sized by share — never 60 ticks, never a clipped one.
    expect(ticks()).toEqual(['done', 'run', 'wait'])
    expect(gauge.textContent).toContain('30/60')
  })
})
