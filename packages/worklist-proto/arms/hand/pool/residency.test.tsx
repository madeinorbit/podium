// @vitest-environment happy-dom
/**
 * POD-4580 (Ha3) — residency on the 1x corpus through a replay feed, reads
 * fence on: the hot/cold split at bootstrap (by count), cells and records
 * built on first read with the list mounted, the 50 ms batch loader, lazy
 * relations with their pending marker, and every transition `residency.ts`
 * names. The rule is restated here from the schema doc §5, not taken from the
 * code under test.
 */

import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import type { RowSource } from '../../../shared/src/arm'
import {
  createReadFence,
  DISABLED_READ_FENCE,
  type ReadFence,
} from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import type { RowView } from '../../../shared/src/row-view'
import { SCHEMA, tableColdRule } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type HandPoolHandle, handPoolArm } from './arm'
import { type Cell, sameData } from './cells'
import { diffRelations, diffResidency, knownTables } from './enumerate'
import { HandPool } from './pool'
import { LOAD_WINDOW_MS } from './residency'
import { ENTITIES } from './tables'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const corpus = buildCorpus(1)
const issueById = new Map(corpus.sliceIssues.map((issue) => [issue.id, issue]))
const sessionById = new Map(corpus.sliceSessions.map((session) => [session.sessionId, session]))
/**
 * The rule from the schema's declaration (`coldByRule` over the corpus at the
 * rig's clock), not from the code under test: an issue is cold when closed
 * and nothing can keep it in the list (POD-4665).
 */
const coldRule = tableColdRule(
  SCHEMA,
  (entity) => (entity === 'issue' ? issueById : entity === 'session' ? sessionById : undefined),
  corpus.fixedNow,
)
const isCold = (issue: SliceIssue | undefined): boolean =>
  issue !== undefined && coldRule('issue', issue.id)
const hotIssues = corpus.sliceIssues.filter((issue) => !isCold(issue))
const hotSessions = corpus.sliceSessions.filter(
  (session) => !coldRule('session', session.sessionId),
)

interface Timer {
  run: () => void
  ms: number
  cancelled: boolean
}

interface Rig {
  replay: ReplaySource
  reads: ReadFence
  handle: HandPoolHandle
  pool: HandPool
  /** Timers the loader armed, in order. */
  timers: Timer[]
  /** Per-row reads the pool made through the feed, `kind:id`. */
  loads: string[]
  /** Fire the open window (the one armed, not cancelled). */
  fire(): void
  push(event: RowSourceEvent): void
  dispose(): void
}

function records(): { issues: RowRecord[]; sessions: RowRecord[]; worktrees: RowRecord[] } {
  return {
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  }
}

let open: Rig[] = []

function rig(options: { realTimer?: boolean } = {}): Rig {
  const replay = createReplaySource(records())
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const loads: string[] = []
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
    row: (kind, id) => {
      loads.push(`${kind}:${id}`)
      return replay.source.row?.(kind, id)
    },
    subscribe: (listener) => replay.source.subscribe(listener),
  }
  const reads = createReadFence({ enabled: true })
  const timers: Timer[] = []
  const handle = handPoolArm.create(
    reads.wrapSource(counted),
    locals.source,
    reads,
    options.realTimer === true
      ? {}
      : {
          schedule: (run, ms) => {
            const timer: Timer = { run, ms, cancelled: false }
            timers.push(timer)
            return () => {
              timer.cancelled = true
            }
          },
        },
  )
  const r: Rig = {
    replay,
    reads,
    handle,
    pool: handle.pool,
    timers,
    loads,
    fire() {
      const armed = timers.filter((timer) => !timer.cancelled)
      expect(armed.length).toBe(1)
      armed[0]!.cancelled = true
      armed[0]!.run()
    },
    push: (event) => replay.push(event),
    dispose() {
      handle.dispose()
      locals.dispose()
      open = open.filter((other) => other !== r)
    },
  }
  open.push(r)
  return r
}

afterEach(() => {
  for (const r of open) r.dispose()
})

function issueRecord(id: string, patch: Partial<SliceIssue> = {}): RowRecord {
  const base = issueById.get(id)
  if (base === undefined) throw new Error(`no corpus issue ${id}`)
  return { kind: 'issue', id, value: { ...base, ...patch } }
}

function sessionRecord(id: string, patch: Partial<SliceSession> = {}): RowRecord {
  const base = corpus.sliceSessions.find((session) => session.sessionId === id)
  if (base === undefined) throw new Error(`no corpus session ${id}`)
  return { kind: 'session', id, value: { ...base, ...patch } }
}

/** A closed issue with at least `n` sessions of its own, none headless. */
function closedWithSessions(n: number): { issue: SliceIssue; sessions: SliceSession[] } {
  for (const issue of corpus.sliceIssues) {
    if (!isCold(issue)) continue
    const sessions = corpus.sliceSessions.filter(
      (session) => session.issueId === issue.id && session.headless !== true,
    )
    if (sessions.length >= n) return { issue, sessions }
  }
  throw new Error(`no closed issue with ${n} sessions`)
}

/**
 * A cell the test owns, reading `compute` through the pool's tracked doors
 * like any derived value; `seen` is its first value and every change after.
 */
function watch<T>(pool: HandPool, compute: () => T): { seen: T[]; stop(): void } {
  const seen: T[] = []
  const cell: Cell<T> = pool.graph.cell('test:watch', compute, sameData, () => {
    seen.push(cell.value as T)
  })
  seen.push(pool.graph.read(cell))
  return { seen, stop: () => pool.graph.dispose(cell) }
}

/** A row view and every change its listener hears. */
function listen(pool: HandPool, id: string): { views: (RowView | undefined)[]; stop(): void } {
  const views: (RowView | undefined)[] = [pool.view(id)]
  const stop = pool.subscribe(id, () => views.push(pool.view(id)))
  return { views, stop }
}

describe('bootstrap', () => {
  it('constructs only the hot rows: the open issues, the closed ones the list can draw, and their sessions, by count', () => {
    // The open issues (~2,200 at 1x, the number Ma3's brief names) plus the
    // closed ones the rule keeps for the list (POD-4665), from the corpus.
    const open = corpus.sliceIssues.filter((issue) => issue.closedAt == null).length
    expect(open).toBeGreaterThan(2_000)
    expect(open).toBeLessThan(2_400)
    expect(hotIssues.length).toBeGreaterThan(open)
    expect(hotIssues.length).toBeLessThan(3_000)
    const r = rig()
    const { pool } = r
    expect(pool.tables.issue.size).toBe(hotIssues.length)
    expect(pool.tables.session.size).toBe(hotSessions.length)
    expect(pool.residency?.size('issue')).toBe(corpus.sliceIssues.length - hotIssues.length)
    expect(pool.residency?.size('session')).toBe(corpus.sliceSessions.length - hotSessions.length)
    // Every table slot written at bootstrap is a hot row, a lane or a repo.
    const slots = ENTITIES.reduce((sum, entity) => sum + pool.tables[entity].size, 0)
    expect(pool.stats.counters.tableWrites).toBe(slots)
    // Nothing derived, nothing built per row, nothing loaded.
    expect(pool.issues.size).toBe(0)
    expect(pool.stats.counters.cellsCreated).toBe(1) // the id list, not yet run
    expect(pool.stats.counters.recordsCreated).toBe(0)
    expect(pool.residency?.counters.requests).toBe(0)
    expect(r.loads).toEqual([])
    expect(diffResidency(pool, r.replay.source)).toEqual([])
    // Relations hold every row's ids, hot or cold: the same as with every row resident.
    const eager = new HandPool(DISABLED_READ_FENCE, {
      selectedIssueId: null,
      coarseNow: corpus.fixedNow,
    })
    const { issues, sessions, worktrees } = records()
    eager.apply({ type: 'replace', rows: [...sessions, ...issues, ...worktrees] })
    expect(pool.engine.footprint()).toEqual(eager.engine.footprint())
    expect(eager.tables.issue.size).toBe(corpus.sliceIssues.length)
    expect(diffRelations(pool.engine, knownTables(r.replay.source))).toEqual([])
    const eagerSlots = ENTITIES.reduce((sum, entity) => sum + eager.tables[entity].size, 0)
    writeResult('hand-pool-residency-1x', {
      issues: corpus.sliceIssues.length,
      sessions: corpus.sliceSessions.length,
      hot: { issues: hotIssues.length, sessions: hotSessions.length },
      cold: {
        issues: corpus.sliceIssues.length - hotIssues.length,
        sessions: corpus.sliceSessions.length - hotSessions.length,
      },
      tableSlots: { lazy: slots, allResident: eagerSlots },
      relationFootprint: pool.engine.footprint(),
    })
    eager.dispose()
  })

  it('builds cells on first read only: cells exist for exactly the rows the mounted list drew', async () => {
    const r = rig()
    const { pool } = r
    const el = document.createElement('div')
    document.body.append(el)
    let unmount = (): void => {}
    await act(async () => {
      unmount = r.handle.mountWeb(el)
    })
    const drawn = [...el.querySelectorAll('[data-issue-row]')].map(
      (row) => row.getAttribute('data-issue-row') as string,
    )
    expect(drawn.length).toBe(hotIssues.length)
    // One IssueCells per drawn row, none for a cold one.
    expect(pool.issues.size).toBe(drawn.length)
    expect([...pool.issues.keys()].sort()).toEqual([...drawn].sort())
    for (const id of pool.issues.keys()) expect(pool.residency?.isCold('issue', id)).toBe(false)
    // Every cell created belongs to a drawn row: its parts, and (POD-4581)
    // one activity cell per member session its `activityAt` asked about,
    // cold members included; plus the id list.
    let cells = 0
    const members = new Set<string>()
    for (const issue of pool.issues.values()) {
      cells += issue.cells.size
      for (const sessionId of issue.sessionIds) members.add(sessionId)
    }
    expect([...pool.sessionCells.keys()].sort()).toEqual([...members].sort())
    expect(pool.stats.counters.cellsCreated).toBe(cells + pool.sessionCells.size + 1)
    expect(pool.stats.counters.recordsCreated).toBe(0)
    // Cold rows were drawn as nothing and are asked for only when read.
    const closed = corpus.sliceIssues.filter(isCold)
    for (const issue of closed) expect(pool.view(issue.id)).toBeUndefined()
    expect(pool.resident('issue', closed[0]!.id)).toBe('loading')
    writeResult('hand-pool-first-read-1x', {
      rowsDrawn: drawn.length,
      issueCellSets: pool.issues.size,
      sessionActivityCells: pool.sessionCells.size,
      cellsCreated: pool.stats.counters.cellsCreated,
      recordsCreated: pool.stats.counters.recordsCreated,
      loadsQueuedByTheMount: pool.residency?.counters.requests,
    })
    await act(async () => {
      unmount()
    })
    el.remove()
  })
})

describe('the loader', () => {
  it('loads every row asked for inside one 50 ms window through the per-row read, in one commit', () => {
    const r = rig()
    const { pool } = r
    const [a, b] = corpus.sliceIssues.filter(isCold)
    const seen = watch(
      pool,
      () => `${pool.resident('issue', a!.id)}:${pool.view(a!.id)?.title ?? '-'}`,
    )
    // Asked for: queued, the window armed once at 50 ms, nothing read yet.
    expect(r.timers.map((timer) => timer.ms)).toEqual([LOAD_WINDOW_MS])
    expect(r.loads).toEqual([])
    // A second row and a repeat inside the same window: no second timer.
    expect(pool.resident('issue', b!.id)).toBe('loading')
    expect(pool.resident('issue', a!.id)).toBe('loading')
    expect(r.timers.length).toBe(1)
    expect(pool.residency?.counters.requests).toBe(2)
    pool.stats.reset()
    r.fire()
    // One read per row, one commit, both resident.
    expect([...r.loads].sort()).toEqual([`issue:${a!.id}`, `issue:${b!.id}`].sort())
    expect(pool.stats.notifications).toBe(1)
    expect(pool.residency?.counters.batches).toBe(1)
    expect(pool.residency?.counters.hydrated).toBe(2)
    expect(pool.resident('issue', b!.id)).toBe('resident')
    seen.stop()
    // The reader saw "loading", never an empty row, then the row.
    expect(seen.seen).toEqual(['loading:-', `resident:${a!.title}`])
    // The loaded row is the feed's borrowed object.
    expect(r.reads.isBorrowed(pool.tables.issue.get(a!.id))).toBe(true)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('drains pending loads on demand, following what they queue, and counts the rows', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    // A reader of the closed issue's row: once the issue lands, its view asks
    // for its cold sessions, which queue in turn.
    const row = watch(pool, () =>
      pool.resident('issue', issue.id) === 'resident'
        ? (pool.view(issue.id)?.loading ?? false)
        : 'waiting',
    )
    expect(pool.pendingLoads()).toBe(1)
    expect(r.handle.pendingLoads()).toBe(1)
    const landed = r.handle.drainLoads()
    row.stop()
    expect(landed).toBe(1 + sessions.length)
    expect(pool.pendingLoads()).toBe(0)
    expect(row.seen).toEqual(['waiting', true, false])
    for (const session of sessions) expect(pool.tables.session.has(session.sessionId)).toBe(true)
    // Nothing queued: a drain is free.
    expect(r.handle.drainLoads()).toBe(0)
  })

  it('counts a hydration as one read of that row in the reads fence', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    expect(pool.resident('issue', closed.id)).toBe('loading')
    r.reads.reset()
    r.fire()
    const stats = r.reads.stats()
    expect(stats.rows).toBe(1)
    expect(stats.byEntity).toEqual({ issue: 1 })
    expect(stats.sample).toEqual([`issue:${closed.id}`])
  })

  it('closes the window on its own with the real timer', async () => {
    const r = rig({ realTimer: true })
    const closed = corpus.sliceIssues.find(isCold)!
    expect(r.pool.resident('issue', closed.id)).toBe('loading')
    await new Promise((resolve) => setTimeout(resolve, LOAD_WINDOW_MS + 30))
    expect(r.pool.resident('issue', closed.id)).toBe('resident')
    expect(r.pool.residency?.hasQueued()).toBe(false)
  })

  it('loads the current value: an update to a cold row that keeps it cold is not stored', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    pool.stats.reset()
    r.push({ type: 'update', rows: [issueRecord(closed.id, { title: 'Renamed while cold' })] })
    expect(pool.tables.issue.has(closed.id)).toBe(false)
    expect(pool.residency?.isCold('issue', closed.id)).toBe(true)
    expect(pool.stats.counters.tableWrites).toBe(0)
    expect(pool.residency?.counters.coldWrites).toBe(1)
    expect(r.loads).toEqual([])
    expect(pool.resident('issue', closed.id)).toBe('loading')
    r.fire()
    expect(pool.view(closed.id)?.title).toBe('Renamed while cold')
  })

  it('leaves a row whose read finds nothing cold until its removal arrives', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    expect(pool.resident('issue', closed.id)).toBe('loading')
    // The kernel dropped it; the feed has not published the removal yet.
    const held = r.replay.source.row
    ;(r.replay.source as { row?: RowSource['row'] }).row = () => undefined
    r.fire()
    ;(r.replay.source as { row?: RowSource['row'] }).row = held
    expect(pool.residency?.isCold('issue', closed.id)).toBe(true)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: closed.id, value: undefined }] })
    expect(pool.residency?.isCold('issue', closed.id)).toBe(false)
    expect(pool.resident('issue', closed.id)).toBe('absent')
  })

  it('a cold session heartbeat is a registry write: no load, no table slot, no row redrawn', () => {
    const r = rig()
    const { pool } = r
    const { sessions } = closedWithSessions(1)
    const session = sessions[0]!
    pool.stats.reset()
    r.reads.reset()
    r.push({
      type: 'update',
      rows: [sessionRecord(session.sessionId, { lastActiveAt: '2026-09-23T12:00:00.000Z' })],
    })
    expect(r.loads).toEqual([])
    expect(pool.tables.session.has(session.sessionId)).toBe(false)
    expect(pool.stats.counters.tableWrites).toBe(0)
    expect(pool.stats.rowsDerived).toBe(0)
    expect(pool.residency?.counters.coldWrites).toBe(1)
  })
})

describe('lazy relations', () => {
  it('a hot parent with cold closed children reports progress from its hot children and a pending marker until they load', () => {
    const r = rig()
    const { pool } = r
    const children = new Map<string, SliceIssue[]>()
    for (const issue of corpus.sliceIssues) {
      if (issue.parentId == null || issue.archived === true || issue.deletedAt != null) continue
      children.set(issue.parentId, [...(children.get(issue.parentId) ?? []), issue])
    }
    const [parentId, kids] = [...children].find(
      ([id, list]) =>
        !isCold(issueById.get(id)) && list.some(isCold) && list.some((kid) => !isCold(kid)),
    )!
    const hot = kids.filter((kid) => !isCold(kid)).map((kid) => kid.id)
    const cold = kids.filter(isCold).map((kid) => kid.id)
    // The bucket holds every child id, hot or cold; nothing cold is held.
    expect([...pool.relations.many('issue', parentId, 'children')].sort()).toEqual(
      kids.map((kid) => kid.id).sort(),
    )
    // A progress roll-up the way Hb3 will read it: done/total over the READY
    // children, and `pending` while any is still loading. A closed child is
    // a done one, so until the cold ones arrive progress counts only hot data.
    const progress = watch(pool, () => {
      const members = pool.lazyMany('issue', parentId, 'children')
      let done = 0
      for (const id of members.ready) if (pool.inputs.issue(id)?.closedAt != null) done += 1
      return { done, total: members.ready.length, pending: members.pending }
    })
    expect(pool.residency?.counters.requests).toBe(cold.length)
    r.fire()
    progress.stop()
    expect(progress.seen).toEqual([
      { done: 0, total: hot.length, pending: cold.length },
      { done: cold.length, total: kids.length, pending: 0 },
    ])
  })

  it('a row reads its cold sessions as loading, never as data, until they load', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions: own } = closedWithSessions(1)
    // A second cold session, re-homed from another closed issue: a cold
    // update that relinks and stays cold.
    const other = corpus.sliceSessions.find(
      (session) =>
        session.issueId != null &&
        session.issueId !== issue.id &&
        session.headless !== true &&
        // A finished run: its deadline passed with its old issue, and does
        // not depend on the issue it moves to.
        session.stoppedAt != null &&
        isCold(issueById.get(session.issueId)),
    )!
    r.push({ type: 'update', rows: [sessionRecord(other.sessionId, { issueId: issue.id })] })
    const sessions = [...own, { ...other, issueId: issue.id }]
    expect(pool.residency?.isCold('session', other.sessionId)).toBe(true)
    expect([...pool.relations.many('issue', issue.id, 'sessions')]).toEqual(
      expect.arrayContaining(sessions.map((session) => session.sessionId)),
    )
    // Load the closed issue itself first (a reader opened it).
    expect(pool.resident('issue', issue.id)).toBe('loading')
    r.fire()
    const row = listen(pool, issue.id)
    // Its sessions stay cold: the row is loading, its activity provisional.
    expect(row.views[0]?.loading).toBe(true)
    for (const session of sessions)
      expect(pool.residency?.isCold('session', session.sessionId)).toBe(true)
    // Every member was asked for in the same window.
    expect(r.timers.filter((timer) => !timer.cancelled).length).toBe(1)
    r.fire()
    row.stop()
    // One change heard: loading, then the data.
    expect(row.views.length).toBe(2)
    const last = row.views.at(-1)!
    expect(last.loading).toBeUndefined()
    const latest = Math.max(...sessions.map((session) => Date.parse(session.lastActiveAt)))
    expect(last.activityAt).toBe(latest)
  })

  it('a spin-off of a cold origin shows loading, then its tick', () => {
    const r = rig()
    const { pool } = r
    const origin = corpus.sliceIssues.find(isCold)!
    const spinOff = hotIssues.find((issue) => (issue.deps ?? []).length === 0 && !issue.draft)!
    const row = listen(pool, spinOff.id)
    r.push({
      type: 'update',
      rows: [issueRecord(spinOff.id, { deps: [{ id: origin.id, type: 'discovered-from' }] })],
    })
    expect(row.views.at(-1)?.loading).toBe(true)
    expect(row.views.at(-1)?.originTick).toBeNull()
    r.fire()
    row.stop()
    expect(row.views.at(-1)?.loading).toBeUndefined()
    expect(row.views.at(-1)?.originTick?.id).toBe(origin.id)
  })

  it("a cold row's relations answer from ids while it is cold, and loading writes no relation", () => {
    const r = rig()
    const { pool } = r
    const cold = corpus.sliceIssues.find(
      (issue) => isCold(issue) && issue.parentId != null && issue.archived !== true,
    )!
    expect(pool.relations.one('issue', cold.id, 'parent')).toBe(cold.parentId)
    expect([...pool.relations.many('issue', cold.parentId!, 'children')]).toContain(cold.id)
    expect(pool.resident('issue', cold.id)).toBe('loading')
    r.fire()
    // Loaded: relinked from its current value, which moved nothing.
    expect(pool.engine.lastWrites).toEqual([])
    expect(pool.relations.one('issue', cold.id, 'parent')).toBe(cold.parentId)
  })
})

describe('transitions', () => {
  it('a reopened issue is resident at once, with its sessions, in one commit', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    pool.stats.reset()
    r.push({
      type: 'update',
      rows: [issueRecord(issue.id, { closedAt: null, closedReason: null })],
    })
    expect(pool.stats.notifications).toBe(1)
    expect(pool.tables.issue.has(issue.id)).toBe(true)
    for (const session of sessions) expect(pool.tables.session.has(session.sessionId)).toBe(true)
    expect(pool.residency?.counters.warmed).toBeGreaterThanOrEqual(sessions.length)
    // Never painted loading: nothing was queued.
    expect(r.timers).toEqual([])
    expect(pool.view(issue.id)?.loading).toBeUndefined()
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('a session that can keep its cold issue shown makes the issue resident at once, with its sessions (POD-4665)', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    pool.stats.reset()
    // A run that never finished keeps its issue in the list without limit
    // (`sessionRetainsWorklistRow`): the schema's rule makes the issue hot.
    r.push({
      type: 'update',
      rows: [
        sessionRecord(sessions[0]!.sessionId, {
          stoppedAt: null,
          agentState: undefined,
          archived: false,
          agentKind: 'claude',
        }),
      ],
    })
    expect(pool.stats.notifications).toBe(1)
    expect(pool.tables.issue.has(issue.id)).toBe(true)
    for (const session of sessions) expect(pool.tables.session.has(session.sessionId)).toBe(true)
    // The issue and every session that inherited its coldness, in the same pass.
    expect(pool.residency?.counters.warmed).toBe(1 + sessions.length)
    expect(r.timers).toEqual([])
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('a member update that cannot keep its cold issue shown leaves it cold, and a headless run keeps nothing (POD-4665)', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    const id = sessions[0]!.sessionId
    pool.stats.reset()
    r.push({
      type: 'update',
      rows: [sessionRecord(id, { lastActiveAt: new Date(corpus.fixedNow).toISOString() })],
    })
    r.push({
      type: 'update',
      rows: [sessionRecord(id, { stoppedAt: null, agentState: undefined, headless: true })],
    })
    expect(pool.residency?.isCold('issue', issue.id)).toBe(true)
    expect(pool.residency?.isCold('session', id)).toBe(true)
    expect(pool.residency?.counters.warmed).toBe(0)
    expect(pool.residency?.counters.hydrated).toBe(0)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('an issue closed while resident stays resident', () => {
    const r = rig()
    const { pool } = r
    const openIssue = hotIssues[0]!
    r.push({
      type: 'update',
      rows: [issueRecord(openIssue.id, { closedAt: '2026-09-01T00:00:00.000Z' })],
    })
    expect(pool.resident('issue', openIssue.id)).toBe('resident')
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it("a removed resident parent's children follow a child that moves away (Ma4's seed 8)", () => {
    // The MobX gate's 20 x 300 run found this shape (evict a parent, move a
    // child away, re-add the parent). Here buckets are keyed by reference and
    // never placed by residency, so there is no second place to go stale.
    const r = rig()
    const { pool } = r
    const child = hotIssues.find(
      (issue) =>
        issue.parentId != null &&
        !isCold(issueById.get(issue.parentId)) &&
        issue.archived !== true,
    )!
    const parentId = child.parentId as string
    const children = () => [...pool.relations.many('issue', parentId, 'children')]
    expect(children()).toContain(child.id)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: parentId, value: undefined }] })
    expect(children()).toContain(child.id)
    r.push({ type: 'update', rows: [issueRecord(child.id, { parentId: null })] })
    expect(children()).not.toContain(child.id)
    r.push({ type: 'update', rows: [issueRecord(parentId)] })
    expect(children()).not.toContain(child.id)
    expect(diffRelations(pool.engine, knownTables(r.replay.source))).toEqual([])
  })

  it('removing a cold issue forgets it, and its cold sessions become resident', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
    expect(pool.residency?.isCold('issue', issue.id)).toBe(false)
    for (const session of sessions) {
      expect(pool.resident('session', session.sessionId)).toBe('resident')
    }
    expect(diffResidency(pool, r.replay.source)).toEqual([])
    expect(diffRelations(pool.engine, knownTables(r.replay.source))).toEqual([])
  })

  it('a cold session moved to an open issue is resident at once', () => {
    const r = rig()
    const { pool } = r
    const { sessions } = closedWithSessions(1)
    const session = sessions[0]!
    r.push({
      type: 'update',
      rows: [sessionRecord(session.sessionId, { issueId: hotIssues[0]!.id })],
    })
    expect(pool.resident('session', session.sessionId)).toBe('resident')
    expect([...pool.relations.many('issue', hotIssues[0]!.id, 'sessions')]).toContain(
      session.sessionId,
    )
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('a new session of a closed issue arrives cold; a resume twin reads its cold peer back by id', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    const twin = sessions.find((session) => session.resume != null) ?? sessions[0]!
    const fresh = { ...twin, sessionId: 's-new-cold', resume: undefined }
    r.push({ type: 'update', rows: [{ kind: 'session', id: fresh.sessionId, value: fresh }] })
    expect(pool.residency?.isCold('session', fresh.sessionId)).toBe(true)
    expect(pool.residency?.registeredTarget('session', fresh.sessionId)).toBe(issue.id)
    expect(r.loads).toEqual([])
    // Sharing a resume ref, the collapse decides the group over its peers'
    // fields: the cold peer is read by id, and nothing becomes resident.
    if (twin.resume == null) return
    const second = { ...twin, sessionId: 's-new-twin' }
    r.push({ type: 'update', rows: [{ kind: 'session', id: second.sessionId, value: second }] })
    expect(new Set(r.loads)).toEqual(new Set([`session:${twin.sessionId}`]))
    expect(pool.tables.session.has(twin.sessionId)).toBe(false)
    expect(pool.residency?.isCold('session', second.sessionId)).toBe(true)
    expect(diffRelations(pool.engine, knownTables(r.replay.source))).toEqual([])
  })

  it('a replace re-partitions: what was resident stays, the rest follows the rule', () => {
    const r = rig()
    const { pool } = r
    const [looked, untouched] = corpus.sliceIssues.filter(isCold)
    pool.resident('issue', looked!.id)
    r.fire()
    const { issues, sessions, worktrees } = records()
    const reopened = issues.map((record) =>
      record.id === untouched!.id
        ? issueRecord(untouched!.id, { closedAt: null, closedReason: null })
        : record,
    )
    r.push({ type: 'replace', rows: [...sessions, ...reopened, ...worktrees] })
    expect(pool.resident('issue', looked!.id)).toBe('resident')
    expect(pool.tables.issue.has(untouched!.id)).toBe(true)
    expect(pool.tables.issue.size).toBe(hotIssues.length + 2)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
    expect(diffRelations(pool.engine, knownTables(r.replay.source))).toEqual([])
  })
})
