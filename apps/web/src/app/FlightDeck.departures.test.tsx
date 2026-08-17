// @vitest-environment happy-dom
//
// POD-679 — what left the mission, and POD-1146 — where the work went.
//
// Work discovered in a mission and started as its own thing is not a member any
// more (`missionDepartures` decides that; this is only the rendering). What the
// column owes the operator is that it did not silently vanish: one line, the
// ref they can act on, and a way back to it.
//
// The region has TWO shapes and only one of them at a time — quiet ticks while
// the mission is still being worked, one promoted destination once the root
// itself has been vacated — and it must never draw the same destination twice.
import type { IssueContinuation, MissionDeparture } from '@podium/client-core/viewmodels'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { WhereTheWorkWent } from './FlightDeck'

afterEach(cleanup)

const departure = (over: Partial<MissionDeparture> = {}): MissionDeparture =>
  ({
    issue: makeIssue({ id: 'spin', seq: 44, title: 'Session hover cards leak on unmount' }),
    originId: 'c1',
    state: { state: 'working', label: 'Running', attention: false },
    ...over,
  }) as MissionDeparture

const region = (props: Partial<Parameters<typeof WhereTheWorkWent>[0]> = {}) =>
  render(
    <WhereTheWorkWent
      continuation={null}
      departures={[]}
      onOpen={vi.fn()}
      onTuck={vi.fn()}
      {...props}
    />,
  )

describe('WhereTheWorkWent', () => {
  it('renders nothing when the mission has lost nothing', () => {
    const { container } = region()
    expect(container.firstChild).toBeNull()
  })

  it('says what left, and what it is doing now', () => {
    region({ departures: [departure()] })

    // The heading answers the operator's question rather than naming the event.
    expect(screen.getByText('Where the work went')).toBeTruthy()
    const tick = screen.getByTestId('flight-departure')
    expect(tick.textContent).toContain('#44')
    expect(tick.textContent).toContain('Session hover cards leak on unmount')
    // The spine's own state word, lowered — a tick is not a task strip.
    expect(tick.textContent).toContain('running')
  })

  it('is a way BACK to the work, not a dead label', () => {
    const onOpen = vi.fn()
    region({ departures: [departure()], onOpen })

    fireEvent.click(screen.getByTestId('flight-departure'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'spin' }))
  })

  it('carries the attention colour when the departed work is asking', () => {
    region({
      departures: [departure({ state: { state: 'idle', label: 'Standing by', attention: true } })],
    })
    expect(screen.getByTestId('flight-departure').querySelector('.bg-attention')).not.toBeNull()
  })

  /**
   * The duplication POD-1146 removes: a continuation target is by construction a
   * started spin-off, so it also qualifies as a departure. The card and the tick
   * were the same fact in two voices twelve pixels apart.
   */
  it('promotes the continuation and does not also tick it', () => {
    const target = makeIssue({ id: 'spin', seq: 1016, title: 'Rebuild after main sync' })
    const continuation: IssueContinuation = {
      kind: 'spinoff',
      target,
      short: '#1016',
      full: 'Work continued in #1016',
      line: 'continued · #1016',
    }
    const onOpen = vi.fn()
    const onTuck = vi.fn()
    region({ continuation, continuationState: departure().state, departures: [], onOpen, onTuck })

    const card = screen.getByTestId('flight-continuation')
    expect(card.textContent).toContain('Work continued in #1016')
    // The tick's own state word came with it, so folding the two lost nothing.
    expect(card.textContent).toContain('running')
    // …and the tick itself is gone.
    expect(screen.queryByTestId('flight-departure')).toBeNull()
    // One region, one count.
    expect(screen.getByTestId('flight-departures').textContent).toContain('1')

    fireEvent.click(screen.getByRole('button', { name: 'Open #1016' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'spin' }))
    fireEvent.click(screen.getByRole('button', { name: /Tuck away/ }))
    expect(onTuck).toHaveBeenCalled()
  })
})
