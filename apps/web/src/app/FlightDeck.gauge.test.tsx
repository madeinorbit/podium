// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MissionGauge } from './FlightDeck'

afterEach(cleanup)

describe('Flight Deck mission gauge', () => {
  it('animates running issue progress and keeps live presence outside the track', () => {
    const progress = { total: 5, done: 2, run: 2, block: 1, wait: 0 }
    const view = render(<MissionGauge progress={progress} live={4} working={0} />)
    const gauge = screen.getByTestId('mission-gauge')
    const track = screen.getByTestId('mission-gauge-track')
    const live = screen.getByTestId('mission-live-chip')

    expect(gauge.getAttribute('data-running')).toBe('true')
    expect(track.querySelector('.row-progress-sweep')).not.toBeNull()
    expect(track.parentElement).toBe(gauge)
    expect(live.parentElement).toBe(gauge)
    expect(track.contains(live)).toBe(false)
    expect(live.textContent).toContain('4 live')

    view.rerender(
      <MissionGauge
        progress={{ total: 5, done: 4, run: 0, block: 1, wait: 0 }}
        live={4}
        working={2}
      />,
    )
    expect(gauge.getAttribute('data-running')).toBe('false')
    expect(track.querySelector('.row-progress-sweep')).toBeNull()
  })
})
