// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MissionGauge } from './MissionGauge'

afterEach(cleanup)

const bands = (): HTMLElement[] => screen.queryAllByTestId('mission-gauge-band')
// The band's label joins its count to its noun with a non-breaking space, so the
// noun sheds as one piece; read it back as ordinary text.
const label = (band: HTMLElement | undefined): string =>
  (band?.textContent ?? '').replace(/\u00a0/g, ' ')

describe('Flight Deck mission gauge', () => {
  it('marches while an agent computes, not merely while a task sits in progress', () => {
    // The old gauge animated on `run > 0`, so a mission parked in `in_progress`
    // overnight animated all night — motion outliving the computing it depicts
    // (DESIGN.md §5). The gate is now the one `RowProgressMeter` uses.
    const view = render(
      <MissionGauge
        progress={{ total: 5, done: 2, run: 2, review: 0, stall: 0, block: 1, wait: 0 }}
        live={4}
        working={0}
      />,
    )
    const gauge = screen.getByTestId('mission-gauge')
    const track = screen.getByTestId('mission-gauge-track')
    const live = screen.getByTestId('mission-live-chip')

    expect(gauge.getAttribute('data-running')).toBe('true')
    expect(gauge.getAttribute('data-working')).toBe('false')
    expect(track.querySelector('.gauge-band-march')).toBeNull()

    // Presence is not a slice of the work.
    expect(track.parentElement).toBe(gauge)
    expect(live.parentElement).toBe(gauge)
    expect(track.contains(live)).toBe(false)
    expect(live.textContent).toContain('4 agents')

    view.rerender(
      <MissionGauge
        progress={{ total: 5, done: 2, run: 2, review: 0, stall: 0, block: 1, wait: 0 }}
        live={4}
        working={2}
      />,
    )
    expect(gauge.getAttribute('data-working')).toBe('true')
    const march = track.querySelector('.gauge-band-march')
    expect(march).not.toBeNull()
    // …and it belongs to the running band, not to the track at large.
    expect(march?.closest('[data-testid="mission-gauge-band"]')?.getAttribute('data-s')).toBe('run')

    // Nothing is running any more: still working agents, but no running band to
    // sweep, so the gauge is completely still.
    view.rerender(
      <MissionGauge
        progress={{ total: 5, done: 4, run: 0, review: 0, stall: 0, block: 1, wait: 0 }}
        live={4}
        working={2}
      />,
    )
    expect(gauge.getAttribute('data-running')).toBe('false')
    expect(track.querySelector('.gauge-band-march')).toBeNull()
  })

  it('gives a band to every state that has work and to no state that has none', () => {
    const view = render(
      <MissionGauge
        progress={{ total: 1, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 0 }}
        live={1}
        working={1}
      />,
    )
    // The complaint, answered: one task is one band saying one thing.
    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual(['run'])
    expect(label(bands()[0])).toBe('1 underway')
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '0 of 1 task done, 1 underway · 1 working',
    )

    view.rerender(
      <MissionGauge
        progress={{ total: 8, done: 3, run: 2, review: 0, stall: 0, block: 1, wait: 2 }}
        live={5}
        working={5}
      />,
    )
    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual([
      'done',
      'run',
      'block',
      'wait',
    ])
    // Sized by the work they hold — the count is the band's own weight.
    expect(bands().map((band) => band.style.flexGrow)).toEqual(['3', '2', '1', '2'])
    // Blocked is hueless: the deck's own "stopped" texture, never the signal colour.
    expect(bands()[2]?.className).toContain('gauge-hatch')
    expect(screen.getByTestId('mission-gauge').getAttribute('title')).toBe(
      '3 of 8 tasks done, 2 underway, 1 blocked, 2 to go · 5 working',
    )
  })

  it('the chip says who is computing, never "live"', () => {
    const view = render(
      <MissionGauge
        progress={{ total: 3, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 0 }}
        live={3}
        working={1}
      />,
    )
    expect(screen.getByTestId('mission-live-chip').textContent).toBe('1 working')
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toContain('1 working')
    expect(screen.getByTestId('mission-live-chip').textContent).not.toMatch(/live/i)

    view.rerender(
      <MissionGauge
        progress={{ total: 3, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 1 }}
        live={3}
        working={0}
      />,
    )
    expect(screen.getByTestId('mission-live-chip').textContent).toBe('3 agents')
  })

  // An empty groove beside "0 agents" reads as a broken gauge. Nothing here is
  // done — there is simply nothing to count — so it says so, in the neutral
  // `to go` ground rather than in a success colour.
  it('says NO TASKS rather than painting an empty groove', () => {
    render(
      <MissionGauge
        progress={{ total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }}
        live={0}
        working={0}
      />,
    )

    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual(['none'])
    expect(label(bands()[0])).toBe('no tasks')
    // Not a done band, and not a done reading.
    expect(bands()[0]?.className).not.toContain('gauge-hatch')
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      'No tasks · 0 agents',
    )
  })

  // POD-1314: the reported reading, at the bar. The mission had one task in
  // progress, no live agent and a session that had exited six minutes earlier —
  // and the band said `1 UNDERWAY` beside a chip saying `0 agents`.
  it('says stalled, not underway, when the started work has nobody on it', () => {
    render(
      <MissionGauge
        progress={{ total: 1, done: 0, run: 0, review: 0, stall: 1, block: 0, wait: 0 }}
        live={0}
        working={0}
      />,
    )

    const gauge = screen.getByTestId('mission-gauge')
    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual(['stall'])
    expect(label(bands()[0])).toBe('1 stalled')
    expect(gauge.getAttribute('aria-label')).toBe('0 of 1 task done, 1 stalled · 0 agents')
    // It is not the blocked band wearing another word: no hatch, and it keeps
    // its own ground.
    expect(bands()[0]?.className).not.toContain('gauge-hatch')
    // And it never marches. The march is licensed by an agent computing, which
    // is the one thing this band exists to say there is not.
    expect(screen.getByTestId('mission-gauge-track').querySelector('.gauge-band-march')).toBeNull()
  })

  it('orders stalled after underway and before blocked, and reads both', () => {
    render(
      <MissionGauge
        progress={{ total: 4, done: 0, run: 1, review: 0, stall: 2, block: 1, wait: 0 }}
        live={1}
        working={1}
      />,
    )

    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual(['run', 'stall', 'block'])
    expect(screen.getByTestId('mission-gauge').getAttribute('title')).toBe(
      '0 of 4 tasks done, 1 underway, 2 stalled, 1 blocked · 1 working',
    )
    // The march belongs to the run band alone, even with both on the track.
    expect(bands()[0]?.querySelector('.gauge-band-march')).not.toBeNull()
    expect(bands()[1]?.querySelector('.gauge-band-march')).toBeNull()
  })

  it('calls an unstaffed review task in review instead of running', () => {
    render(
      <MissionGauge
        progress={{ total: 1, done: 0, run: 0, review: 1, stall: 0, block: 0, wait: 0 }}
        live={0}
        working={0}
      />,
    )

    expect(bands().map((band) => band.getAttribute('data-s'))).toEqual(['review'])
    expect(label(bands()[0])).toBe('1 in review')
    expect(screen.getByTestId('mission-gauge').getAttribute('aria-label')).toBe(
      '0 of 1 task done, 1 in review · 0 agents',
    )
    expect(screen.getByTestId('mission-gauge').getAttribute('data-running')).toBe('false')
    expect(screen.getByTestId('mission-gauge-track').querySelector('.gauge-band-march')).toBeNull()
  })
})
