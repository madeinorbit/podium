import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSyncContext } from '../client/workspace-refresh'

const connection = vi.hoisted(() => ({ connected: false, connect: vi.fn() }))

vi.mock('../client/hooks', () => ({
  useConnected: () => connection.connected,
  useHub: () => ({ connect: connection.connect }),
}))

const { MIN_REFRESH_CONFIRMATION_MS, useRefreshableList } = await import('./useRefreshableTab')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  connection.connected = false
  connection.connect.mockReset()
})

describe('refreshable mobile lists', () => {
  it('reconnects immediately when pulled offline and keeps confirmation visible', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useRefreshableList())

    act(() => {
      void result.current.onRefresh()
    })
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

it.each([
  'ready',
  'error',
] as const)('keeps a pulled refresh running until shared sync reaches %s', (end) => {
  vi.useFakeTimers()
  const store = new SyncProgressStore()
  store.begin('stale')
  const { result } = renderHook(() => useRefreshableList(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceSyncContext value={store}>{children}</WorkspaceSyncContext>
    ),
  })
  expect(result.current.refreshing).toBe(false)
  act(() => {
    void result.current.onRefresh()
  })
  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  expect(result.current.refreshing).toBe(true)
  act(() => store.noteSaving())
  expect(result.current.refreshing).toBe(true)
  act(() => (end === 'ready' ? store.noteReady() : store.noteError('network')))
  expect(result.current.refreshing).toBe(false)
})

it('returns one pending completion for SwiftUI and releases it on unmount', async () => {
  vi.useFakeTimers()
  const store = new SyncProgressStore()
  store.begin('stale')
  const { result, unmount } = renderHook(() => useRefreshableList(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceSyncContext value={store}>{children}</WorkspaceSyncContext>
    ),
  })
  let completion!: Promise<void>
  act(() => {
    completion = result.current.onRefresh()
  })
  expect(result.current.onRefresh()).toBe(completion)
  const finished = vi.fn()
  void completion.then(finished)
  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  unmount()
  await completion
  expect(finished).toHaveBeenCalledOnce()
})
