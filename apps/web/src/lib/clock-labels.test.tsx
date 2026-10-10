import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PhaseTimer } from './motion/PhaseTimer'
import { IssueAge } from '@/features/issues/issue-page/IssueAge'
import { CardAge } from '@/features/issues/CardAge'
import { relativeTime } from '@podium/client-core/focus'
import { cardAge } from '@/features/issues/issue-card'
import { formatClock } from '@podium/client-core/values'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('updates label answers at their precision without redrawing their row', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  let draws = 0
  const stamp = new Date(95_000).toISOString()
  function Row() {
    draws++
    return <><PhaseTimer phase="working" sinceMs={95_000} showSpinner={false} /><IssueAge stamp={stamp} /><CardAge stamp={stamp} /></>
  }
  const view = render(<Row />)
  expect(view.container.textContent).toBe(`${formatClock(5000)}${relativeTime(stamp, 100_000)}${cardAge(stamp, 100_000)}`)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(view.container.textContent).toBe(`${formatClock(6000)}${relativeTime(stamp, 101_000)}${cardAge(stamp, 101_000)}`)
  expect(draws).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('a settled compute total has no ticking time observer', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const view = render(<PhaseTimer phase="done" sinceMs={95_000} totalMs={5000} />)
  expect(view.container.textContent).toBe(`∑ ${formatClock(5000)}`)
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(60_000))
  expect(view.container.textContent).toBe(`∑ ${formatClock(5000)}`)
})
