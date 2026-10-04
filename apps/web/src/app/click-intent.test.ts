// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUBLE_CLICK_MS, useClickIntent } from './click-intent'

/**
 * POD-5444: the session click must not wait out the double-click window. The
 * first press acts at once; a second press inside the window only upgrades
 * (the caller's double), never re-fires the single.
 */

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useClickIntent (POD-5444, no 260 ms wait)', () => {
  it('runs the single synchronously on the first press, without advancing timers', () => {
    const single = vi.fn()
    const double = vi.fn()
    const { result } = renderHook(() => useClickIntent())

    act(() => {
      result.current.press(single, double)
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(double).not.toHaveBeenCalled()
  })

  it('runs only the double on a second press inside the window', () => {
    const single = vi.fn()
    const double = vi.fn()
    const { result } = renderHook(() => useClickIntent())

    act(() => {
      result.current.press(single, double)
    })
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1)
    })
    act(() => {
      result.current.press(single, double)
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(double).toHaveBeenCalledTimes(1)
  })

  it('treats a press after the window as a fresh single', () => {
    const single = vi.fn()
    const double = vi.fn()
    const { result } = renderHook(() => useClickIntent())

    act(() => {
      result.current.press(single, double)
    })
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_MS + 1)
    })
    act(() => {
      result.current.press(single, double)
    })

    expect(single).toHaveBeenCalledTimes(2)
    expect(double).not.toHaveBeenCalled()
  })

  it('commit runs the double and closes the window', () => {
    const single = vi.fn()
    const double = vi.fn()
    const { result } = renderHook(() => useClickIntent())

    act(() => {
      result.current.press(single, double)
    })
    act(() => {
      result.current.commit(double)
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(double).toHaveBeenCalledTimes(1)

    // The window is spent: the next press is a fresh single, not a double.
    const later = vi.fn()
    act(() => {
      result.current.press(single, later)
    })
    expect(single).toHaveBeenCalledTimes(2)
    expect(later).not.toHaveBeenCalled()
  })

  it('fires nothing when the window expires with no second press', () => {
    const single = vi.fn()
    const double = vi.fn()
    const { result } = renderHook(() => useClickIntent())

    act(() => {
      result.current.press(single, double)
    })
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_MS + 1_000)
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(double).not.toHaveBeenCalled()
  })
})
