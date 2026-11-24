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
  expect(result.current).toBe(false)
  rerender({ rev: 2, ready: true }) // first population
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS - 400))
  rerender({ rev: 3, ready: true }) // the first settle re-sorts: restarts the wait
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS - 1))
  expect(result.current).toBe(false)
  act(() => vi.advanceTimersByTime(1))
  expect(result.current).toBe(true)
  rerender({ rev: 4, ready: true }) // a genuine change stays armed and animates
  expect(result.current).toBe(true)
})

it('disarms when the tab is hidden so the next open settles quietly again', () => {
  const { result, rerender } = renderHook(({ rev }) => useSettledOrder(rev, true), {
    initialProps: { rev: 1 },
  })
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS))
  expect(result.current).toBe(true)
  act(() => {
    for (const blur of focus.blur) blur()
  })
  expect(result.current).toBe(false)
  rerender({ rev: 2 })
  expect(result.current).toBe(false)
  act(() => vi.advanceTimersByTime(LIST_SETTLE_MS))
  expect(result.current).toBe(true)
})
