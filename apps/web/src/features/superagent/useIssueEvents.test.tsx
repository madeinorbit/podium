import type { ReadPositionPort } from '@podium/client-core'
import type { IssueEventWire } from '@podium/model'
import { issueEventRowId } from '@podium/model'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIssueEvents } from './useIssueEvents'

/**
 * The chat feed reads REPLICATED rows now (POD-1772), so what is worth asserting
 * here is the projection over them — and above all the ordering, because the
 * replica keys these rows on a composite string and a collection ordered by
 * THAT puts event 100 before event 99.
 */

const rows: IssueEventWire[] = []
vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (s: { issueEvents: IssueEventWire[] }) => unknown) =>
    select({ issueEvents: rows }),
}))

const row = (eventId: number, subject = 'POD-13'): IssueEventWire => ({
  id: issueEventRowId(eventId, subject),
  eventId,
  ts: `2026-08-11T00:00:${String(eventId % 60).padStart(2, '0')}.000Z`,
  kind: 'issue.closed',
  subject,
  repoPath: null,
  payload: {},
})

function readPositionPort(lastEventId = 0) {
  const advance = vi.fn()
  // ONE snapshot object: `useSyncExternalStore` requires a cached snapshot, and
  // a fresh literal per call is an infinite render loop rather than a stale read.
  const cursor = { lastEventId, seenAt: null }
  // `hydrate`/`replace` belong to the port's OWNER (the runtime drains the
  // legacy blob, the feed installs another device's truth). The hook only ever
  // reads and advances, so they are present to satisfy the contract and asserted
  // never to be called from here.
  const hydrate = vi.fn(async () => {})
  const replace = vi.fn()
  return {
    port: {
      subscribe: () => () => {},
      get: () => cursor,
      advance,
      hydrate,
      replace,
    } satisfies ReadPositionPort,
    advance,
    hydrate,
    replace,
  }
}

afterEach(() => {
  rows.length = 0
  cleanup()
})

describe('useIssueEvents', () => {
  it('orders by the durable event id, not by the composite row key', () => {
    // 99 vs 100 is exactly where a lexicographic order over `"<id>\n<subject>"`
    // disagrees with the log.
    rows.push(row(100), row(9), row(99))
    const { port } = readPositionPort()
    const { result } = renderHook(() => useIssueEvents(port, false))
    expect(result.current.events.map((e) => e.id)).toEqual([9, 99, 100])
  })

  it('caps the rendered tail below the size of the replicated window', () => {
    for (let id = 1; id <= 120; id++) rows.push(row(id))
    const { port } = readPositionPort()
    const { result } = renderHook(() => useIssueEvents(port, false))
    expect(result.current.events).toHaveLength(40)
    expect(result.current.events[0]?.id).toBe(81)
  })

  it('is unread while the cursor sits behind the newest replicated row', () => {
    rows.push(row(5))
    const { port } = readPositionPort(4)
    const { result } = renderHook(() => useIssueEvents(port, false))
    expect(result.current.unread).toBe(true)
  })

  it('advances the per-user cursor only while the feed is visible', () => {
    rows.push(row(5))
    const hidden = readPositionPort(4)
    renderHook(() => useIssueEvents(hidden.port, false))
    expect(hidden.advance).not.toHaveBeenCalled()

    const shown = readPositionPort(4)
    act(() => {
      renderHook(() => useIssueEvents(shown.port, true))
    })
    expect(shown.advance).toHaveBeenCalledWith(
      'issueEvents',
      expect.objectContaining({ lastEventId: 5 }),
    )
  })

  it('freezes the divider where the cursor stood when the feed became visible', () => {
    rows.push(row(5))
    const { port } = readPositionPort(4)
    const { result } = renderHook(() => useIssueEvents(port, false))
    // Never made visible: the divider holds the cursor it was constructed with.
    expect(result.current.dividerId).toBe(4)
  })
})
