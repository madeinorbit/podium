// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncProgressStore } from '@/lib/sync-progress'

const live = vi.hoisted(() => ({
  connection: 'ok' as 'ok' | 'degraded' | 'down',
  queued: 0,
  refused: 0,
  undelivered: 0,
  listReads: 0,
}))
const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/app/header-data', () => ({ useHeaderOutboxSize: () => live.queued }))
vi.mock('@/features/chat/use-pool-notices', () => ({
  usePoolRecovery: () => Array.from({ length: live.refused }, (_, i) => ({ id: i })),
  usePoolMessageNoticeCount: () => live.undelivered,
}))
vi.mock('@/features/machines/ConnectionIndicator', () => ({
  useConnectionHealth: () => ({
    state:
      live.connection === 'down'
        ? 'offline'
        : live.connection === 'degraded'
          ? 'degraded'
          : 'online',
    since: 0,
  }),
  connectionSeverity: (c: { state: string }) =>
    c.state === 'offline' ? 'down' : c.state === 'degraded' ? 'degraded' : 'ok',
  describeHealth: (health: { state: string }) => ({
    headline: health.state === 'offline' ? 'Connection lost' : 'Slow connection',
    detail: 'detail words',
  }),
}))
// The review lists have their own suites; here they only prove WHEN the panel mounts them.
vi.mock('@/features/chat/MessageNotices', () => ({
  MessageNoticeList: () => {
    live.listReads += 1
    return <div data-testid="message-notice-list" />
  },
}))
vi.mock('@/features/machines/OutboxRecovery', () => ({
  OutboxRecoveryList: () => <div data-testid="outbox-recovery-list" />,
}))
vi.mock('@/features/machines/HostMemoryView', () => ({ HostInfoView: () => null }))

import { announcement, SyncStatusItem } from './SyncStatusItem'

let store: SyncProgressStore
const T0 = Date.parse('2026-11-12T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  Object.assign(live, { connection: 'ok', queued: 0, refused: 0, undelivered: 0, listReads: 0 })
  store = new SyncProgressStore()
  store.begin('live')
  toastError.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const view = () => render(<SyncStatusItem progress={store} />)
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const display = () => screen.getByTestId('sync-status').getAttribute('data-display')
const rerender = (r: ReturnType<typeof view>) => r.rerender(<SyncStatusItem progress={store} />)

/** A warm catch-up that has applied 62 of 100 sequence numbers. */
function catchUp(): void {
  act(() => {
    store.beginAttempt()
    store.noteCommitted(3, 162, 200, 100)
  })
}

describe('SyncStatusItem', () => {
  it('shows nothing while sync is healthy', () => {
    view()
    expect(display()).toBe('none')
    expect(screen.queryByTestId('sync-item')).toBeNull()
  })

  it('waits 1.5 s before showing a catch-up, then shows the measured percent', () => {
    view()
    catchUp()
    advance(1499)
    expect(screen.queryByTestId('sync-item')).toBeNull()
    advance(1)
    const item = screen.getByTestId('sync-item')
    expect(item.textContent).toBe('Syncing62%')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
  })

  it('never shows a catch-up that ends inside the wait', () => {
    view()
    catchUp()
    advance(900)
    act(() => store.noteReady())
    advance(5000)
    expect(screen.queryByTestId('sync-item')).toBeNull()
    expect(screen.queryByTestId('sync-up-to-date')).toBeNull()
  })

  it('ends a visible catch-up on "Up to date", then hides', () => {
    view()
    catchUp()
    // Step to each deadline: a render held inside one long act would stamp the
    // later time on the change.
    advance(1500)
    advance(500)
    act(() => store.noteReady())
    // Shown at 1.5 s, so it holds until 2.1 s before confirming.
    advance(99)
    expect(screen.getByTestId('sync-item').textContent).toBe('Syncing62%')
    advance(1)
    expect(screen.getByTestId('sync-up-to-date').textContent).toBe('Up to date')
    advance(1600)
    expect(display()).toBe('none')
  })

  it('shows a paused catch-up at once, with a Retry that retries', () => {
    const retry = vi.fn()
    store.retry = retry
    view()
    act(() => {
      store.beginAttempt()
      store.noteError('network')
    })
    advance(0)
    expect(screen.getByTestId('sync-item').textContent).toBe('Sync paused')
    fireEvent.click(screen.getByTestId('sync-retry'))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('says offline with the queued count after the connection wait', () => {
    live.connection = 'down'
    live.queued = 3
    view()
    advance(1199)
    expect(screen.queryByTestId('sync-item')).toBeNull()
    advance(1)
    expect(screen.getByTestId('sync-item').textContent).toBe('Offline· 3 queued')
    expect(screen.getByTestId('sync-item').getAttribute('data-tone')).toBe('bad')
  })

  it('spells the review count out when there is no condition, at once', () => {
    live.undelivered = 1
    live.refused = 1
    view()
    expect(screen.getByTestId('sync-review-words').textContent).toBe('2 need review')
  })

  it('carries the review count as a pill beside a condition', () => {
    live.connection = 'down'
    live.undelivered = 2
    view()
    advance(1200)
    expect(screen.getByTestId('sync-review-pill').textContent).toBe('2')
    expect(screen.queryByTestId('sync-review-words')).toBeNull()
  })

  it('mounts the review lists only while the panel is open', () => {
    live.undelivered = 1
    live.refused = 1
    view()
    expect(live.listReads).toBe(0)
    fireEvent.click(screen.getByTestId('sync-item'))
    advance(0)
    expect(screen.getByTestId('sync-panel')).toBeTruthy()
    expect(screen.getByTestId('message-notice-list')).toBeTruthy()
    expect(screen.getByTestId('outbox-recovery-list')).toBeTruthy()
    expect(screen.getByText('Needs review · 2')).toBeTruthy()
  })

  it('puts the sections that apply in the panel, and only those', () => {
    live.connection = 'down'
    live.queued = 2
    view()
    advance(1200)
    fireEvent.click(screen.getByTestId('sync-item'))
    advance(0)
    const panel = screen.getByTestId('sync-panel')
    expect(panel.querySelector('[aria-label="Connection"]')?.textContent).toContain(
      'Connection lost.',
    )
    expect(panel.querySelector('[aria-label="Outgoing"]')?.textContent).toContain(
      '2 changes saved on this device',
    )
    expect(panel.querySelector('[aria-label="Needs review"]')).toBeNull()
    expect(panel.querySelector('[aria-label="Incoming"]')).toBeNull()
  })

  it('toasts a new review item, but not what was waiting when the window opened', () => {
    live.undelivered = 1
    const r = view()
    rerender(r)
    expect(toastError).not.toHaveBeenCalled()
    advance(3000)
    live.undelivered = 2
    rerender(r)
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError.mock.calls[0]?.[0]).toBe('A message didn’t arrive')
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ id: 'sync-review' })
    live.refused = 1
    rerender(r)
    expect(toastError.mock.calls[1]?.[0]).toBe('A change couldn’t be saved')
  })

  it('does not toast when a review item is handled', () => {
    live.undelivered = 2
    const r = view()
    advance(3000)
    live.undelivered = 1
    rerender(r)
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('announcement', () => {
  it('names the condition and the count, never the percent', () => {
    expect(announcement('catching-up', 0, 0)).toBe('Syncing')
    expect(announcement('offline', 3, 2)).toBe('Offline, 3 queued, 2 need review')
    expect(announcement(null, 0, 1)).toBe('1 need review')
    expect(announcement('up-to-date', 0, 0)).toBe('Up to date')
    expect(announcement(null, 0, 0)).toBe('')
  })
})
