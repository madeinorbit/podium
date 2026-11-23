import { refreshClocks, setClockWakeSource } from '@podium/mobx-helpers'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { useCountdown } from './clock-hooks'

afterEach(() => {
  cleanup()
  setClockWakeSource(undefined)
  vi.useRealTimers()
})

function Countdown({ at, precision }: { at?: number; precision?: number }) {
  return <output>{useCountdown(at, precision)}</output>
}

it('matches the old countdown at each second and expires between ticks', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const at = 102_250
  const view = render(<Countdown at={at} />)
  expect(view.container.textContent).toBe(String(at - Date.now()))
  expect(vi.getTimerCount()).toBe(2)
  act(() => vi.advanceTimersByTime(999))
  expect(view.container.textContent).toBe('2250')
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe(String(at - Date.now()))
  act(() => vi.advanceTimersByTime(1_249))
  expect(view.container.textContent).toBe('250')
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe('0')
  expect(vi.getTimerCount()).toBe(0)
})

it('shares countdown timers and releases every registration on hide or unmount', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const labels = (
    <>
      <Countdown at={110_000} />
      <Countdown at={120_000} />
    </>
  )
  const view = render(<PanelVisible visible>{labels}</PanelVisible>)
  expect(vi.getTimerCount()).toBe(2)
  view.rerender(<PanelVisible visible={false}>{labels}</PanelVisible>)
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(30_000))
  view.rerender(<PanelVisible visible>{labels}</PanelVisible>)
  expect(view.container.textContent).toBe('00')
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('rechecks exact deadlines immediately after the app wakes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  let active = true
  setClockWakeSource({ isActive: () => active, subscribe: () => () => {} })
  const view = render(<Countdown at={110_000} />)
  active = false
  act(() => refreshClocks())
  expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(120_000)
  active = true
  act(() => refreshClocks())
  expect(view.container.textContent).toBe('0')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  undefined,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  90_000,
])('does not tick for an inactive deadline (%s)', (at) => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const view = render(<Countdown at={at} />)
  expect(view.container.textContent).toBe('0')
  expect(vi.getTimerCount()).toBe(0)
})
