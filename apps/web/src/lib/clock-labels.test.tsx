import { relativeTime } from '@podium/client-core/focus'
import { formatClock } from '@podium/client-core/values'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { CardAge } from '@/features/issues/CardAge'
import { cardAge } from '@/features/issues/issue-card'
import { IssueAge } from '@/features/issues/issue-page/IssueAge'
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
  // Elapsed digits share the seconds clock; the age labels share minutes.
  expect(vi.getTimerCount()).toBe(2)
  act(() => vi.advanceTimersByTime(1000))
  expect(view.container.textContent).toBe(
    `${formatClock(6000)}${relativeTime(stamp, 101_000)}${cardAge(stamp, 101_000)}`,
  )
  expect(draws).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses one minute timer for age labels and drops it while their panel is hidden', () => {
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
  act(() => vi.advanceTimersByTime(59_999))
  expect(view.container.textContent).toBe(before)
  act(() => vi.advanceTimersByTime(1))
  expect(view.container.textContent).toBe(
    `${relativeTime(stamp, 160_000)}${cardAge(stamp, 160_000)}`,
  )
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
