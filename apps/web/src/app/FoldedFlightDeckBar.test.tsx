// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'

vi.mock('./store', () => ({
  useStoreSelector: (select: (store: Record<string, unknown>) => unknown) =>
    select({ sessions: [], selectedIssueId: 'root' }),
  useReplicaIssues: () => [],
}))

vi.mock('@podium/client-core/viewmodels', () => ({
  missionRootFor: () => ({ id: 'root' }),
  buildFlightDeckRows: () => [{ liveAgentCount: 3, workingAgentCount: 1, actionableCount: 2 }],
}))

afterEach(cleanup)

describe('folded Flight Deck', () => {
  it('gives fleet activity and attention their own expand controls', () => {
    const onExpand = vi.fn()
    render(<FoldedFlightDeckBar onExpand={onExpand} />)

    const activity = screen.getByTestId('flight-deck-activity')
    const attention = screen.getByTestId('flight-deck-attention')
    expect(activity).not.toBe(attention)
    expect(activity.getAttribute('aria-label')).toContain('3 live, 1 working')
    expect(attention.getAttribute('aria-label')).toContain('2 need you')
    expect(activity.querySelector('[aria-label="3 agents live"]')).not.toBeNull()
    expect(attention.querySelector('[aria-label="2 waiting on you"]')).not.toBeNull()

    fireEvent.click(activity)
    fireEvent.click(attention)
    expect(onExpand).toHaveBeenCalledTimes(2)
  })
})
