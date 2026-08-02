import { asIssueId, asSessionId, type IssueWire, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  elevateCoordinatorSession,
  isCoordinatorSession,
  orderTabs,
  orphanSessionFor,
  pickPaneSession,
  planWorktreeMoves,
} from './terminal'

// ---------------------------------------------------------------------------
// POD-330 — the TERMINAL slice.
//
// The workspace is where a partial world is most likely to be misread, because
// every one of these functions is handed an ID that may no longer resolve: a
// coordinator, a pane, a saved tab order. Under the scoped feed (POD-1077) that
// id may name a session which still EXISTS but is no longer visible to this
// principal. The tests below pin the three behaviours that follow from it:
//
//   1. a dangling id is a no-op, never an error and never a placeholder tab;
//   2. a session that leaves the replica leaves the tab strip cleanly — no
//      tombstone, no removal state, nothing to heal;
//   3. an eviction is not a RELOCATION: it must not surface as a worktree move.
// ---------------------------------------------------------------------------

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo/a',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

const ids = (list: readonly SessionMeta[]) => list.map((s) => s.sessionId)

describe('orderTabs', () => {
  const a = session('a')
  const b = session('b')
  const c = session('c')

  it('follows the saved manual order, appending unknown tabs in arrival order', () => {
    expect(ids(orderTabs([a, b, c], ['c', 'a']))).toEqual(['c', 'a', 'b'])
  })

  it('lifts the coordinator to the front even when a stale saved order buries it', () => {
    expect(ids(orderTabs([a, b, c], ['c', 'a', 'b'], 'b'))).toEqual(['b', 'c', 'a'])
  })

  it('is a NO-OP for a coordinator id that resolves to no visible session', () => {
    // The coordinator was evicted (or has not arrived). The strip is the two
    // sessions we can see, in their own order — not a gap, not a placeholder.
    expect(ids(orderTabs([a, b], ['a', 'b'], 'gone'))).toEqual(['a', 'b'])
    expect(ids(elevateCoordinatorSession([a, b], 'gone'))).toEqual(['a', 'b'])
    expect(ids(elevateCoordinatorSession([a, b], null))).toEqual(['a', 'b'])
  })

  it('drops an evicted session from the strip with nothing standing in for it', () => {
    const before = orderTabs([a, b, c], ['a', 'b', 'c'])
    const after = orderTabs([a, c], ['a', 'b', 'c'])
    expect(ids(before)).toEqual(['a', 'b', 'c'])
    expect(ids(after)).toEqual(['a', 'c'])
    // The saved order still NAMES b. That is not a tombstone and must not
    // produce one: the strip is exactly the sessions that are here.
    expect(after).toHaveLength(2)
  })

  it('leaves the order untouched when there is no manual order', () => {
    expect(ids(orderTabs([b, a], undefined))).toEqual(['b', 'a'])
    expect(ids(orderTabs([b, a], []))).toEqual(['b', 'a'])
  })
})

describe('isCoordinatorSession', () => {
  const issue = { coordinatorSessionId: 'a' } as Pick<IssueWire, 'coordinatorSessionId'>
  it('is true only for the designated session', () => {
    expect(isCoordinatorSession(issue, asSessionId('a'))).toBe(true)
    expect(isCoordinatorSession(issue, asSessionId('b'))).toBe(false)
    expect(
      isCoordinatorSession({} as Pick<IssueWire, 'coordinatorSessionId'>, asSessionId('a')),
    ).toBe(false)
  })
})

describe('pickPaneSession', () => {
  const a = session('a', { lastActiveAt: '2026-07-01T00:00:00.000Z' })
  const b = session('b', { lastActiveAt: '2026-07-05T00:00:00.000Z' })

  it('keeps the current pane when it is still a member', () => {
    expect(pickPaneSession([a, b], asSessionId('a'))).toBe('a')
  })

  it('keeps the current pane when it is a file tab rather than a session', () => {
    expect(pickPaneSession([a, b], asSessionId('file:README.md'), ['file:README.md'])).toBe(
      'file:README.md',
    )
  })

  it('re-picks the most recently active member when the pane is no longer visible', () => {
    // `paneA` names a session that left the replica. Re-pick; do not hold the
    // pane open on an id that will never resolve.
    expect(pickPaneSession([a, b], asSessionId('evicted'))).toBe('b')
  })

  it('returns null for an empty row so the caller shows its picker', () => {
    expect(pickPaneSession([], asSessionId('a'))).toBeNull()
  })
})

describe('orphanSessionFor', () => {
  const paths = { cwd: '/repo/gone' }
  const a = session('a', paths)
  const b = session('b', { cwd: '/repo/gone/src' })

  it('prefers the session already in pane A', () => {
    expect(orphanSessionFor({ selectedWorktree: '/repo/gone', sessions: [a, b], paneA: 'b' })?.sessionId).toBe('b')
  })

  it('falls back to the first orphan, including one stamped with a subdirectory', () => {
    expect(orphanSessionFor({ selectedWorktree: '/repo/gone', sessions: [b], paneA: null })?.sessionId).toBe('b')
  })

  it('is null with no selection or no orphans', () => {
    expect(orphanSessionFor({ selectedWorktree: null, sessions: [a], paneA: null })).toBeNull()
    expect(
      orphanSessionFor({ selectedWorktree: '/repo/gone', sessions: [session('c', { cwd: '/other' })], paneA: null }),
    ).toBeNull()
  })
})

describe('planWorktreeMoves', () => {
  const worktreePaths = ['/repo/a', '/repo/b']

  it('FOLLOWS a visible pane out of the selected worktree', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo/a' },
      sessions: [session('s1', { cwd: '/repo/b' })],
      worktreePaths,
      selectedWorktree: '/repo/a',
      visiblePanes: ['s1'],
    })
    expect(plan.follow).toBe('/repo/b')
    expect(plan.moved).toEqual([])
  })

  it('reports a background move instead of yanking the view', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo/a' },
      sessions: [session('s1', { cwd: '/repo/b' })],
      worktreePaths,
      selectedWorktree: '/repo/a',
      visiblePanes: [],
    })
    expect(plan.follow).toBeNull()
    expect(plan.moved).toEqual([{ sessionId: 's1', from: '/repo/a', to: '/repo/b' }])
  })

  it('treats a subdirectory cd as no move at all', () => {
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo/a' },
      sessions: [session('s1', { cwd: '/repo/a/src/deep' })],
      worktreePaths,
      selectedWorktree: '/repo/a',
      visiblePanes: ['s1'],
    })
    expect(plan).toEqual({ follow: null, moved: [] })
  })

  it('never treats a first-sight session as a move', () => {
    const plan = planWorktreeMoves({
      prevCwds: {},
      sessions: [session('s1', { cwd: '/repo/b' })],
      worktreePaths,
      selectedWorktree: '/repo/a',
      visiblePanes: ['s1'],
    })
    expect(plan).toEqual({ follow: null, moved: [] })
  })

  it('an EVICTED session is not a move — it left the replica, it did not relocate', () => {
    // s1 was in /repo/a last snapshot and is simply absent now. A "moved to
    // nowhere" toast, or a follow to null, would both be reading an eviction as
    // a relocation.
    const plan = planWorktreeMoves({
      prevCwds: { s1: '/repo/a' },
      sessions: [],
      worktreePaths,
      selectedWorktree: '/repo/a',
      visiblePanes: ['s1'],
    })
    expect(plan).toEqual({ follow: null, moved: [] })
  })
})
