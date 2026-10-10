import { MobxPool } from '@podium/client-graph/pool'
import { refreshClocks, setClockActive } from '@podium/mobx-helpers'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useClock } from '../lib/clock-hooks'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  setClockActive(true)
  vi.useRealTimers()
})

it('resamples the shared native label clock without reading pool rows', () => {
  vi.useFakeTimers()
  const start = Date.parse('2026-10-03T08:00:00Z')
  vi.setSystemTime(start)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: start })
  const ids = vi.spyOn(pool.queries, 'ids')
  function Clock() { return <span data-testid="phone-clock">{useClock(60_000)}</span> }
  const view = render(<Clock />)
  expect(screen.getByTestId('phone-clock').textContent).toBe(String(start))
  expect(vi.getTimerCount()).toBe(1)
  for (const next of [start + 60_000, start + 120_000, start - 60_000]) {
    act(() => { vi.setSystemTime(next); refreshClocks() })
    expect(screen.getByTestId('phone-clock').textContent).toBe(String(next))
  }
  act(() => setClockActive(false))
  expect(vi.getTimerCount()).toBe(0)
  act(() => { vi.setSystemTime(start + 180_000); setClockActive(true) })
  expect(screen.getByTestId('phone-clock').textContent).toBe(String(start + 180_000))
  expect(ids).not.toHaveBeenCalled()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
  pool.dispose()
})
