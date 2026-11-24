import { relativeTime } from '@podium/client-core/focus'
import { formatClock } from '@podium/client-core/values'
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { CardAge } from '@/features/issues/CardAge'
import { cardAge } from '@/features/issues/issue-card'
import { IssueAge, IssueDayLabel } from '@/features/issues/issue-page/IssueAge'
import { PhaseTimer } from './motion/PhaseTimer'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('updates label answers at their precision without redrawing their row', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  let draws = 0
  const stamp = new Date(95_000).toISOString()
  function Row() {
    draws++
    return (
      <>
        <PhaseTimer phase="working" sinceMs={95_000} showSpinner={false} />
        <IssueAge stamp={stamp} />
        <CardAge stamp={stamp} />
      </>
    )
  }
  const view = render(<Row />)
  expect(view.container.textContent).toBe(
    `${formatClock(5000)}${relativeTime(stamp, 100_000)}${cardAge(stamp, 100_000)}`,
  )
  // Elapsed digits share the seconds clock; age labels share exact deadlines.
  expect(vi.getTimerCount()).toBe(2)
  act(() => vi.advanceTimersByTime(1000))
  expect(view.container.textContent).toBe(
    `${formatClock(6000)}${relativeTime(stamp, 101_000)}${cardAge(stamp, 101_000)}`,
  )
  expect(draws).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('shares one exact timer across differing formatters and drops it while the panel is hidden', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const stamp = new Date(0).toISOString()
  const scene = (visible: boolean) => (
    <PanelVisible visible={visible}>
      <IssueAge stamp={stamp} />
      <CardAge stamp={stamp} />
    </PanelVisible>
  )
  const view = render(scene(true))
  expect(vi.getTimerCount()).toBe(1)
  const before = view.container.textContent
  act(() => vi.advanceTimersByTime(19_999))
  expect(view.container.textContent).toBe(before)
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe('2m ago2m')
  act(() => vi.advanceTimersByTime(29_499))
  expect(view.container.textContent).toBe('2m ago2m')
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe('3m ago2m')
  view.rerender(scene(false))
  expect(vi.getTimerCount()).toBe(0)
  view.rerender(scene(true))
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('a settled compute total has no ticking time observer', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const view = render(<PhaseTimer phase="done" sinceMs={95_000} totalMs={5000} />)
  expect(view.container.textContent).toBe(`∑ ${formatClock(5000)}`)
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(60_000))
  expect(view.container.textContent).toBe(`∑ ${formatClock(5000)}`)
})

it('redraws each card only on its own minute boundary at arbitrary phases', () => {
  vi.useFakeTimers()
  vi.setSystemTime(42_101)
  const first = vi.fn(),
    second = vi.fn()
  const view = render(
    <>
      <Profiler id="first" onRender={first}>
        <CardAge stamp={new Date(10_123).toISOString()} />
      </Profiler>
      <Profiler id="second" onRender={second}>
        <CardAge stamp={new Date(20_987).toISOString()} />
      </Profiler>
    </>,
  )
  first.mockClear()
  second.mockClear()
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(70_122 - Date.now()))
  expect(first).not.toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe('1mnow')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(80_987 - Date.now()))
  expect(view.container.textContent).toBe('1m1m')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('changes the activity day at local midnight without intermediate commits', () => {
  vi.useFakeTimers()
  const midnight = new Date(2026, 10, 20).getTime()
  vi.setSystemTime(midnight - 12_345)
  const commits = vi.fn()
  const view = render(
    <Profiler id="day" onRender={commits}>
      <IssueDayLabel day="2026-11-19" stamp={new Date(2026, 10, 19, 8).toISOString()} />
    </Profiler>,
  )
  expect(view.container.textContent).toBe('Today')
  commits.mockClear()
  act(() => vi.advanceTimersByTime(12_344))
  expect(commits).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe('Yesterday')
  expect(commits).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
