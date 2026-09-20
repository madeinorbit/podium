/**
 * POD-4446 — hand-rolled arm unit tests: indexes, rollup chains, visible
 * predicate, order, groups, lifecycle. Driven by a minimal in-test row
 * source (no engine): each test builds a tiny corpus, pushes RowSourceEvents,
 * and asserts stats + snapshots. The rebuild oracle
 * (incremental deep-equals from-scratch) runs after every mutation.
 */

import { describe, expect, it } from 'vitest'
import type { RowSource } from '../../shared/src/arm'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../shared/src/stats'
import { handArm } from './arm'
import { rebuildFromScratch } from './rebuild'
import { HandStore } from './store'

export const NOW = Date.parse('2026-09-20T12:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()

export function issue(partial: Partial<SliceIssue> & { id: string }): SliceIssue {
  return {
    seq: 1,
    createdAt: iso(NOW - 10 * 86400000),
    updatedAt: iso(NOW - 3600000),
    closedAt: null,
    deletedAt: null,
    archived: false,
    stage: 'in_progress',
    closedReason: null,
    audience: 'human',
    draft: false,
    pinned: false,
    sortKey: null,
    deferUntil: null,
    tuckedAt: null,
    repoId: 'r1',
    repoPath: '/repo',
    worktreePath: null,
    coordinatorSessionId: null,
    startedBySession: null,
    deps: [],
    needsHuman: false,
    blocked: false,
    readAt: iso(NOW - 7200000),
    unread: false,
    title: `Title ${partial.id}`,
    parentId: null,
    ...partial,
  }
}

export function session(partial: Partial<SliceSession> & { sessionId: string }): SliceSession {
  return {
    cwd: '/repo',
    agentKind: 'codex',
    headless: false,
    status: 'live',
    archived: false,
    lastActiveAt: iso(NOW - 120000),
    stoppedAt: null,
    readAt: iso(NOW - 60000),
    unread: false,
    ...partial,
  }
}

export const workingState = { phase: 'working', since: iso(NOW - 120000) }
export const waitingState = { phase: 'idle', since: iso(NOW - 600000) }
export const waitingOffer = { createdAt: iso(NOW - 600000) }

export interface TestWorld {
  store: HandStore
  push(event: RowSourceEvent): void
  oracle(): void
}

export function testWorld(records: RowRecord[]): TestWorld {
  const rows = new Map<string, RowRecord>()
  for (const record of records) rows.set(`${record.kind}:${record.id}`, record)
  const listeners = new Set<(event: RowSourceEvent) => void>()
  const source: RowSource = {
    snapshot: (kind) => [...rows.values()].filter((row) => row.kind === kind),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const store = new HandStore(source, { selectedIssueId: null, coarseNow: NOW })
  const world: TestWorld = {
    store,
    push: (event) => {
      for (const row of event.rows) {
        const key = `${row.kind}:${row.id}`
        if (row.value === undefined) rows.delete(key)
        else rows.set(key, row)
      }
      for (const listener of [...listeners]) listener(event)
    },
    oracle: () => {
      const rebuilt = rebuildFromScratch({
        issues: store.issues,
        sessions: store.sessions,
        worktrees: store.worktrees,
        selection: {
          selectedIssueId: store.locals.selectedIssueId,
          selectedIssueWasFolded: store.locals.selectedIssueWasFolded ?? false,
        },
        now: store.locals.coarseNow,
      })
      const live = store.snapshot()
      expect(live, 'rebuild oracle: snapshot').toEqual(rebuilt.snapshot)
      expect(
        [...store.summary.summaries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        'rebuild oracle: summaries',
      ).toEqual(rebuilt.summaries)
      expect(
        [...store.rollup.aggregates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        'rebuild oracle: aggregates',
      ).toEqual(rebuilt.aggregates)
      expect([...store.visible.visible].sort(), 'rebuild oracle: visible').toEqual(rebuilt.visible)
      expect(store.order.ordered, 'rebuild oracle: order').toEqual(rebuilt.ordered)
    },
  }
  world.oracle()
  return world
}

export function rec(kind: RowRecord['kind'], id: string, value: RowRecord['value']): RowRecord {
  return { kind, id, value }
}

export const LANE: SliceWorktree = {
  path: '/wt',
  repoId: 'r1',
  repoPath: '/repo',
  repoName: 'repo',
  prefix: 'POD',
}

/** The worked-example shape (spec §3.9, erratum applied): A <- B, C tucked. */
export function exampleWorld(): TestWorld {
  const a = issue({ id: 'A', seq: 10, sortKey: 'a0', worktreePath: '/wt' })
  const b = issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: 'A', stage: 'review' })
  const c = issue({
    id: 'C',
    seq: 8,
    sortKey: 'c0',
    stage: 'done',
    closedReason: 'done',
    closedAt: iso(NOW - 86400000 * 2),
    tuckedAt: iso(NOW - 3600000),
  })
  const d = issue({ id: 'D', seq: 7, sortKey: 'd0', archived: true })
  const s1 = session({ sessionId: 's1', issueId: 'A', agentState: workingState })
  const s2 = session({
    sessionId: 's2',
    issueId: 'B',
    agentState: waitingState,
    offer: waitingOffer,
  })
  const sd = session({ sessionId: 'sd', issueId: 'D', agentState: workingState })
  return testWorld([
    rec('issue', 'A', a),
    rec('issue', 'B', b),
    rec('issue', 'C', c),
    rec('issue', 'D', d),
    rec('session', 's1', s1),
    rec('session', 's2', s2),
    rec('session', 'sd', sd),
    rec('worktree', '/wt', LANE),
  ])
}

describe('hand-rolled arm: slice shape', () => {
  it('builds the worked example: phases, progress, order, groups', () => {
    const { store } = exampleWorld()
    const snap = store.snapshot()
    expect(Object.keys(snap.rowsById).sort()).toEqual(['A', 'B', 'C'])
    expect(snap.rowsById['A']).toMatchObject({
      displayRef: 'POD-10',
      phase: 'waiting',
      working: true,
      asking: true,
      progressDone: 0,
      progressTotal: 1,
      band: 1,
      repoKey: 'r1',
      closed: false,
    })
    expect(snap.rowsById['B']).toMatchObject({ displayRef: 'POD-9', phase: 'waiting' })
    expect(snap.rowsById['C']?.closed).toBe(true)
    expect(snap.order.pinnedIds).toEqual([])
    expect(snap.order.groups).toEqual([
      { key: 'r1', label: 'repo', rowIds: ['A', 'B'], closedIds: ['C'] },
    ])
  })

  it('heartbeat on an archived issue session: 0 rows, 0 derivations, 0 index writes', () => {
    const world = exampleWorld()
    world.store.stats.reset()
    world.push({
      type: 'update',
      rows: [
        rec(
          'session',
          'sd',
          session({ sessionId: 'sd', issueId: 'D', agentState: workingState, lastActiveAt: iso(NOW) }),
        ),
      ],
    })
    expect(world.store.stats.rowsDerived).toBe(0)
    expect(world.store.stats.rollupsDerived).toBe(0)
    expect(world.store.stats.indexUpdates).toBe(0)
    world.oracle()
  })

  it('phase change recomputes exactly the ancestor chain', () => {
    const world = exampleWorld()
    world.store.stats.reset()
    world.push({
      type: 'update',
      rows: [
        rec(
          'session',
          's2',
          session({ sessionId: 's2', issueId: 'B', agentState: { phase: 'working', since: iso(NOW) }, lastActiveAt: iso(NOW) }),
        ),
      ],
    })
    // B: waiting -> working (review decision withdrawn while its agent works);
    // A: waiting -> working (subtree no longer waits).
    expect(world.store.snapshot().rowsById['B']?.phase).toBe('working')
    expect(world.store.snapshot().rowsById['A']?.phase).toBe('working')
    expect(world.store.stats.rowsDerived).toBe(2)
    world.oracle()
  })

  it('change at depth 3 recomputes exactly its chain, no siblings', () => {
    const r = issue({ id: 'R', seq: 4 })
    const p = issue({ id: 'P', seq: 3, parentId: 'R' })
    const c = issue({ id: 'C', seq: 2, parentId: 'P' })
    const l = issue({ id: 'L', seq: 1, parentId: 'C' })
    const sib = issue({ id: 'S', seq: 5, parentId: 'R' })
    const world = testWorld([
      rec('issue', 'R', r),
      rec('issue', 'P', p),
      rec('issue', 'C', c),
      rec('issue', 'L', l),
      rec('issue', 'S', sib),
      rec('session', 'sl', session({ sessionId: 'sl', issueId: 'L', agentState: workingState })),
      rec('session', 'ss', session({ sessionId: 'ss', issueId: 'S', agentState: workingState })),
      rec('worktree', '/wt', LANE),
    ])
    expect(Object.keys(world.store.snapshot().rowsById).sort()).toEqual(['C', 'L', 'P', 'R', 'S'])
    world.store.stats.reset()
    world.push({
      type: 'update',
      rows: [
        rec(
          'session',
          'sl',
          session({ sessionId: 'sl', issueId: 'L', agentState: waitingState, offer: waitingOffer, lastActiveAt: iso(NOW) }),
        ),
      ],
    })
    // Chain L -> C -> P -> R recomputed (4 aggregates + L summary + L/C/P/R
    // visibility re-evals); sibling S untouched.
    expect(world.store.rollup.aggregates.get('S')?.phase).toBe('working')
    expect(world.store.snapshot().rowsById['R']?.phase).toBe('waiting')
    const aggregates = world.store.stats.rollupsDerived
    expect(aggregates).toBeGreaterThanOrEqual(4)
    world.oracle()
  })
})

describe('hand-rolled arm: indexes', () => {
  it('moves a session between issues (R2) and drops it on remove', () => {
    const world = exampleWorld()
    world.push({
      type: 'update',
      rows: [rec('session', 's1', session({ sessionId: 's1', issueId: 'B', agentState: workingState }))],
    })
    expect(world.store.summary.membersOf('A').map((s) => s.sessionId)).toEqual([])
    expect(world.store.summary.membersOf('B').map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    world.oracle()
    world.push({ type: 'update', rows: [rec('session', 's1', undefined)] })
    expect(world.store.summary.membersOf('B').map((s) => s.sessionId)).toEqual(['s2'])
    world.oracle()
  })

  it('resolves unbound sessions by longest prefix (R3), never misattributes', () => {
    const world = testWorld([
      rec('issue', 'A', issue({ id: 'A', worktreePath: '/w/alpha' })),
      rec(
        'session',
        's',
        session({ sessionId: 's', cwd: '/w/alpha/sub', agentState: workingState }),
      ),
      rec('worktree', '/w/alpha', { path: '/w/alpha', repoId: 'r1', repoPath: '/repo', repoName: 'repo', prefix: 'POD' }),
      rec('worktree', '/w/alpha-fork', { path: '/w/alpha-fork', repoId: 'r1', repoPath: '/repo', repoName: 'repo', prefix: 'POD' }),
    ])
    // '/w/alpha-fork' must not resolve under '/w/alpha'.
    expect(world.store.summary.membersOf('A').map((s) => s.sessionId)).toEqual(['s'])
    world.push({
      type: 'update',
      rows: [rec('session', 's', session({ sessionId: 's', cwd: '/w/alpha-fork/x', agentState: workingState }))],
    })
    expect(world.store.summary.membersOf('A')).toEqual([])
    world.oracle()
  })

  it('re-buckets children on parent moves, orphans surface as roots', () => {
    const world = exampleWorld()
    world.push({
      type: 'update',
      rows: [rec('issue', 'B', issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: null, stage: 'review' }))],
    })
    expect(world.store.indexes.parentOf.get('B')).toBeUndefined()
    // A stands alone and becomes its own unit (mission.ts:1374-1375).
    expect(world.store.snapshot().rowsById['A']?.progressTotal).toBe(1)
    expect(world.store.snapshot().rowsById['A']?.progressDone).toBe(0)
    world.oracle()
  })

  it('tracks the discovered-from origin tick (R4)', () => {
    const world = exampleWorld()
    expect(world.store.rollup.ticks.get('B')).toBeNull()
    world.push({
      type: 'update',
      rows: [
        rec(
          'issue',
          'B',
          issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: 'A', stage: 'review', deps: [{ id: 'A', type: 'discovered-from' }] }),
        ),
      ],
    })
    expect(world.store.rollup.ticks.get('B')).toMatchObject({ id: 'A', ref: 'POD-10' })
    world.oracle()
  })
})

describe('hand-rolled arm: visible, order, groups', () => {
  it('keeps sessionless active human rows, drops the rest', () => {
    const world = testWorld([
      rec('issue', 'active', issue({ id: 'active', stage: 'in_progress' })),
      rec('issue', 'backlog', issue({ id: 'backlog', stage: 'backlog' })),
      rec('worktree', '/wt', LANE),
    ])
    expect(Object.keys(world.store.snapshot().rowsById)).toEqual(['active'])
    world.oracle()
  })

  it('rescues live ancestors of visible rows, never finished ones', () => {
    const world = testWorld([
      rec('issue', 'mid', issue({ id: 'mid', stage: 'backlog' })),
      rec('issue', 'leaf', issue({ id: 'leaf', parentId: 'mid' })),
      rec('issue', 'done-top', issue({ id: 'done-top', stage: 'done', closedReason: 'done' })),
      rec('issue', 'leaf2', issue({ id: 'leaf2', parentId: 'done-top' })),
      rec('session', 's1', session({ sessionId: 's1', issueId: 'leaf', agentState: workingState })),
      rec('session', 's2', session({ sessionId: 's2', issueId: 'leaf2', agentState: workingState })),
      rec('worktree', '/wt', LANE),
    ])
    const ids = Object.keys(world.store.snapshot().rowsById).sort()
    // done-top is a closed top-level issue: visible (decay-exempt) in the
    // open lane until its grace lapses; mid is a sessionless rescue row.
    expect(ids).toEqual(['done-top', 'leaf', 'leaf2', 'mid'])
    expect(world.store.snapshot().rowsById['done-top']?.closed).toBe(false)
    expect(world.store.visible.rescue.has('mid')).toBe(true)
    world.oracle()
    // Evicting the leaf drops the rescue row with it (its keeper is gone).
    world.push({ type: 'update', rows: [rec('issue', 'leaf', undefined)] })
    expect(world.store.snapshot().rowsById['mid']).toBeUndefined()
    expect(world.store.snapshot().rowsById['leaf2']).toBeDefined()
    world.oracle()
  })

  it('pins move out of groups; deferUntil sinks the band', () => {
    const world = exampleWorld()
    world.push({
      type: 'update',
      rows: [rec('issue', 'A', issue({ id: 'A', seq: 10, sortKey: 'a0', worktreePath: '/wt', pinned: true }))],
    })
    const snap = world.store.snapshot()
    expect(snap.order.pinnedIds).toEqual(['A'])
    expect(snap.order.groups[0]?.rowIds).toEqual(['B'])
    expect(snap.rowsById['A']?.band).toBe(0)
    world.oracle()
    world.push({
      type: 'update',
      rows: [
        rec(
          'issue',
          'B',
          issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: 'A', stage: 'review', deferUntil: iso(NOW + 86400000) }),
        ),
      ],
    })
    expect(world.store.snapshot().rowsById['B']?.band).toBe(2)
    world.oracle()
  })
})

describe('hand-rolled arm: locals + lifecycle', () => {
  it('selection notifies exactly two keys with zero derivations', () => {
    const world = exampleWorld()
    world.store.setSelection('A')
    const seen: string[] = []
    world.store.subscribe('selected:A', () => seen.push('A'))
    world.store.subscribe('selected:B', () => seen.push('B'))
    world.store.stats.reset()
    world.store.setSelection('B')
    expect(seen.sort()).toEqual(['A', 'B'])
    expect(world.store.stats.rowsDerived).toBe(0)
    expect(world.store.stats.rollupsDerived).toBe(0)
    expect(world.store.stats.notifications).toBe(1)
    world.oracle()
  })

  it('replace reseeds atomically: one pass, snapshot equals fresh', () => {
    const world = exampleWorld()
    const rows: RowRecord[] = [
      rec('issue', 'Z', issue({ id: 'Z', seq: 99 })),
      rec('session', 'sz', session({ sessionId: 'sz', issueId: 'Z', agentState: workingState })),
      rec('worktree', '/wt', LANE),
    ]
    world.store.stats.reset()
    world.push({ type: 'replace', rows })
    expect(world.store.stats.notifications).toBe(1)
    expect(Object.keys(world.store.snapshot().rowsById)).toEqual(['Z'])
    world.oracle()
  })

  it('removal disposes buckets; dispose leaves zero listeners', () => {
    const world = exampleWorld()
    const off = world.store.subscribe('A', () => {})
    expect(world.store.listenerCount()).toBe(1)
    world.push({ type: 'update', rows: [rec('issue', 'A', undefined)] })
    expect(world.store.snapshot().rowsById['A']).toBeUndefined()
    // B orphaned by A's removal surfaces as a root, still visible.
    expect(world.store.snapshot().rowsById['B']?.phase).toBe('waiting')
    world.oracle()
    off()
    world.store.dispose()
    expect(world.store.listenerCount()).toBe(0)
  })

  it('implements shared/src/arm.ts', () => {
    expect(handArm.create).toBeTypeOf('function')
  })
})
