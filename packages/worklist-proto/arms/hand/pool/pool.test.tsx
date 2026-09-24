// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the pool's ingest, lifecycle and locals, on the 1x corpus
 * through a replay feed, with the reads fence on.
 *
 * POD-4580 (Ha3): the pool is lazy, so closed issues and their sessions are
 * cold after bootstrap. These tests work on the rows that stay resident (open
 * issues); the tick test first loads every row it looks at. The load window
 * never fires on its own here: a test closes it (`pool.hydrate()`).
 * `residency.test.tsx` owns the cold rows.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence, type ReadFence } from '../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '../../../shared/src/locals-source'
import { SCHEMA, tableColdRule } from '../../../shared/src/schema'
import type { RowView } from '../../../shared/src/row-view'
import type { SliceIssue } from '../../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type HandPoolHandle, handPoolArm } from './arm'
import type { HandPool } from './pool'
import { ENTITIES } from './tables'
import { FINISHED_GRACE_MS } from './views'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const corpus = buildCorpus(1)
/** Open issues: resident from bootstrap whatever else is. */
const openIssues = corpus.sliceIssues.filter((issue) => issue.closedAt == null)
/**
 * Resident from bootstrap: what the schema's rule keeps (the open issues, and
 * the closed ones the list can draw, POD-4665), over the corpus at the rig's
 * clock.
 */
const residentIssues = (() => {
  const issues = new Map(corpus.sliceIssues.map((issue) => [issue.id, issue]))
  const sessions = new Map(corpus.sliceSessions.map((session) => [session.sessionId, session]))
  const cold = tableColdRule(
    SCHEMA,
    (entity) => (entity === 'issue' ? issues : entity === 'session' ? sessions : undefined),
    corpus.fixedNow,
  )
  return corpus.sliceIssues.filter((issue) => !cold('issue', issue.id))
})()

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  reads: ReadFence
  handle: HandPoolHandle
  /** Feed subscriptions currently open (row source + locals). */
  listeners(): number
  push(event: RowSourceEvent): void
  dispose(): void
}

function rig(): Rig {
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  let open = 0
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
    row: (kind, id) => replay.source.row?.(kind, id),
    subscribe(listener) {
      open += 1
      const off = replay.source.subscribe(listener)
      return () => {
        open -= 1
        off()
      }
    },
  }
  const localsSource = {
    get: () => locals.source.get(),
    subscribe(listener: Parameters<typeof locals.source.subscribe>[0]) {
      open += 1
      const off = locals.source.subscribe(listener)
      return () => {
        open -= 1
        off()
      }
    },
  }
  const reads = createReadFence({ enabled: true })
  const handle = handPoolArm.create(reads.wrapSource(counted), localsSource, reads, {
    schedule: () => () => {},
  })
  return {
    replay,
    locals,
    reads,
    handle,
    listeners: () => open,
    push: (event) => replay.push(event),
    dispose: () => {
      handle.dispose()
      locals.dispose()
    },
  }
}

/** Subscribe to every issue's view, like mounted rows do; `views` is what each last saw. */
function observeAll(pool: HandPool): {
  views: Map<string, RowView | undefined>
  calls: Map<string, number>
  stop(): void
} {
  const views = new Map<string, RowView | undefined>()
  const calls = new Map<string, number>()
  const stops: (() => void)[] = []
  for (const id of pool.issueIds()) {
    views.set(id, pool.view(id))
    stops.push(
      pool.subscribe(id, () => {
        calls.set(id, (calls.get(id) ?? 0) + 1)
        views.set(id, pool.view(id))
      }),
    )
  }
  return {
    views,
    calls,
    stop: () => {
      for (const stop of stops) stop()
    },
  }
}

function issueRecord(id: string, patch: Partial<SliceIssue> = {}): RowRecord {
  const base = corpus.sliceIssues.find((issue) => issue.id === id)
  if (base === undefined) throw new Error(`no corpus issue ${id}`)
  return { kind: 'issue', id, value: { ...base, ...patch } }
}

/** Load every cold issue, then settle (the rows they read load too). */
function loadEverything(pool: HandPool): void {
  for (const id of pool.residency?.ids('issue') ?? []) pool.residency?.request('issue', id)
  pool.hydrate()
  pool.snapshot()
  expect(pool.residency?.size('issue')).toBe(0)
}

/** Every dependency-index entry, per index, that still names `id`. */
function readersNaming(pool: HandPool, id: string): string[] {
  const names: string[] = []
  for (const cells of pool.issues.values())
    for (const cell of cells.cells.values())
      if (cell.name.endsWith(`:${id}`)) names.push(`cell ${cell.name}`)
  for (const entity of ENTITIES)
    if (pool.rowReaders[entity].has(id)) names.push(`rows.${entity} ${id}`)
  if (pool.selection.has(id)) names.push(`selection ${id}`)
  if (pool.listeners.has(id)) names.push(`listeners ${id}`)
  for (const entity of ENTITIES)
    if (pool.records[entity].has(id)) names.push(`records.${entity} ${id}`)
  return names
}

describe('ingest', () => {
  it('bootstraps every resident row into its table and derives no row view until one is read', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const repos = new Set(corpus.sliceWorktrees.map((lane) => lane.repoId).filter(Boolean))
      // Hot plus cold is every row; the split itself is residency.test.tsx's.
      const cold = ENTITIES.map((entity) => pool.residency?.size(entity) ?? 0)
      expect(ENTITIES.map((entity, i) => pool.tables[entity].size + cold[i]!)).toEqual([
        corpus.sliceIssues.length,
        corpus.sliceSessions.length,
        corpus.sliceWorktrees.length,
        repos.size,
      ])
      expect(pool.tables.issue.size).toBe(residentIssues.length)
      expect(repos.size).toBeGreaterThan(0)
      // POD-4582: the worklist decides visibility at bootstrap (a `visible`
      // cell per resident issue) and ranks the visible rows, which reads
      // each one's `own` part and nothing else of its view.
      const visible = pool.order()
      expect(visible.length).toBeGreaterThan(0)
      expect([...pool.issues.keys()].sort()).toEqual([...visible].sort())
      for (const cells of pool.issues.values()) expect([...cells.cells.keys()]).toEqual(['own'])
      expect(pool.worklist.held('member')).toBe(residentIssues.length)
      expect(pool.stats.counters.cellsCreated - pool.stats.counters.cellsCollected).toBe(
        1 + visible.length + pool.worklist.cellCount() + pool.sessionCells.size,
      )
      expect(pool.stats.rowsDerived).toBe(0)
    } finally {
      r.dispose()
    }
  })

  it('stores the borrowed row object, and an unchanged row writes and notifies nothing', () => {
    const r = rig()
    const all = observeAll(r.handle.pool)
    try {
      const { pool } = r.handle
      const id = openIssues[3]!.id
      const stored = pool.tables.issue.get(id)
      expect(r.reads.isBorrowed(stored)).toBe(true)
      const before = all.views.get(id)
      pool.stats.reset()
      // The feed re-sends the very object it holds (a heartbeat-shaped no-op).
      r.push({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id,
            value: r.replay.source.snapshot('issue').find((row) => row.id === id)!.value,
          },
        ],
      })
      expect(pool.tables.issue.get(id)).toBe(stored)
      expect(pool.stats.counters.tableWrites).toBe(0)
      expect(pool.stats.notifications).toBe(0)
      expect(pool.stats.counters.cellRuns).toBe(0)
      expect(pool.stats.rowsDerived).toBe(0)
      expect(all.views.get(id)).toBe(before)
      expect(all.calls.size).toBe(0)
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('applies an update per row: only the changed row re-derives, changes identity and is told', () => {
    const r = rig()
    const all = observeAll(r.handle.pool)
    try {
      const { pool } = r.handle
      const id = openIssues.find((issue) => !issue.draft)!.id
      const before = new Map(all.views)
      pool.stats.reset()
      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Renamed by the test' })] })
      expect(pool.stats.notifications).toBe(1)
      expect(pool.stats.counters.tableWrites).toBe(1)
      expect(pool.stats.rowsDerived).toBe(1)
      expect(all.views.get(id)?.title).toBe('Renamed by the test')
      const changed = [...all.views]
        .filter(([key, view]) => before.get(key) !== view)
        .map(([key]) => key)
      expect(changed).toEqual([id])
      expect([...all.calls]).toEqual([[id, 1]])
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('replaces atomically: one commit, one call per listener, unchanged rows keep their objects, the rest leave', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const open = new Set(openIssues.map((issue) => issue.id))
      const keep = r.replay.source
        .snapshot('issue')
        .filter((row) => open.has(row.id))
        .slice(0, 5)
      const renamed = issueRecord(openIssues[7]!.id, { title: 'Reseeded' })
      const sessions = r.replay.source.snapshot('session').slice(0, 3)
      const lanes = r.replay.source.snapshot('worktree')
      const hotBefore = [pool.issueIds().length, pool.tables.session.size] as const
      // Kept sessions that were cold: their issue is not in the new slice, so
      // the re-partition makes them resident (installed: one write each).
      const warmed = sessions.filter((row) => pool.residency?.isCold('session', row.id)).length
      const seen: [number, number][] = [[...hotBefore]]
      const off = pool.subscribeIds(() => {
        seen.push([pool.issueIds().length, pool.tables.session.size])
      })
      const heldBefore = keep.map((row) => pool.tables.issue.get(row.id))
      pool.stats.reset()
      r.push({ type: 'replace', rows: [...sessions, ...keep, renamed, ...lanes] })
      off()
      expect(seen).toEqual([[...hotBefore], [6, 3]])
      expect(pool.stats.notifications).toBe(1)
      const heldAfter = keep.map((row) => pool.tables.issue.get(row.id))
      for (const [i, row] of heldAfter.entries()) expect(row).toBe(heldBefore[i])
      const removed = hotBefore[0] - 6 + hotBefore[1] - (3 - warmed)
      expect(pool.stats.counters.rowsRemoved).toBe(removed)
      // Every write was a removal, the one renamed row or a warmed session:
      // kept rows and lanes were not rewritten.
      expect(pool.stats.counters.tableWrites).toBe(removed + 1 + warmed)
      // The re-partition forgot every cold row the slice no longer names.
      expect(pool.residency?.size('issue')).toBe(0)
      expect(pool.residency?.size('session')).toBe(0)
    } finally {
      r.dispose()
    }
  })

  it('removes a row with its cells, record and index entries; a re-added row reaches its listener', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      // No spin-off points at it, so nothing else may keep a reference once it leaves.
      const origins = new Set(
        corpus.sliceIssues.flatMap((issue) => (issue.deps ?? []).map((dep) => dep.id)),
      )
      const id = openIssues.find((issue) => !issue.draft && !origins.has(issue.id))!.id
      const titles: (string | undefined)[] = [pool.view(id)?.title]
      const off = pool.subscribe(id, () => titles.push(pool.view(id)?.title))
      expect(pool.record('issue', id)?.title).toBe(titles[0])
      expect(readersNaming(pool, id).length).toBeGreaterThan(3)

      r.push({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      expect(pool.tables.issue.has(id)).toBe(false)
      expect(pool.stats.counters.rowsRemoved).toBe(1)
      // Freed: no cell, index entry or record names it; only the listener the test holds.
      expect(readersNaming(pool, id)).toEqual([`listeners ${id}`])
      expect(pool.issueIds()).not.toContain(id)

      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Back again' })] })
      off()
      expect(titles).toEqual([
        corpus.sliceIssues.find((issue) => issue.id === id)!.title,
        undefined,
        'Back again',
      ])
      expect(pool.issueIds()).toContain(id)
    } finally {
      r.dispose()
    }
  })

  it('re-seats a spin-off whose origin is evicted and re-added', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const open = new Set(openIssues.map((issue) => issue.id))
      const spinOff = openIssues.find((issue) =>
        (issue.deps ?? []).some((dep) => dep.type === 'discovered-from' && open.has(dep.id)),
      )!
      const originId = spinOff.deps!.find((dep) => dep.type === 'discovered-from')!.id
      const ticks: (string | null | undefined)[] = [pool.view(spinOff.id)?.originTick?.ref]
      expect(ticks[0]).toBeTruthy()
      const off = pool.subscribe(spinOff.id, () =>
        ticks.push(pool.view(spinOff.id)?.originTick?.ref ?? null),
      )
      r.push({ type: 'update', rows: [{ kind: 'issue', id: originId, value: undefined }] })
      r.push({ type: 'update', rows: [issueRecord(originId)] })
      r.push({ type: 'update', rows: [issueRecord(originId, { title: 'Origin renamed' })] })
      off()
      // Evicted: no tick. Re-added: the tick is back. Renamed: the spin-off redraws (its tick's title).
      expect(ticks).toEqual([ticks[0], null, ticks[0], ticks[0]])
      expect(pool.view(spinOff.id)?.originTick?.title).toBe('Origin renamed')
    } finally {
      r.dispose()
    }
  })

  it('derives a repo from its lanes: another lane takes over, and it leaves with its last lane', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      // A repo with one lane (the live-shaped fixture's small repos have
      // one; the feed adds root lanes). Add a second.
      const lane = corpus.sliceWorktrees.find(
        (candidate) =>
          candidate.repoId &&
          corpus.sliceWorktrees.filter((other) => other.repoId === candidate.repoId).length === 1,
      )!
      const repoId = lane.repoId!
      const second = { ...lane, path: `${lane.path}/.worktrees/second` }
      const issue = openIssues.find((candidate) => candidate.repoId === repoId)!
      const ref = pool.view(issue.id)?.displayRef
      expect(ref).toBe(`${lane.prefix}-${issue.seq}`)
      const refs: (string | undefined)[] = []
      const off = pool.subscribe(issue.id, () => refs.push(pool.view(issue.id)?.displayRef))
      r.push({ type: 'update', rows: [{ kind: 'worktree', id: second.path, value: second }] })
      // The newest lane holds the repo; removing it first makes the other take over.
      const holder = pool.tables.repo.get(repoId)
      expect(holder).toBe(pool.tables.worktree.get(second.path))
      for (const [i, path] of [second.path, lane.path].entries()) {
        r.push({ type: 'update', rows: [{ kind: 'worktree', id: path, value: undefined }] })
        expect(pool.tables.worktree.has(path)).toBe(false)
        expect(pool.tables.repo.has(repoId), `after lane ${i + 1} of 2`).toBe(i === 0)
      }
      off()
      // The prefix held while one lane was left, and went with the last.
      expect(refs).toEqual([`#${issue.seq}`])
      expect(pool.records.repo.has(repoId)).toBe(false)
      expect(r.handle.snapshot()).toEqual(r.handle.rebuildFromScratch())
    } finally {
      r.dispose()
    }
  })
})

describe('locals', () => {
  it('a click re-derives exactly the old and the new selection', () => {
    const r = rig()
    const all = observeAll(r.handle.pool)
    try {
      const [a, b] = openIssues.map((issue) => issue.id)
      r.locals.set({ selectedIssueId: a! })
      r.locals.flush()
      expect(all.views.get(a!)?.selected).toBe(true)
      r.handle.pool.stats.reset()
      all.calls.clear()
      r.locals.set({ selectedIssueId: b! })
      r.locals.flush()
      expect(r.handle.pool.stats.rowsDerived).toBe(2)
      expect(all.views.get(a!)?.selected).toBe(false)
      expect(all.views.get(b!)?.selected).toBe(true)
      expect([...all.calls.keys()].sort()).toEqual([a!, b!].sort())
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('a tick re-derives only the rows whose deadline it crosses, and a rewind undoes it', () => {
    const r = rig()
    loadEverything(r.handle.pool)
    const all = observeAll(r.handle.pool)
    try {
      const { pool } = r.handle
      const waiting = pool.clock.waiting
      expect(waiting).toBeGreaterThan(0)
      let crossings = pool.clock.crossings
      pool.stats.reset()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 })
      r.locals.flush()
      // Every re-derivation follows a crossing (a row reading two deadlines may
      // cross both, so crossings bound re-derivations from above).
      expect(pool.stats.rowsDerived).toBeLessThanOrEqual(pool.clock.crossings - crossings)
      const beforeGrace = new Map(all.views)
      crossings = pool.clock.crossings
      pool.stats.reset()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 + FINISHED_GRACE_MS })
      r.locals.flush()
      const changedIds = [...all.views]
        .filter(([id, view]) => beforeGrace.get(id) !== view)
        .map(([id]) => id)
      const graceTick = {
        rowsDerived: pool.stats.rowsDerived,
        viewsChanged: changedIds.length,
        crossings: pool.clock.crossings - crossings,
        cellRuns: pool.stats.counters.cellRuns,
      }
      expect(pool.stats.rowsDerived).toBeLessThanOrEqual(graceTick.crossings)
      expect(pool.stats.rowsDerived).toBeGreaterThan(0)
      expect(pool.stats.rowsDerived).toBeLessThan(corpus.sliceIssues.length / 4)
      expect(changedIds.length).toBeGreaterThan(0)
      // The rebuild at the new time agrees.
      expect(r.handle.snapshot()).toEqual(r.handle.rebuildFromScratch())

      // Rewind: the same rows go back.
      r.locals.set({ coarseNow: corpus.fixedNow })
      r.locals.flush()
      for (const id of changedIds) expect(all.views.get(id)?.closed, id).toBe(false)
      expect(r.handle.snapshot()).toEqual(r.handle.rebuildFromScratch())
      writeResult('hand-pool-tick-1x', {
        issues: corpus.sliceIssues.length,
        deadlinesWaitedOn: waiting,
        graceTick,
      })
    } finally {
      all.stop()
      r.dispose()
    }
  })
})

describe('dispose', () => {
  it('leaves no listener, no cell, no index entry and empty tables', async () => {
    const r = rig()
    const el = document.createElement('div')
    document.body.append(el)
    let unmount: () => void = () => {}
    await act(async () => {
      unmount = r.handle.mountWeb(el)
    })
    const { pool } = r.handle
    // POD-4582: the list draws the visible rows, in rank order.
    const visible = pool.order()
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(visible.length)
    const texts = [...el.querySelectorAll('[data-issue-row]')].map((row) => row.textContent ?? '')
    expect(texts.filter((text) => /^POD-\d+ /.test(text)).length).toBeGreaterThan(
      visible.length / 2,
    )
    expect(pool.listeners.size).toBe(visible.length)
    expect(pool.orderListeners.size).toBe(1)
    expect(pool.worklist.cellCount()).toBeGreaterThan(0)

    // A selection click reaches the mounted rows.
    const first = visible[0]!
    await act(async () => {
      r.locals.set({ selectedIssueId: first })
      r.locals.flush()
    })
    expect(el.querySelector(`[data-issue-row="${first}"]`)?.getAttribute('data-selected')).toBe(
      'true',
    )
    expect(r.listeners()).toBe(2)

    // Unmounting the list releases every per-key listener.
    await act(async () => {
      unmount()
    })
    expect(pool.listeners.size).toBe(0)
    expect(pool.orderListeners.size).toBe(0)

    await act(async () => {
      r.dispose()
    })
    expect(r.listeners()).toBe(0)
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(0)
    expect(ENTITIES.map((entity) => pool.tables[entity].size)).toEqual([0, 0, 0, 0])
    for (const entity of ENTITIES) {
      expect(pool.rowReaders[entity].size, entity).toBe(0)
      expect(pool.records[entity].size, entity).toBe(0)
    }
    expect(pool.issues.size).toBe(0)
    expect(pool.membership.size).toBe(0)
    expect(pool.coldness.size).toBe(0)
    expect(pool.coldRows.size).toBe(0)
    expect(pool.relationReaders.size).toBe(0)
    for (const entity of ENTITIES) expect(pool.presence[entity].size, entity).toBe(0)
    expect(pool.worklist.cellCount()).toBe(0)
    expect(pool.worklist.size).toBe(0)
    expect(pool.order()).toEqual([])
    expect(pool.residency?.size('issue')).toBe(0)
    expect(pool.residency?.size('session')).toBe(0)
    expect(pool.residency?.hasQueued()).toBe(false)
    expect(pool.selection.size).toBe(0)
    expect(pool.clock.waiting).toBe(0)
    expect(pool.clock.index.size).toBe(0)
    expect(pool.graph.pending).toBe(0)
    expect(pool.listeners.size).toBe(0)
    expect(pool.idsListeners.size).toBe(0)
    expect(pool.orderListeners.size).toBe(0)
    // After disposal the feed can publish; nothing listens.
    r.push({ type: 'update', rows: [issueRecord(first, { title: 'after dispose' })] })
    expect(pool.tables.issue.size).toBe(0)
    el.remove()
  })
})
