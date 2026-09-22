/**
 * POD-4447 — MobX arm unit tests: indexes, visible predicate, order, groups,
 * lifecycle. Driven by a minimal in-test row source (no engine): each test
 * builds a tiny corpus, pushes RowSourceEvents, and asserts snapshots.
 *
 * Derivation counters (`rowsDerived` / `rollupsDerived`) are
 * observation-driven — unobserved computeds suspend — so count assertions
 * belong in mounted tests (`mobx.ui.test.tsx`, the engine lanes). Here:
 * values plus the eager counters (`indexUpdates`, `notifications`).
 */

import { describe, expect, it } from 'vitest'
import type { RowSource } from '../../shared/src/arm'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../shared/src/stats'
import { mobxArm } from './arm'
import type { MobXStore } from './store'
import { fixedLocals } from '../../shared/src/locals-source'

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
  store: MobXStore
  push(event: RowSourceEvent): void
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
  const handle = mobxArm.create(source, fixedLocals({ selectedIssueId: null, coarseNow: NOW }).source) as unknown as {
    store: MobXStore
  }
  return {
    store: handle.store,
    push: (event) => {
      for (const row of event.rows) {
        const key = `${row.kind}:${row.id}`
        if (row.value === undefined) rows.delete(key)
        else rows.set(key, row)
      }
      for (const listener of [...listeners]) listener(event)
    },
  }
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

describe('mobx arm: slice shape', () => {
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

  it('heartbeat on an archived issue session moves no bucket and notifies once', () => {
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
    expect(world.store.stats.indexUpdates).toBe(0)
    expect(world.store.stats.notifications).toBe(1)
    expect(Object.keys(world.store.snapshot().rowsById).sort()).toEqual(['A', 'B', 'C'])
  })

  it('phase change on B recomputes the chain (A waiting -> working)', () => {
    const world = exampleWorld()
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
  })
})

describe('mobx arm: indexes', () => {
  it('moves a session between issues (R2) and drops it on remove', () => {
    const world = exampleWorld()
    world.push({
      type: 'update',
      rows: [rec('session', 's1', session({ sessionId: 's1', issueId: 'B', agentState: workingState }))],
    })
    expect(world.store.membersOf('A')).toEqual([])
    expect(world.store.membersOf('B').map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    world.push({ type: 'update', rows: [rec('session', 's1', undefined)] })
    expect(world.store.membersOf('B').map((s) => s.sessionId)).toEqual(['s2'])
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
    expect(world.store.membersOf('A').map((s) => s.sessionId)).toEqual(['s'])
    world.push({
      type: 'update',
      rows: [rec('session', 's', session({ sessionId: 's', cwd: '/w/alpha-fork/x', agentState: workingState }))],
    })
    expect(world.store.membersOf('A')).toEqual([])
  })

  it('re-resolves unbound sessions when an issue gains a worktreePath (R3)', () => {
    const world = testWorld([
      rec('issue', 'A', issue({ id: 'A' })),
      rec(
        'session',
        's',
        session({ sessionId: 's', cwd: '/w/alpha/sub', agentState: workingState }),
      ),
      rec('worktree', '/w/alpha', { path: '/w/alpha', repoId: 'r1', repoPath: '/repo', repoName: 'repo', prefix: 'POD' }),
    ])
    expect(world.store.membersOf('A')).toEqual([])
    world.store.stats.reset()
    world.push({
      type: 'update',
      rows: [rec('issue', 'A', issue({ id: 'A', worktreePath: '/w/alpha' }))],
    })
    expect(world.store.membersOf('A').map((s) => s.sessionId)).toEqual(['s'])
    expect(world.store.stats.indexUpdates).toBeGreaterThan(0)
  })

  it('re-buckets children on parent moves, orphans surface as roots', () => {
    const world = exampleWorld()
    world.push({
      type: 'update',
      rows: [rec('issue', 'B', issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: null, stage: 'review' }))],
    })
    expect(world.store.parentOf.get('B')).toBeUndefined()
    // A stands alone and becomes its own unit.
    expect(world.store.snapshot().rowsById['A']?.progressTotal).toBe(1)
    expect(world.store.snapshot().rowsById['A']?.progressDone).toBe(0)
  })

  it('tracks the discovered-from origin tick (R4)', () => {
    const world = exampleWorld()
    expect(world.store.issues.get('B')?.tick).toBeNull()
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
    expect(world.store.issues.get('B')?.tick).toMatchObject({ id: 'A', ref: 'POD-10' })
  })
})

describe('mobx arm: visible, order, groups', () => {
  it('keeps sessionless active human rows, drops the rest', () => {
    const world = testWorld([
      rec('issue', 'active', issue({ id: 'active', stage: 'in_progress' })),
      rec('issue', 'backlog', issue({ id: 'backlog', stage: 'backlog' })),
      rec('worktree', '/wt', LANE),
    ])
    expect(Object.keys(world.store.snapshot().rowsById)).toEqual(['active'])
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
    // Evicting the leaf drops the rescue row with it (its keeper is gone).
    world.push({ type: 'update', rows: [rec('issue', 'leaf', undefined)] })
    expect(world.store.snapshot().rowsById['mid']).toBeUndefined()
    expect(world.store.snapshot().rowsById['leaf2']).toBeDefined()
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
  })
})

describe('mobx arm: locals + lifecycle', () => {
  it('selection latches the clicked lane (counts: see ui test)', () => {
    const world = exampleWorld()
    world.store.setSelection('B')
    expect(world.store.locals.selectedIssueId).toBe('B')
    expect(world.store.locals.selectedIssueWasFolded).toBe(false)
    // Bare store: laneOf reads unobserved computeds, so bodies execute here.
    // The mounted 2-rows-0-derivations contract lives in mobx.ui.test.tsx,
    // where the list observes everything and laneOf reads cached values.
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
  })

  it('removal disposes buckets; dispose detaches and clears', () => {
    const world = exampleWorld()
    world.push({ type: 'update', rows: [rec('issue', 'A', undefined)] })
    expect(world.store.snapshot().rowsById['A']).toBeUndefined()
    // B orphaned by A's removal surfaces as a root, still visible.
    expect(world.store.snapshot().rowsById['B']?.phase).toBe('waiting')
    expect(world.store.issues.has('A')).toBe(false)
    expect(world.store.parentOf.get('B')).toBeUndefined()
    world.store.dispose()
    expect(world.store.issues.size).toBe(0)
    expect(world.store.sessions.size).toBe(0)
    // Pushes after dispose are inert (source detached, tables cleared).
    world.push({ type: 'update', rows: [rec('issue', 'Q', issue({ id: 'Q' }))] })
    expect(world.store.issues.size).toBe(0)
    expect(Object.keys(world.store.snapshot().rowsById)).toEqual([])
  })

  it('implements shared/src/arm.ts', () => {
    expect(mobxArm.create).toBeTypeOf('function')
  })
})
