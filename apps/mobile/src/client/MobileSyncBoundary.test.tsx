import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSyncBoundary } from './MobileSyncBoundary'
import { MobileSyncProgressStore } from './mobile-sync-progress'
import {
  UPDATED_SUBTITLE_MS,
  useWorkspaceRefreshSubtitle,
  watchWorkspaceResume,
} from './workspace-refresh'

function Subtitle() {
  return <Text>{useWorkspaceRefreshSubtitle() ?? '11 need you'}</Text>
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function phoneLifecycle(store: MobileSyncProgressStore) {
  let visible = true
  let online = true
  const listeners = new Set<() => void>()
  const connectivity = {
    visibility: {
      isVisible: () => visible,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    isOnline: () => online,
  }
  const stop = watchWorkspaceResume(store.shared, connectivity)
  return {
    ...connectivity,
    stop,
    setOnline: (value: boolean) => {
      online = value
    },
    show: (value: boolean) => {
      visible = value
      for (const listener of listeners) listener()
    },
  }
}

describe('MobileSyncBoundary', () => {
  it.each([
    'heal',
    'full download',
  ] as const)('primes Updating before suspension and keeps it from the first resume frame through a %s', (path) => {
    vi.useFakeTimers()
    const store = new MobileSyncProgressStore()
    store.begin('live')
    const phone = phoneLifecycle(store)
    const clicked = vi.fn()
    const view = render(
      <MobileSyncBoundary store={store} visibility={phone.visibility}>
        <Subtitle />
        <Text onPress={clicked}>saved content</Text>
      </MobileSyncBoundary>,
    )
    try {
      act(() => {
        phone.show(false)
        store.noteEvent({ type: 'posture', previous: 'live', posture: 'stale' })
      })
      expect(view.queryByText('Offline · Showing saved data')).toBeNull()
      expect(view.getByText('Updating…')).toBeTruthy()
      act(() => vi.advanceTimersByTime(60_000))
      act(() => phone.show(true))
      // No hello, HTTP receipt or timeout has arrived yet.
      expect(store.getSnapshot().phase).toBe('reconnecting')
      expect(view.getByText('Updating…')).toBeTruthy()
      expect(view.queryByText('11 need you')).toBeNull()
      fireEvent.click(view.getByText('saved content'))
      expect(clicked).toHaveBeenCalledOnce()
      act(() => {
        store.beginAttempt()
        if (path === 'full download') store.noteMeta(10_000)
        store.noteReceived(500)
        store.noteSaving()
      })
      expect(view.getByText('Updating…')).toBeTruthy()
      act(() => store.noteEvent({ type: 'posture', previous: 'healing', posture: 'live' }))
      expect(view.getByText('Updated just now')).toBeTruthy()
      act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
      expect(view.getByText('11 need you')).toBeTruthy()
    } finally {
      phone.stop()
    }
  })

  it('keeps real foreground failures and an offline resume visible', () => {
    const store = new MobileSyncProgressStore()
    store.begin('live')
    const phone = phoneLifecycle(store)
    const view = render(
      <MobileSyncBoundary store={store} visibility={phone.visibility}>
        <Subtitle />
      </MobileSyncBoundary>,
    )
    try {
      act(() => store.noteEvent({ type: 'posture', previous: 'live', posture: 'stale' }))
      expect(view.getByText('Offline · Showing saved data')).toBeTruthy()
      act(() => {
        phone.show(false)
        phone.setOnline(false)
      })
      act(() => phone.show(true))
      expect(store.getSnapshot().phase).toBe('offline')
      expect(view.getByText('Offline · Showing saved data')).toBeTruthy()
    } finally {
      phone.stop()
    }
  })

  it.each([
    'offline',
    'error',
  ] as const)('keeps a failed online resume visible past the completion timer while %s persists', (phase) => {
    vi.useFakeTimers()
    const store = new MobileSyncProgressStore()
    store.begin('live')
    const phone = phoneLifecycle(store)
    const view = render(
      <MobileSyncBoundary store={store} visibility={phone.visibility}>
        <Subtitle />
      </MobileSyncBoundary>,
    )
    try {
      act(() => {
        phone.show(false)
        store.noteEvent({ type: 'posture', previous: 'live', posture: 'stale' })
      })
      act(() => vi.advanceTimersByTime(60_000))
      act(() => phone.show(true))
      expect(phone.isOnline()).toBe(true)
      expect(store.shared.getSnapshot().phase).toBe('reconnecting')
      expect(view.getByText('Updating…')).toBeTruthy()

      act(() => {
        if (phase === 'offline') store.shared.noteDisconnected()
        else store.shared.noteError('network', 'server unreachable')
      })
      expect(view.getByText('Offline · Showing saved data')).toBeTruthy()
      act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS + 1))
      expect(store.shared.getSnapshot().phase).toBe(phase)
      expect(view.getByText('Offline · Showing saved data')).toBeTruthy()
      expect(view.queryByText('11 need you')).toBeNull()

      act(() => store.shared.noteReconnecting())
      expect(view.getByText('Updating…')).toBeTruthy()
      act(() => store.shared.noteReady())
      expect(view.getByText('Updated just now')).toBeTruthy()
      act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
      expect(view.getByText('11 need you')).toBeTruthy()
    } finally {
      phone.stop()
    }
  })

  it('uses the launch surface as an intentional cold-start input gate', () => {
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    const view = render(
      <MobileSyncBoundary store={store}>
        <Text>unfinished workspace</Text>
      </MobileSyncBoundary>,
    )

    expect(view.queryByText('unfinished workspace')).toBeNull()
    expect(view.queryByTestId('sync-content')).toBeNull()
  })

  it('keeps warm content interactive and puts status in the subtitle without an overlay', () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    const clicked = vi.fn()
    const view = render(
      <MobileSyncBoundary store={store}>
        <Subtitle />
        <Text onPress={clicked}>cached workspace</Text>
      </MobileSyncBoundary>,
    )

    expect(view.getByText('cached workspace')).toBeTruthy()
    expect(view.getByText('Updating…')).toBeTruthy()
    expect(view.queryByTestId('warm-sync-status-host')).toBeNull()
    fireEvent.click(view.getByText('cached workspace'))
    expect(clicked).toHaveBeenCalledOnce()

    act(() => {
      store.noteEvent({ type: 'posture', posture: 'live', previous: 'healing' })
    })
    expect(view.getByText('Updated just now')).toBeTruthy()
    expect(view.getByText('cached workspace')).toBeTruthy()
  })

  it('replaces an exhausted cold sync with an actionable failure', () => {
    const store = new MobileSyncProgressStore()
    const retry = vi.fn()
    store.begin('cold')
    const view = render(
      <MobileSyncBoundary store={store} onRetry={retry}>
        <Text>unfinished workspace</Text>
      </MobileSyncBoundary>,
    )

    act(() => {
      store.noteEvent({
        type: 'bootstrap-failed',
        cause: 'cold-start',
        attempts: 3,
        error: 'world unavailable',
      })
    })

    expect(view.getByText('CANNOT START')).toBeTruthy()
    expect(view.getByText('world unavailable')).toBeTruthy()
    expect(view.queryByText('unfinished workspace')).toBeNull()
    fireEvent.click(view.getByText('Retry'))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('offers recovery when a cold sync stalls without cancelling it', async () => {
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    const view = render(
      <MobileSyncBoundary store={store} onRetry={() => {}} stallAfterMs={0}>
        <Text>unfinished workspace</Text>
      </MobileSyncBoundary>,
    )

    expect(await view.findByText('STILL STARTING')).toBeTruthy()
    expect(
      view.getByText('The app is still trying to start. You can wait, or retry now.'),
    ).toBeTruthy()
  })

  it('keeps cached content usable after a warm bootstrap exhausts its retries', async () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    const clicked = vi.fn()
    const view = render(
      <MobileSyncBoundary store={store}>
        <Subtitle />
        <Text onPress={clicked}>cached workspace</Text>
      </MobileSyncBoundary>,
    )

    act(() => {
      store.noteEvent({
        type: 'bootstrap-failed',
        cause: 'resync-required',
        attempts: 3,
        error: 'network unavailable',
      })
    })

    expect(view.getByText('cached workspace')).toBeTruthy()
    expect(await view.findByText('Offline · Showing saved data')).toBeTruthy()
    expect(view.queryByTestId('warm-sync-status-host')).toBeNull()
  })
})
