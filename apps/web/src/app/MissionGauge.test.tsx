// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MissionGauge } from './MissionGauge'

afterEach(cleanup)

const extent = (): HTMLElement => screen.getByTestId('mission-gauge-extent')
const datum = (): HTMLElement => screen.getByTestId('mission-gauge-datum')
const reading = (): string => screen.getByTestId('mission-gauge-reading').textContent ?? ''

describe('Flight Deck mission gauge', () => {
  it('sweeps while an agent computes, not merely while a task sits in progress', () => {
    // The old gauge animated on `run > 0`, so a mission parked in `in_progress`
    // overnight swept all night — motion outliving the computing it depicts
    // (DESIGN.md §5). The gate is now the one `RowProgressMeter` uses.
    const view = render(
      <MissionGauge
        progress={{ total: 5, done: 2, run: 2, block: 1, wait: 0 }}
        live={4}
        working={0}
      />,
    )
    const gauge = screen.getByTestId('mission-gauge')
    const track = screen.getByTestId('mission-gauge-track')
    const live = screen.getByTestId('mission-live-chip')

    expect(gauge.getAttribute('data-running')).toBe('true')
    expect(gauge.getAttribute('data-working')).toBe('false')
    expect(track.querySelector('.row-progress-sweep')).toBeNull()

    // Presence is not a slice of the work.
    expect(track.parentElement).toBe(gauge)
    expect(live.parentElement).toBe(gauge)
    expect(track.contains(live)).toBe(false)
    expect(live.textContent).toContain('4 live')

    view.rerender(
      <MissionGauge
        progress={{ total: 5, done: 2, run: 2, block: 1, wait: 0 }}
        live={4}
        working={2}
      />,
    )
    expect(gauge.getAttribute('data-working')).toBe('true')
    const sweep = track.querySelector('.row-progress-sweep')
    expect(sweep).not.toBeNull()
    // …and it belongs to the extent — the part of the mission the computing is
    // happening inside — not to the well at large.
    expect(sweep?.parentElement).toBe(extent())

    // Nothing is running any more: still working agents, but no running work to
    // sweep, so the gauge is completely still.
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

  it('draws one extent at the done+running fraction, with the figures inside it', () => {
    const view = render(
      <MissionGauge
        progress={{ total: 1, done: 0, run: 1, block: 0, wait: 0 }}
        live={1}
        working={1}
      />,
    )
    // One task in hand fills the well, and the reading says so once, in words,
    // inside it. The datum rule is the same width as the tint it floors.
    expect(extent().style.width).toBe('100%')
    expect(datum().style.width).toBe('100%')
    expect(reading()).toBe('0 done · 1 running')
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '0 of 1 task done, 1 running · 1 agent live, 1 working',
    )

    view.rerender(
      <MissionGauge
        progress={{ total: 8, done: 3, run: 2, block: 1, wait: 2 }}
        live={5}
        working={5}
      />,
    )
    // Work in hand is done + running; blocked and to-go are the well the extent
    // has not reached, said in words and given no colour of their own.
    expect(extent().style.width).toBe('62.5%')
    expect(datum().style.width).toBe('62.5%')
    expect(reading()).toBe('3 done · 2 running · 1 blocked · 2 to go')
    expect(screen.getByTestId('mission-gauge').getAttribute('title')).toBe(
      '3 of 8 tasks done, 2 running, 1 blocked, 2 to go · 5 agents live, 5 working',
    )

    // A mission with nothing to measure leaves the well empty rather than
    // dividing by zero.
    view.rerender(
      <MissionGauge
        progress={{ total: 0, done: 0, run: 0, block: 0, wait: 0 }}
        live={0}
        working={0}
      />,
    )
    expect(extent().style.width).toBe('0%')
    expect(reading()).toBe('0 done')
  })
})
