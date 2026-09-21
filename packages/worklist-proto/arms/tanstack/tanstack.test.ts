/**
 * POD-4448 — TanStack arm unit tests: indexes, rollup chains, visible
 * predicate, order, groups, lifecycle. Driven by a minimal in-test row
 * source (no engine): each test builds a tiny corpus, pushes RowSourceEvents,
 * and asserts stats + snapshots. The spec's worked example (§3.9) is the
 * anchor — every field asserted by hand from the text.
 */

import { describe, expect, it } from 'vitest'
import type { RowSource } from '../../shared/src/arm'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../shared/src/stats'
import { tanstackArm } from './arm'
import { TanStackStore } from './store'

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
    repoPath: '/podium',
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
    cwd: '/podium',
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

export function lane(partial: Partial<SliceWorktree> & { path: string }): SliceWorktree {
  return {
    repoId: 'r1',
    repoPath: '/podium',
    repoName: 'podium',
    prefix: 'POD',
    ...partial,
  }
}

export const row = (
  kind: RowRecord['kind'],
  id: string,
  value: SliceIssue | SliceSession | SliceWorktree | undefined,
): RowRecord => ({ kind, id, value })

export interface TestWorld {
  store: TanStackStore
  push(event: RowSourceEvent): void
}

export function testWorld(records: RowRecord[]): TestWorld {
  const rows = new Map<string, RowRecord>()
  for (const record of records) rows.set(`${record.kind}:${record.id}`, record)
  const listeners = new Set<(event: RowSourceEvent) => void>()
  const source: RowSource = {
    snapshot: (kind) => [...rows.values()].filter((r) => r.kind === kind),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const handle = tanstackArm.create(source, { selectedIssueId: null, coarseNow: NOW })
  const store = (handle as unknown as { store: TanStackStore }).store
  return {
    store,
    push: (event) => {
      for (const r of event.rows) {
        const key = `${r.kind}:${r.id}`
        if (r.value === undefined) rows.delete(key)
        else rows.set(key, r)
      }
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/** Spec §3.9 worked example: A (in_progress, s1 working + s3 resolved),
 *  B (review child of A, s2 waiting), C (done+tucked), D (archived). */
export function workedExample(): RowRecord[] {
  return [
    row('worktree', '/podium', lane({ path: '/podium' })),
    row('worktree', '/podium/wt-a', lane({ path: '/podium/wt-a' })),
    row(
      'issue',
      'A',
      issue({
        id: 'A',
        seq: 10,
        sortKey: 'a0',
        stage: 'in_progress',
        audience: 'human',
        worktreePath: '/podium/wt-a',
        title: 'Alpha',
      }),
    ),
    row(
      'issue',
      'B',
      issue({
        id: 'B',
        seq: 9,
        sortKey: 'b0',
        stage: 'review',
        audience: 'human',
        parentId: 'A',
        deps: [{ id: 'A', type: 'discovered-from' }],
        title: 'Beta',
      }),
    ),
    row(
      'issue',
      'C',
      issue({
        id: 'C',
        seq: 8,
        sortKey: 'c0',
        stage: 'done',
        closedReason: 'shipped',
        closedAt: iso(NOW - 2 * 3600000),
        tuckedAt: iso(NOW - 2 * 3600000),
        audience: 'human',
        title: 'Gamma',
      }),
    ),
    row('issue', 'D', issue({ id: 'D', seq: 7, sortKey: 'd0', archived: true, title: 'Delta' })),
    row(
      'session',
      's1',
      session({
        sessionId: 's1',
        issueId: 'A',
        lastActiveAt: iso(NOW - 120000),
        agentState: { phase: 'working', since: iso(NOW - 120000) },
      }),
    ),
    row(
      'session',
      's2',
      session({
        sessionId: 's2',
        issueId: 'B',
        lastActiveAt: iso(NOW - 20 * 60000),
        agentState: { phase: 'idle', since: iso(NOW - 20 * 60000) },
        offer: { createdAt: iso(NOW - 20 * 60000) },
      }),
    ),
    row(
      'session',
      's3',
      session({
        sessionId: 's3',
        cwd: '/podium/wt-a/sub',
        lastActiveAt: iso(NOW - 60000),
        agentState: { phase: 'working', since: iso(NOW - 60000) },
      }),
    ),
  ]
}

describe('tanstack arm: worked example (spec §3.9)', () => {
  it('summaries, order and groups match the spec text', () => {
    const world = testWorld(workedExample())
    const snap = world.store.snapshot()
    expect(Object.keys(snap.rowsById).sort()).toEqual(['A', 'B', 'C'])
    expect(snap.rowsById['A']).toEqual({
      id: 'A',
      displayRef: 'POD-10',
      title: 'Alpha',
      phase: 'waiting',
      progressDone: 0,
      progressTotal: 1,
      working: true,
      asking: true,
      band: 1,
      repoKey: 'r1',
      closed: false,
    })
    expect(snap.rowsById['B']).toEqual({
      id: 'B',
      displayRef: 'POD-9',
      title: 'Beta',
      phase: 'waiting',
      progressDone: 0,
      progressTotal: 1,
      working: false,
      asking: true,
      band: 1,
      repoKey: 'r1',
      closed: false,
    })
    expect(snap.rowsById['C']).toMatchObject({ id: 'C', displayRef: 'POD-8', closed: true })
    expect(snap.order.pinnedIds).toEqual([])
    expect(snap.order.groups).toEqual([
      { key: 'r1', label: 'podium', rowIds: ['A', 'B'], closedIds: ['C'] },
    ])
    // R-ORIGIN: B names A as its discovered-from origin.
    expect(world.store.rollup.ticks.get('B')).toEqual({
      id: 'A',
      seq: 10,
      title: 'Alpha',
      ref: 'POD-10',
    })
    world.store.dispose()
  })
})

describe('tanstack arm: indexes (add/move/remove)', () => {
  it('parent reassignment moves the child edge and both chains', () => {
    const world = testWorld(workedExample())
    world.store.stats.reset()
    world.push({
      type: 'update',
      rows: [row('issue', 'B', issue({ id: 'B', seq: 9, sortKey: 'b0', stage: 'review', audience: 'human', parentId: 'C', title: 'Beta' }))],
    })
    const snap = world.store.snapshot()
    // B left A's subtree: A loses the waiting offer, B keeps its own.
    expect(snap.rowsById['A']).toMatchObject({ phase: 'working', asking: false })
    expect(snap.rowsById['B']).toMatchObject({ phase: 'waiting', asking: true })
    expect(world.store.stats.indexUpdates).toBeGreaterThan(0)
    world.store.dispose()
  })

  it('evict drops the row and every seat holding it', () => {
    const world = testWorld(workedExample())
    world.push({ type: 'update', rows: [row('session', 's2', undefined)] })
    const snap = world.store.snapshot()
    // B loses its only session but keeps waiting on its own pending review
    // decision (review stage, unblocked, no continuation while sessionless).
    expect(snap.rowsById['B']).toMatchObject({ phase: 'waiting', asking: true })
    world.push({ type: 'update', rows: [row('issue', 'B', undefined)] })
    const after = world.store.snapshot()
    expect(Object.keys(after.rowsById).sort()).toEqual(['A', 'C'])
    // A loses the waiting subtree: s1 still works, nothing waits.
    expect(after.rowsById['A']).toMatchObject({ phase: 'working', asking: false })
    world.store.dispose()
  })

  it('shell and headless sessions never hold membership', () => {
    const world = testWorld(workedExample())
    world.push({
      type: 'update',
      rows: [
        row('session', 'sh', session({ sessionId: 'sh', issueId: 'C', agentKind: 'shell' })),
        row('session', 'hl', session({ sessionId: 'hl', issueId: 'C', headless: true })),
      ],
    })
    // C stays a closed-fold row; the excluded sessions change nothing.
    expect(world.store.snapshot().rowsById['C']).toMatchObject({ closed: true })
    world.store.dispose()
  })
})

describe('tanstack arm: rollup recursion', () => {
  it('change at depth 3 recomputes exactly the ancestor chain', () => {
    const records: RowRecord[] = [
      row('worktree', '/podium', lane({ path: '/podium' })),
      row('issue', 'R', issue({ id: 'R', seq: 4, stage: 'in_progress', audience: 'human', title: 'R' })),
      row('issue', 'P', issue({ id: 'P', seq: 3, stage: 'in_progress', audience: 'human', parentId: 'R', title: 'P' })),
      row('issue', 'L', issue({ id: 'L', seq: 2, stage: 'in_progress', audience: 'human', parentId: 'P', title: 'L' })),
      row('issue', 'S', issue({ id: 'S', seq: 1, stage: 'in_progress', audience: 'human', title: 'S' })),
      row(
        'session',
        'sL',
        session({
          sessionId: 'sL',
          issueId: 'L',
          agentState: { phase: 'working', since: iso(NOW - 60000) },
        }),
      ),
    ]
    const world = testWorld(records)
    expect(world.store.snapshot().rowsById['R']).toMatchObject({ phase: 'working' })
    const beforeS = world.store.rows.get('S')
    world.store.stats.reset()
    world.store.runs.reset()
    // Waiting offer lands on L: L, P, R flip to waiting; S is untouched.
    world.push({
      type: 'update',
      rows: [
        row(
          'session',
          'sL2',
          session({
            sessionId: 'sL2',
            issueId: 'L',
            agentState: { phase: 'idle', since: iso(NOW - 60000) },
            offer: { createdAt: iso(NOW - 60000) },
          }),
        ),
      ],
    })
    const snap = world.store.snapshot()
    expect(snap.rowsById['L']).toMatchObject({ phase: 'waiting', asking: true })
    expect(snap.rowsById['P']).toMatchObject({ phase: 'waiting', asking: true })
    expect(snap.rowsById['R']).toMatchObject({ phase: 'waiting', asking: true })
    expect(world.store.rows.get('S')).toBe(beforeS)
    // The chain recomputed (L + 2 ancestors); the sibling committed nothing.
    expect(world.store.stats.rowsDerived).toBe(3)
    expect(world.store.stats.rollupsDerived).toBeGreaterThanOrEqual(3)
    world.store.dispose()
  })
})

describe('tanstack arm: visible predicate', () => {
  it('keeps active-human sessionless rows, drops finished decay without keep', () => {
    const old = iso(NOW - 10 * 86400000)
    const world = testWorld([
      row('worktree', '/podium', lane({ path: '/podium' })),
      row(
        'issue',
        'live',
        issue({ id: 'live', seq: 3, stage: 'in_progress', audience: 'human', title: 'Live' }),
      ),
      row(
        'issue',
        'old',
        issue({
          id: 'old',
          seq: 2,
          stage: 'done',
          closedReason: 'shipped',
          closedAt: old,
          updatedAt: old,
          audience: 'human',
          parentId: 'live',
          readAt: old,
          title: 'Old',
        }),
      ),
      row(
        'issue',
        'prop',
        issue({ id: 'prop', seq: 1, stage: 'proposed', audience: 'human', title: 'Prop' }),
      ),
    ])
    const ids = Object.keys(world.store.snapshot().rowsById).sort()
    expect(ids).toEqual(['live'])
    world.store.dispose()
  })
})

describe('tanstack arm: order and groups', () => {
  it('bands, sort keys and pinned move-out', () => {
    const world = testWorld([
      row('worktree', '/podium', lane({ path: '/podium' })),
      row(
        'issue',
        'pin',
        issue({ id: 'pin', seq: 3, sortKey: 'z', pinned: true, title: 'Pin', readAt: null, unread: true }),
      ),
      row(
        'issue',
        'snz',
        issue({
          id: 'snz',
          seq: 2,
          deferUntil: iso(NOW + 3600000),
          title: 'Snz',
          readAt: null,
          unread: true,
        }),
      ),
      row(
        'issue',
        'mid',
        issue({ id: 'mid', seq: 1, sortKey: 'a', title: 'Mid', readAt: null, unread: true }),
      ),
      row(
        'session',
        's1',
        session({ sessionId: 's1', issueId: 'pin', agentState: { phase: 'working', since: iso(NOW - 60000) } }),
      ),
      row(
        'session',
        's2',
        session({ sessionId: 's2', issueId: 'snz', agentState: { phase: 'working', since: iso(NOW - 60000) } }),
      ),
      row(
        'session',
        's3',
        session({ sessionId: 's3', issueId: 'mid', agentState: { phase: 'working', since: iso(NOW - 60000) } }),
      ),
    ])
    const snap = world.store.snapshot()
    expect(snap.rowsById['pin']).toMatchObject({ band: 0 })
    expect(snap.rowsById['snz']).toMatchObject({ band: 2 })
    // Pinned moves out of its group, preserving order elsewhere.
    expect(snap.order.pinnedIds).toEqual(['pin'])
    expect(snap.order.groups).toEqual([
      { key: 'r1', label: 'podium', rowIds: ['mid', 'snz'], closedIds: [] },
    ])
    world.store.dispose()
  })
})

describe('tanstack arm: lifecycle', () => {
  it('replace reseeds atomically; removal disposes; dispose leaves zero listeners', () => {
    const world = testWorld(workedExample())
    const before = world.store.snapshot()
    expect(Object.keys(before.rowsById).length).toBe(3)
    world.push({
      type: 'replace',
      rows: [
        row('worktree', '/podium', lane({ path: '/podium' })),
        row(
          'issue',
          'only',
          issue({ id: 'only', seq: 1, stage: 'in_progress', audience: 'human', title: 'Only', readAt: null, unread: true }),
        ),
        row(
          'session',
          's9',
          session({ sessionId: 's9', issueId: 'only', agentState: { phase: 'working', since: iso(NOW - 60000) } }),
        ),
      ],
    })
    const after = world.store.snapshot()
    expect(Object.keys(after.rowsById)).toEqual(['only'])
    expect(after.rowsById['only']).toMatchObject({ phase: 'working', displayRef: 'POD-1' })
    expect(world.store.listenerCount()).toBe(0)
    world.store.dispose()
    expect(world.store.listenerCount()).toBe(0)
  })

  it('selection touches two keys and zero derivations', () => {
    const world = testWorld(workedExample())
    world.store.stats.reset()
    world.store.setSelection('A')
    expect(world.store.get('selected:A')).toBe(true)
    expect(world.store.get('selected:B')).toBe(false)
    expect(world.store.stats.rowsDerived).toBe(0)
    expect(world.store.stats.rollupsDerived).toBe(0)
    world.store.setSelection('B')
    expect(world.store.get('selected:A')).toBe(false)
    expect(world.store.get('selected:B')).toBe(true)
    world.store.dispose()
  })

  it('coarse tick flips only crossed bands', () => {
    const world = testWorld([
      row('worktree', '/podium', lane({ path: '/podium' })),
      row(
        'issue',
        'snz',
        issue({
          id: 'snz',
          seq: 1,
          deferUntil: iso(NOW + 30000),
          title: 'Snz',
          readAt: null,
          unread: true,
        }),
      ),
      row(
        'session',
        's1',
        session({ sessionId: 's1', issueId: 'snz', agentState: { phase: 'working', since: iso(NOW - 60000) } }),
      ),
    ])
    expect(world.store.snapshot().rowsById['snz']).toMatchObject({ band: 2 })
    world.store.stats.reset()
    world.store.setCoarseNow(NOW + 60000)
    expect(world.store.snapshot().rowsById['snz']).toMatchObject({ band: 0 })
    // The band flip recommits the row (band is a snapshot field).
    expect(world.store.stats.rowsDerived).toBe(1)
    world.store.dispose()
  })
})
