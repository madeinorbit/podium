// @vitest-environment happy-dom
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MissionGauge } from './MissionGauge'

afterEach(cleanup)
const full = (buckets: FullDeck['buckets'], computing = false) => ({ buckets, computing }) as FullDeck

it('shows task counts above wordless proportional segments and no crew chip', () => {
  render(
    <MissionGauge
      full={full({ total: 12, done: 4, working: 3, waiting: 2, todo: 3 })}
      working={1}
    />,
  )
  expect(screen.getByTestId('mission-gauge-counts').textContent).toBe(
    '4 done3 working2 waiting3 to do',
  )
  const bands = screen.getAllByTestId('mission-gauge-band')
  expect(bands.map((b) => b.getAttribute('data-s'))).toEqual(['done', 'working', 'waiting', 'todo'])
  expect(bands.map((b) => b.style.flexGrow)).toEqual(['4', '3', '2', '3'])
  expect(bands.every((b) => b.textContent === '')).toBe(true)
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
    '4 of 12 tasks done, 3 working, 2 waiting, 3 to do',
  )
  expect(screen.queryByTestId('mission-live-chip')).toBeNull()
})

it('gates animation on computing sessions, including shipping without a session', () => {
  const data = full({ total: 1, done: 0, working: 1, waiting: 0, todo: 0 })
  const view = render(<MissionGauge full={data} working={0} />)
  expect(screen.getByTestId('mission-gauge-band').getAttribute('data-working')).toBe('false')
  view.rerender(<MissionGauge full={full(data.buckets, true)} working={1} />)
  expect(screen.getByTestId('mission-gauge-band').getAttribute('data-working')).toBe('true')
})

it('keeps the full accessible reading when zero buckets have no visible key or segment', () => {
  render(
    <MissionGauge
      full={full({ total: 1, done: 0, working: 0, waiting: 1, todo: 0 })}
      working={0}
    />,
  )
  expect(screen.getByTestId('mission-gauge-counts').textContent).toBe(
    '1 waiting',
  )
  expect(screen.getAllByTestId('mission-gauge-band')).toHaveLength(1)
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
    '0 of 1 tasks done, 0 working, 1 waiting, 0 to do',
  )
})

it('leaves an empty rail for no accepted tasks', () => {
  render(
    <MissionGauge
      full={full({ total: 0, done: 0, working: 0, waiting: 0, todo: 0 })}
      working={0}
    />,
  )
  expect(screen.queryAllByTestId('mission-gauge-band')).toHaveLength(0)
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('0 of 0 tasks done')
})
