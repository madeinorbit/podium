import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSyncBoundary } from './MobileSyncBoundary'
import { MobileSyncProgressStore } from './mobile-sync-progress'

afterEach(cleanup)

describe('MobileSyncBoundary', () => {
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

  it('keeps warm content painted and makes a sustained status non-intercepting', async () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    const view = render(
      <MobileSyncBoundary store={store}>
        <Text>cached workspace</Text>
      </MobileSyncBoundary>,
    )

    expect(view.getByText('cached workspace')).toBeTruthy()
    expect(view.queryByText('Reconnecting')).toBeNull()
    expect(view.getByRole('status').textContent).toBe('')
    await waitFor(() => expect(view.getByText('Reconnecting')).toBeTruthy())
    expect(view.getByRole('status').textContent).toBe('Reconnecting.')
    expect(window.getComputedStyle(view.getByTestId('warm-sync-status-host')).pointerEvents).toBe(
      'none',
    )

    act(() => {
      store.noteEvent({ type: 'posture', posture: 'live', previous: 'healing' })
    })
    expect(view.queryByTestId('warm-sync-status')).toBeNull()
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
    const view = render(
      <MobileSyncBoundary store={store}>
        <Text>cached workspace</Text>
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
    expect(await view.findByText('Offline — showing saved data')).toBeTruthy()
    expect(view.getByRole('status').textContent).toBe('Offline — showing saved data.')
  })
})
