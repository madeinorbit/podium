// @vitest-environment happy-dom
//
// POD-679 — the departure ticks under the spine.
//
// Work discovered in a mission and started as its own thing is not a member any
// more (`missionDepartures` decides that; this is only the rendering). What the
// column owes the operator is that it did not silently vanish: one line, the
// ref they can act on, and a way back to it.
import type { MissionDeparture } from '@podium/client-core/viewmodels'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { DepartureTicks } from './FlightDeck'

afterEach(cleanup)

const departure = (over: Partial<MissionDeparture> = {}): MissionDeparture =>
  ({
    issue: makeIssue({ id: 'spin', seq: 44, title: 'Session hover cards leak on unmount' }),
    originId: 'c1',
    state: { state: 'working', label: 'Running', attention: false },
    ...over,
  }) as MissionDeparture

describe('DepartureTicks', () => {
  it('renders nothing when the mission has lost nothing', () => {
    const { container } = render(<DepartureTicks departures={[]} onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('says what left, and what it is doing now', () => {
    render(<DepartureTicks departures={[departure()]} onOpen={vi.fn()} />)

    expect(screen.getByText('Left this mission')).toBeTruthy()
    const tick = screen.getByTestId('flight-departure')
    expect(tick.textContent).toContain('#44')
    expect(tick.textContent).toContain('Session hover cards leak on unmount')
    // The spine's own state word, lowered — a tick is not a task strip.
    expect(tick.textContent).toContain('running')
  })

  it('is a way BACK to the work, not a dead label', () => {
    const onOpen = vi.fn()
    render(<DepartureTicks departures={[departure()]} onOpen={onOpen} />)

    fireEvent.click(screen.getByTestId('flight-departure'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'spin' }))
  })

  it('carries the attention colour when the departed work is asking', () => {
    render(
      <DepartureTicks
        departures={[
          departure({ state: { state: 'idle', label: 'Standing by', attention: true } }),
        ]}
        onOpen={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('flight-departure').querySelector('.bg-attention'),
    ).not.toBeNull()
  })
})
