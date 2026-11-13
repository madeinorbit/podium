import { act, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LIST_SETTLE_MS, useSettledOrder } from './use-settled-order'

const focus = vi.hoisted(() => ({ blur: [] as (() => void)[] }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => {
      const cleanup = effect()
      if (cleanup) focus.blur.push(cleanup)
      return cleanup
    }, [effect]),
}))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  focus.blur.length = 0
})

it('holds still through the first population and settle, then follows order changes', () => {
  const { result, rerender } = renderHook(({ rev, ready }) => useSettledOrder(rev, ready), {
    initialProps: { rev: 1, ready: false },
  })
  expect(result.current).toBe(0)
  rerender({ rev: 2, ready: true }) // first population
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS - 400))
  rerender({ rev: 3, ready: true }) // the first settle re-sorts: restarts the wait
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS - 1))
  expect(result.current).toBe(0)
  act(() => vi.advanceTimersByTime(1))
  // Arming adopts the current order without changing what is shown.
  expect(result.current).toBe(3)
  rerender({ rev: 4, ready: true }) // a genuine change animates at once
  expect(result.current).toBe(4)
})

it('disarms when the tab is hidden so the next open settles quietly again', () => {
  const { result, rerender } = renderHook(({ rev }) => useSettledOrder(rev, true), {
    initialProps: { rev: 1 },
  })
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS))
  expect(result.current).toBe(1)
  act(() => {
    for (const blur of focus.blur) blur()
  })
  expect(result.current).toBe(0)
  rerender({ rev: 2 })
  expect(result.current).toBe(0)
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS))
  expect(result.current).toBe(2)
})
