import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const connection = vi.hoisted(() => ({ connected: false, connect: vi.fn() }))

vi.mock('../client/hooks', () => ({
  useConnected: () => connection.connected,
  useHub: () => ({ connect: connection.connect }),
}))

const { MIN_REFRESH_CONFIRMATION_MS, useRefreshableList } = await import('./useRefreshableTab')

afterEach(() => {
  vi.useRealTimers()
  connection.connected = false
  connection.connect.mockReset()
})

describe('refreshable mobile lists', () => {
  it('reconnects immediately when pulled offline and keeps confirmation visible', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useRefreshableList())

    act(() => result.current.onRefresh())
    expect(connection.connect).toHaveBeenCalledOnce()
    expect(result.current.refreshing).toBe(true)

    act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS - 1))
    expect(result.current.refreshing).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.refreshing).toBe(false)
  })

  it('does not reconnect an already-current list and exposes the refresh action', () => {
    vi.useFakeTimers()
    connection.connected = true
    const { result } = renderHook(() => useRefreshableList())

    act(() =>
      result.current.refreshAccessibilityProps.onAccessibilityAction?.({
        nativeEvent: { actionName: 'refresh' },
      } as never),
    )

    expect(connection.connect).not.toHaveBeenCalled()
    expect(result.current.refreshing).toBe(true)
    expect(result.current.refreshAccessibilityProps.accessibilityActions).toEqual([
      { name: 'refresh', label: 'Refresh list' },
    ])
  })
})
