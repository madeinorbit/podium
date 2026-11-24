import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OFFLINE_SUBTITLE,
  UPDATED_SUBTITLE,
  UPDATED_SUBTITLE_MS,
  UPDATING_SUBTITLE,
  useWorkspaceRefreshSubtitle,
  WorkspaceRefreshProvider,
  WorkspaceSyncContext,
} from '../client/workspace-refresh'

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

function renderPulledTab(store: SyncProgressStore) {
  return renderHook(
    () => ({ list: useRefreshableList(), subtitle: useWorkspaceRefreshSubtitle() }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceRefreshProvider store={store}>{children}</WorkspaceRefreshProvider>
      ),
    },
  )
}

it('acknowledges a fast pull that changes nothing in the shared sync phase', async () => {
  vi.useFakeTimers()
  connection.connected = true
  const store = new SyncProgressStore()
  store.begin('stale')
  store.noteReady()
  const { result } = renderPulledTab(store)
  expect(store.getSnapshot().phase).toBe('ready')
  expect(result.current.subtitle).toBeUndefined()

  let completion!: Promise<void>
  act(() => {
    completion = result.current.list.onRefresh()
  })
  expect(result.current.subtitle).toBe(UPDATING_SUBTITLE)

  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  await completion
  expect(result.current.list.refreshing).toBe(false)
  expect(store.getSnapshot().phase).toBe('ready')
  expect(result.current.subtitle).toBe(UPDATED_SUBTITLE)

  act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS - 1))
  expect(result.current.subtitle).toBe(UPDATED_SUBTITLE)
  act(() => vi.advanceTimersByTime(1))
  expect(result.current.subtitle).toBeUndefined()
})

it('keeps the offline text after a failed pull until shared sync recovers', () => {
  vi.useFakeTimers()
  const store = new SyncProgressStore()
  store.begin('stale')
  store.noteReady()
  const { result } = renderPulledTab(store)

  act(() => {
    void result.current.list.onRefresh()
  })
  act(() => store.noteError('network'))
  expect(result.current.subtitle).toBe(UPDATING_SUBTITLE)
  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  expect(result.current.subtitle).toBe(OFFLINE_SUBTITLE)
  act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS + 1))
  expect(store.getSnapshot().phase).toBe('error')
  expect(result.current.subtitle).toBe(OFFLINE_SUBTITLE)
  act(() => store.noteReady())
  expect(result.current.subtitle).toBe(UPDATED_SUBTITLE)
  act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
  expect(result.current.subtitle).toBeUndefined()
})

it('replaces a failed pull acknowledgement as soon as shared sync recovers', () => {
  vi.useFakeTimers()
  const store = new SyncProgressStore()
  store.begin('live')
  const { result } = renderPulledTab(store)

  act(() => {
    void result.current.list.onRefresh()
    store.noteDisconnected()
  })
  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  expect(result.current.subtitle).toBe(OFFLINE_SUBTITLE)
  act(() => store.noteReady())
  expect(result.current.subtitle).toBe(UPDATED_SUBTITLE)
  act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
  expect(result.current.subtitle).toBeUndefined()
})

it('shows a shared failure even while a successful pull acknowledgement is visible', () => {
  vi.useFakeTimers()
  connection.connected = true
  const store = new SyncProgressStore()
  store.begin('live')
  const { result } = renderPulledTab(store)

  act(() => {
    void result.current.list.onRefresh()
  })
  act(() => vi.advanceTimersByTime(MIN_REFRESH_CONFIRMATION_MS))
  expect(result.current.subtitle).toBe(UPDATED_SUBTITLE)
  act(() => store.noteDisconnected())
  expect(result.current.subtitle).toBe(OFFLINE_SUBTITLE)
  act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS + 1))
  expect(result.current.subtitle).toBe(OFFLINE_SUBTITLE)
})

it('clears the pull status when the pulling list unmounts mid-refresh', () => {
  vi.useFakeTimers()
  const store = new SyncProgressStore()
  store.begin('stale')
  store.noteReady()
  let pullNow = (): Promise<void> => Promise.resolve()
  function PullingList() {
    pullNow = useRefreshableList().onRefresh
    return null
  }
  const subtitle: { current: string | undefined } = { current: undefined }
  function Subtitle() {
    subtitle.current = useWorkspaceRefreshSubtitle()
    return null
  }
  const tree = (mounted: boolean) => (
    <WorkspaceRefreshProvider store={store}>
      {mounted ? <PullingList /> : null}
      <Subtitle />
    </WorkspaceRefreshProvider>
  )
  const view = render(tree(true))
  act(() => {
    void pullNow()
  })
  expect(subtitle.current).toBe(UPDATING_SUBTITLE)
  view.rerender(tree(false))
  expect(subtitle.current).toBeUndefined()
})
