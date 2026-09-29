// @vitest-environment happy-dom
/**
 * POD-4567 (Ma3) — residency on the 1x corpus through a replay feed, reads
 * fence on, MobX warn trap armed: the hot/cold split at bootstrap (by count,
 * and by the observables MobX reports building), observability on first
 * access with the list mounted, the 50 ms batch loader, lazy relations with
 * their pending marker, and every transition `residency.ts` names.
 */

import { autorun, runInAction, spy } from 'mobx'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { runLegacyDerivation, visibleIssueRows } from '../../../harness/src/oracle/index'
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
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { diffRelations, diffResidency, knownTables } from './enumerate'
import { installMobxWarnTrap } from './mobx-trap'
import { MobxPool, tracked } from './pool'
import { LOAD_WINDOW_MS } from './residency'
import { LOADING } from './worklist/rollup'
import { sliceOrderOf } from './worklist/groups'
import { rowViewOf } from './models'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()
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
  (entity) =>
    entity === 'issue'
      ? issueById
      : entity === 'session'
        ? sessionById
        : entity === 'worktree'
          ? new Map(corpus.sliceWorktrees.map((lane) => [lane.path, lane]))
          : undefined,
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
  handle: MobxPoolHandle
  pool: MobxPool
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

function rig(
  options: { fence?: boolean; realTimer?: boolean; rows?: ReturnType<typeof records> } = {},
): Rig {
  const replay = createReplaySource(options.rows ?? records())
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
  const reads = options.fence === false ? DISABLED_READ_FENCE : createReadFence({ enabled: true })
  const timers: Timer[] = []
  const handle = mobxPoolArm.create(
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
  expect(trap.warnings).toEqual([])
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

const hotIds = (pool: MobxPool, entity: 'issue' | 'session'): number =>
  tracked(() => pool.tables[entity].size)

/**
 * POD-4753: the rows a publication warmed without carrying them are asked
 * for, not read: each answers `loading`, nothing is read by id, one window is
 * open. Closing it reads exactly `expected`, in one batch, and installs them.
 */
function expectAskedThenLanded(r: Rig, expected: readonly string[]): void {
  const residence = (key: string) => {
    const [kind, id] = key.split(':') as ['issue' | 'session', string]
    return tracked(() => r.pool.resident(kind, id))
  }
  expect(r.loads, 'rows read by id before the window').toEqual([])
  for (const key of expected) expect(residence(key), key).toBe('loading')
  expect(r.pool.pendingLoads()).toBe(expected.length)
  const batches = r.pool.residency?.counters.batches ?? 0
  r.fire()
  expect([...r.loads].sort()).toEqual([...expected].sort())
  expect(r.pool.residency?.counters.batches).toBe(batches + 1)
  for (const key of expected) expect(residence(key), key).toBe('resident')
  expect(r.pool.pendingLoads()).toBe(0)
  expect(r.timers.filter((timer) => !timer.cancelled)).toEqual([])
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
    const built: Record<string, number> = {}
    const off = spy((event) => {
      if (event.type !== 'add') return
      const name = String((event as { debugObjectName?: string }).debugObjectName).replace(
        /@\d+$/,
        '',
      )
      built[name] = (built[name] ?? 0) + 1
    })
    const r = rig()
    off()
    const { pool } = r
    expect(hotIds(pool, 'issue')).toBe(hotIssues.length)
    expect(hotIds(pool, 'session')).toBe(hotSessions.length)
    expect(pool.residency?.size('issue')).toBe(corpus.sliceIssues.length - hotIssues.length)
    expect(pool.residency?.size('session')).toBe(corpus.sliceSessions.length - hotSessions.length)
    // What MobX itself reports building: one table slot per HOT row.
    expect(built['pool.issue']).toBe(hotIssues.length)
    expect(built['pool.session']).toBe(hotSessions.length)
    // One filing reaction per HOT issue; one object per issue read (the hot
    // ones, and the cold ones a walk reaches: their visibility reads the
    // cold row by id), and the sessions those read.
    expect(pool.worklist.size()).toBe(hotIssues.length)
    expect(pool.modelCount('issue')).toBeGreaterThanOrEqual(hotIssues.length)
    expect(pool.modelCount('issue') - hotIssues.length).toBeLessThanOrEqual(
      corpus.sliceIssues.length - hotIssues.length,
    )
    expect(pool.stats.counters.modelsCreated).toBe(
      pool.modelCount('issue') + pool.modelCount('session'),
    )
    expect(pool.residency?.counters.requests).toBe(0)
    // POD-4753: startup reads no row by id. A cold issue is hidden by the
    // rule, so the walks that reach one (a hot child's nesting walk, a
    // rescue) read its declared summary, never its row or its sessions'.
    // (Before: 722 cold rows read by id at 1x, through the one reader's peek.)
    expect(r.loads).toEqual([])
    expect(diffResidency(pool, r.replay.source)).toEqual([])

    // The same bootstrap with every row resident (the Ma2 pool), for the record.
    const all: Record<string, number> = {}
    const offAll = spy((event) => {
      if (event.type !== 'add') return
      const name = String((event as { debugObjectName?: string }).debugObjectName).replace(
        /@\d+$/,
        '',
      )
      all[name] = (all[name] ?? 0) + 1
    })
    const eager = new MobxPool(DISABLED_READ_FENCE, {
      selectedIssueId: null,
      coarseNow: corpus.fixedNow,
    })
    const { issues, sessions, worktrees } = records()
    eager.apply({ type: 'replace', rows: [...sessions, ...issues, ...worktrees] })
    offAll()
    eager.dispose()
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0)
    expect(all['pool.issue']).toBe(corpus.sliceIssues.length)
    expect(sum(built)).toBeLessThan(sum(all))
    writeResult('mobx-pool-residency-1x', {
      issues: corpus.sliceIssues.length,
      sessions: corpus.sliceSessions.length,
      hot: { issues: hotIssues.length, sessions: hotSessions.length },
      cold: {
        issues: corpus.sliceIssues.length - hotIssues.length,
        sessions: corpus.sliceSessions.length - hotSessions.length,
      },
      observablesBuilt: { lazy: sum(built), allResident: sum(all) },
      byMap: { lazy: built, allResident: all },
    })
  })

  it('drawing builds no object beyond bootstrap\'s, the drawn rows, their origins and the issues below them', async () => {
    const r = rig()
    const { pool } = r
    // The issue objects bootstrap built (every hot issue's, and the cold
    // ones its walks reached).
    const held = new Set(
      (pool as unknown as { models: { issue: Map<string, unknown> } }).models.issue.keys(),
    )
    expect(pool.modelCount('issue')).toBe(held.size)
    const el = document.createElement('div')
    document.body.append(el)
    let unmount = (): void => {}
    await act(async () => {
      unmount = r.handle.mountWeb(el)
    })
    const drawn = [...el.querySelectorAll('[data-issue-row]')].map((row) =>
      row.getAttribute('data-issue-row'),
    )
    // Mb1 (POD-4569): the list draws the VISIBLE rows; a cold one is a
    // loading placeholder until its load lands, so the rows drawn are the
    // visible hot ones. Mb2 (POD-4570): in grouped order (pinned, then each
    // group's open lane and closed fold).
    const visibleHot = tracked(() => {
      const order = sliceOrderOf(pool.groups.layout)
      return [
        ...order.pinnedIds,
        ...order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
      ].filter((id) => pool.tables.issue.has(id))
    })
    expect(drawn).toEqual(visibleHot)
    // A drawn row's activity re-composes from its retained seats' cached
    // values (legacy `retainedSessions`), so its resident seats have an
    // object too.
    const members = new Set(
      tracked(() => drawn.flatMap((id) => pool.knownIssue(id!)?.retainedSeatIds ?? [])).filter(
        (id) => tracked(() => pool.resident('session', id)) === 'resident',
      ),
    )
    expect(members.size).toBeGreaterThan(0)
    // A drawn spin-off's ⤷ tick reads its origin's cached in-memory read, so
    // an origin the list hides gets an object too (a cold one is loading: the
    // tick asked for it).
    const drawnSet = new Set(drawn)
    const origins = new Set(
      tracked(() =>
        drawn.flatMap((id) => {
          const origin = pool.issue(id!)?.originRef
          return origin != null && !drawnSet.has(origin) ? [origin] : []
        }),
      ),
    )
    // A drawn row's roll-ups compose over the issues below it (its formal
    // children's units, its nest candidates down the raw parent edge, its
    // spin-offs' tips, the issues its sessions started), so one bootstrap
    // never read gets its object on first read (a cold one is read by id,
    // never loaded).
    const descendants = new Set<string>()
    tracked(() => {
      const queue = drawn.map((id) => id!)
      const reach = (id: string): void => {
        if (descendants.has(id)) return
        descendants.add(id)
        queue.push(id)
      }
      for (let at = 0; at < queue.length; at += 1) {
        const id = queue[at]!
        for (const relation of ['children', 'treeChildren', 'spinOffs'] as const) {
          for (const below of pool.relations.many('issue', id, relation)) reach(below)
        }
        for (const session of pool.knownIssue(id)?.memberIds ?? []) {
          for (const started of pool.relations.many('session', session, 'startedIssues')) reach(started)
        }
      }
    })
    const built = new Set(
      (pool as unknown as { models: { issue: Map<string, unknown> } }).models.issue.keys(),
    )
    const expected = new Set([...held, ...drawn, ...origins])
    expect([...built].filter((id) => !expected.has(id) && !descendants.has(id))).toEqual([])
    const issueModels = built.size
    expect(pool.modelCount('issue')).toBe(issueModels)
    expect(pool.modelCount('session')).toBeGreaterThanOrEqual(members.size)
    expect(pool.stats.counters.modelsCreated).toBe(
      issueModels + pool.modelCount('session'),
    )
    // No cold row got a model, and none was drawn.
    for (const issue of corpus.sliceIssues) {
      if (isCold(issue)) expect(tracked(() => pool.resident('issue', issue.id))).toBe('loading')
    }
    expect(pool.modelCount('issue')).toBe(issueModels)
    await act(async () => {
      unmount()
    })
    el.remove()
  })
})

/** Whether a `kind:id` read names a row the pool holds cold. */
function isColdKey(pool: MobxPool, key: string): boolean {
  const [kind, id] = key.split(':') as ['issue' | 'session', string]
  return pool.residency?.isCold(kind, id) === true
}

describe('the loader', () => {
  it('loads every row asked for inside one 50 ms window through the per-row read, in one action', () => {
    const r = rig()
    const { pool } = r
    // The bootstrap's visibility reads of cold rows (Mb1) are not loads.
    r.loads.length = 0
    const [a, b] = corpus.sliceIssues.filter(isCold)
    const seen: string[] = []
    const watch = autorun(() => {
      const state = pool.resident('issue', a!.id)
      const view = rowViewOf(pool.issue(a!.id))
      seen.push(`${state}:${view === undefined ? '-' : view.title}`)
    })
    // Asked for: queued, the window armed once at 50 ms, nothing read yet.
    expect(r.timers.map((timer) => timer.ms)).toEqual([LOAD_WINDOW_MS])
    expect(r.loads).toEqual([])
    // A second row and a repeat inside the same window: no second timer.
    expect(tracked(() => pool.resident('issue', b!.id))).toBe('loading')
    expect(tracked(() => pool.resident('issue', a!.id))).toBe('loading')
    expect(r.timers.length).toBe(1)
    expect(pool.residency?.counters.requests).toBe(2)
    pool.stats.reset()
    r.fire()
    // One read per row, one action, both resident. The watched row's view,
    // redrawn once `a` lands, asks for its cold formal children for its
    // progress (POD-4754: queued for the NEXT window, never read here), and
    // since POD-4679 its retained seats, deciding which reads each cold
    // member's retention by id: per-row feed reads, never loads (`hydrated`
    // below stays 2, and they stay cold).
    const loaded = [`issue:${a!.id}`, `issue:${b!.id}`]
    const coldChildren = tracked(() => [...pool.relations.many('issue', a!.id, 'children')]).filter((id) =>
      pool.residency?.isCold('issue', id),
    )
    const coldMembers = tracked(() => [...(pool.knownIssue(a!.id)?.memberIds ?? [])]).filter(
      (id) => pool.residency?.isCold('session', id),
    )
    const byId = r.loads.filter((key) => !loaded.includes(key))
    expect(r.loads.filter((key) => loaded.includes(key)).sort()).toEqual(loaded.sort())
    for (const key of byId) {
      const [kind, id] = key.split(':') as ['issue' | 'session', string]
      expect(
        kind === 'issue' ? coldChildren.includes(id) : coldMembers.includes(id),
        `${key} is a cold child or a cold member of ${a!.id}`,
      ).toBe(true)
      expect(isColdKey(pool, key), key).toBe(true)
    }
    expect(pool.stats.notifications).toBe(1)
    expect(pool.residency?.counters.batches).toBe(1)
    expect(pool.residency?.counters.hydrated).toBe(2)
    expect(tracked(() => pool.resident('issue', b!.id))).toBe('resident')
    watch()
    // The reader saw "loading", never an empty row, then the row.
    expect(seen).toEqual(['loading:-', `resident:${a!.title}`])
    // The loaded row is the feed's borrowed object.
    expect(r.reads.isBorrowed(runInAction(() => pool.tables.issue.get(a!.id)))).toBe(true)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('counts a hydration as one read of that row in the reads fence', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('loading')
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
    expect(tracked(() => r.pool.resident('issue', closed.id))).toBe('loading')
    await new Promise((resolve) => setTimeout(resolve, LOAD_WINDOW_MS + 30))
    expect(tracked(() => r.pool.resident('issue', closed.id))).toBe('resident')
    expect(r.pool.residency?.hasQueued()).toBe(false)
  })

  it('loads the current value: an update to a cold row that keeps it cold is not stored', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    pool.stats.reset()
    r.push({ type: 'update', rows: [issueRecord(closed.id, { title: 'Renamed while cold' })] })
    expect(tracked(() => pool.tables.issue.has(closed.id))).toBe(false)
    expect(pool.residency?.isCold('issue', closed.id)).toBe(true)
    expect(pool.stats.counters.tableWrites).toBe(0)
    expect(pool.stats.notifications).toBe(1)
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('loading')
    r.fire()
    expect(tracked(() => rowViewOf(pool.issue(closed.id))?.title)).toBe('Renamed while cold')
  })

  it('a cold row read by a derivation stays tracked across an untracked residency check (POD-4569)', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    // A long-lived derivation reads the cold row by id (as a visibility node does).
    const titles: (string | undefined)[] = []
    const watch = autorun(() => {
      titles.push((pool.row('issue', closed.id, 'peek') as { title?: string } | undefined)?.title)
    })
    try {
      // An untracked check between steps, inside an action, as the gate's
      // relation scan asks it (`diffRelations` under `runInAction`).
      expect(runInAction(() => pool.residency?.known('issue', closed.id))).toBe(true)
      r.push({ type: 'update', rows: [issueRecord(closed.id, { title: 'Renamed while cold' })] })
      expect(titles.at(-1)).toBe('Renamed while cold')
    } finally {
      watch()
    }
  })

  it('leaves a row whose read finds nothing cold until its removal arrives', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isCold)!
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('loading')
    // The kernel dropped it; the feed has not published the removal yet.
    const held = r.replay.source.row
    ;(r.replay.source as { row?: RowSource['row'] }).row = () => undefined
    r.fire()
    ;(r.replay.source as { row?: RowSource['row'] }).row = held
    expect(pool.residency?.isCold('issue', closed.id)).toBe(true)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: closed.id, value: undefined }] })
    expect(pool.residency?.isCold('issue', closed.id)).toBe(false)
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('absent')
  })
})

describe('lazy relations', () => {
  it('a hot parent with cold closed children reports its hot children and a pending marker until they load', () => {
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
    const seen: { ready: number; pending: number }[] = []
    const watch = autorun(() => {
      const members = pool.lazyMany('issue', parentId, 'children')
      seen.push({ ready: members.ready.length, pending: members.pending })
    })
    // The bucket holds every child id, hot or cold; nothing cold was built.
    expect(tracked(() => [...pool.relations.many('issue', parentId, 'children')].sort())).toEqual(
      kids.map((kid) => kid.id).sort(),
    )
    expect(tracked(() => [...pool.lazyMany('issue', parentId, 'children').ready].sort())).toEqual(
      [...hot].sort(),
    )
    expect(pool.residency?.counters.requests).toBe(cold.length)
    r.fire()
    watch()
    expect(seen).toEqual([
      { ready: hot.length, pending: cold.length },
      { ready: kids.length, pending: 0 },
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
    expect(tracked(() => [...pool.relations.many('issue', issue.id, 'sessions')])).toEqual(
      expect.arrayContaining(sessions.map((session) => session.sessionId)),
    )
    // Load the closed issue itself first (a reader opened it).
    expect(tracked(() => pool.resident('issue', issue.id))).toBe('loading')
    r.fire()
    const views: (RowView | undefined)[] = []
    const watch = autorun(() => {
      views.push(rowViewOf(pool.issue(issue.id)))
    })
    // Its sessions stay cold: the row is loading, its activity provisional.
    expect(views.length).toBe(1)
    expect(views[0]?.loading).toBe(true)
    for (const session of sessions)
      expect(pool.residency?.isCold('session', session.sessionId)).toBe(true)
    // Every member was asked for in the same window.
    expect(r.timers.filter((timer) => !timer.cancelled).length).toBe(1)
    r.fire()
    watch()
    const last = views.at(-1)!
    expect(last.loading).toBeUndefined()
    // The legacy stamp (POD-4679, `rows.ts:98-116`): the retained seats'
    // latest, else `updatedAt`. These are finished runs of a closed issue
    // past their keep, so none is retained, and the loaded row shows the
    // issue's own stamp, not its sessions' (the pre-POD-4679 value).
    expect(tracked(() => pool.knownIssue(issue.id)?.retainedSeatIds)).toEqual([])
    const latest = Math.max(...sessions.map((session) => Date.parse(session.lastActiveAt)))
    expect(latest).not.toBe(Date.parse(issue.updatedAt))
    expect(last.activityAt).toBe(Date.parse(issue.updatedAt))
  })

  it('a spin-off of a cold origin shows loading, then its tick', () => {
    const r = rig()
    const { pool } = r
    const origin = corpus.sliceIssues.find(isCold)!
    const spinOff = hotIssues.find((issue) => (issue.deps ?? []).length === 0 && !issue.draft)!
    const views: (RowView | undefined)[] = []
    const watch = autorun(() => {
      views.push(rowViewOf(pool.issue(spinOff.id)))
    })
    r.push({
      type: 'update',
      rows: [issueRecord(spinOff.id, { deps: [{ id: origin.id, type: 'discovered-from' }] })],
    })
    expect(views.at(-1)?.loading).toBe(true)
    expect(views.at(-1)?.originTick).toBeNull()
    r.fire()
    watch()
    expect(views.at(-1)?.loading).toBeUndefined()
    expect(views.at(-1)?.originTick?.id).toBe(origin.id)
  })

  it('keeps a cold row out of the observable relation maps until it is resident', () => {
    const r = rig()
    const { pool } = r
    const cold = corpus.sliceIssues.find((issue) => isCold(issue) && issue.parentId != null)!
    const slot = `issue.parent→${cold.id}`
    // A cold row's own forward entry answers, from the plain twin.
    expect(tracked(() => pool.graph.one('issue', cold.id, 'parent'))).toBe(cold.parentId)
    expect(tracked(() => pool.resident('issue', cold.id))).toBe('loading')
    r.fire()
    // Loading it moved its slot into the observable map: one slot written.
    expect(pool.graph.lastWrites).toContain(slot)
    expect(tracked(() => pool.graph.one('issue', cold.id, 'parent'))).toBe(cold.parentId)
  })
})

describe('transitions', () => {
  it('a reopened issue is resident at once; its sessions show loading and land in one batch (POD-4753)', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    pool.stats.reset()
    r.push({
      type: 'update',
      rows: [issueRecord(issue.id, { closedAt: null, closedReason: null })],
    })
    expect(pool.stats.notifications).toBe(1)
    // The update carries the issue: installed from it.
    expect(tracked(() => pool.tables.issue.has(issue.id))).toBe(true)
    // It does not carry the sessions: asked for, never read inside the event.
    // In between, nothing draws a stale value: the one reader answers LOADING
    // for each session (not its old row), and the row's own parts report
    // loading (`lazyLoading`, what its `loading` field shows), observed by a
    // reaction as a mounted row observes it. (The whole row also reads
    // progress over closed children, POD-4754's path, not asserted here.)
    const drawn: boolean[] = []
    const stop = autorun(() => {
      drawn.push(pool.issue(issue.id)?.lazyLoading === true)
    })
    for (const session of sessions) {
      expect(tracked(() => pool.row('session', session.sessionId))).toBe(LOADING)
    }
    expect(drawn).toEqual([true])
    expectAskedThenLanded(
      r,
      sessions.map((session) => `session:${session.sessionId}`),
    )
    // Exactly one window later every session is the row itself, and the
    // drawn row stopped loading in that window's one action.
    for (const session of sessions) {
      expect(tracked(() => pool.row('session', session.sessionId))).toEqual(
        r.replay.source.row?.('session', session.sessionId),
      )
    }
    expect(drawn).toEqual([true, false])
    stop()
    expect(pool.residency?.counters.warmed).toBeGreaterThanOrEqual(sessions.length)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('a session that can keep its cold issue shown is resident at once; the issue and its other sessions land in one batch (POD-4665, POD-4753)', () => {
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
    // The update carries the keeping session: installed from it. The issue
    // and its other sessions are asked for together.
    expect(tracked(() => pool.tables.session.has(sessions[0]!.sessionId))).toBe(true)
    expectAskedThenLanded(r, [
      `issue:${issue.id}`,
      ...sessions.slice(1).map((session) => `session:${session.sessionId}`),
    ])
    // The issue and every session that inherited its coldness, in the same pass.
    expect(pool.residency?.counters.warmed).toBe(1 + sessions.length)
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
    expect(tracked(() => pool.resident('issue', openIssue.id))).toBe('resident')
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it("a removed resident parent's children follow a child that moves away (POD-4568)", () => {
    // The gate's 20 x 300 run found this: a resident parent keeps its
    // observable bucket when removed ("nothing moves back"), so the next
    // flush for that parent must write THAT bucket, not the plain twin.
    const r = rig()
    const { pool } = r
    const child = hotIssues.find(
      (issue) =>
        issue.parentId != null && !isCold(issueById.get(issue.parentId)) && issue.archived !== true,
    )!
    const parentId = child.parentId as string
    const children = () => tracked(() => [...pool.relations.many('issue', parentId, 'children')])
    expect(children()).toContain(child.id)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: parentId, value: undefined }] })
    expect(children()).toContain(child.id)
    r.push({ type: 'update', rows: [issueRecord(child.id, { parentId: null })] })
    expect(children()).not.toContain(child.id)
    expect(
      runInAction(() => diffRelations(pool.graph, knownTables(pool, r.replay.source))),
    ).toEqual([])
  })

  it('removing a cold issue forgets it, and its cold sessions land in one batch', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
    expect(pool.residency?.isCold('issue', issue.id)).toBe(false)
    expectAskedThenLanded(
      r,
      sessions.map((session) => `session:${session.sessionId}`),
    )
    expect(diffResidency(pool, r.replay.source)).toEqual([])
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
    expect(tracked(() => pool.resident('session', session.sessionId))).toBe('resident')
    expect(
      tracked(() => [...pool.relations.many('issue', hotIssues[0]!.id, 'sessions')]),
    ).toContain(session.sessionId)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })

  it('a replace re-partitions: what was resident stays, the rest follows the rule', () => {
    const r = rig()
    const { pool } = r
    const [looked, untouched] = corpus.sliceIssues.filter(isCold)
    tracked(() => pool.resident('issue', looked!.id))
    r.fire()
    const { issues, sessions, worktrees } = records()
    // The same slice again, with one open issue now closed and one closed one reopened.
    const reopened = issues.map((record) =>
      record.id === untouched!.id
        ? issueRecord(untouched!.id, { closedAt: null, closedReason: null })
        : record,
    )
    r.push({ type: 'replace', rows: [...sessions, ...reopened, ...worktrees] })
    expect(tracked(() => pool.resident('issue', looked!.id))).toBe('resident')
    expect(tracked(() => pool.tables.issue.has(untouched!.id))).toBe(true)
    expect(hotIds(pool, 'issue')).toBe(hotIssues.length + 2)
    expect(diffResidency(pool, r.replay.source)).toEqual([])
  })
})

/**
 * POD-4745 (R3) — the rule's lane source. An issueless session running in an
 * issue's own checkout is one of its seats by containment
 * (`indexSessionOwnership`, session-ownership.ts:152-158), so it keeps a
 * closed issue drawn. The fixture has no closed row kept by such a session
 * alone, so each case builds one: a finished human child nothing else can
 * keep (cold by rule on the plain corpus, no member session), checked
 * out at a path no scan reports (the issue's own path is a root all the same),
 * and a run that never finished somewhere around it.
 */
describe('the lane source (R3, POD-4745)', () => {
  const LANE = '/r3/lane'
  // A finished human child past its own decay window: drawn only while a
  // session keeps it, and placed under its nearest drawn ancestor or at the
  // top level (never dropped like a top-level agent row).
  const target = corpus.sliceIssues.find(
    (issue) =>
      isCold(issue) &&
      issue.parentId != null &&
      issue.audience === 'human' &&
      issue.archived !== true &&
      issue.deletedAt == null &&
      issue.stage !== 'proposed' &&
      issue.stage !== 'shipping' &&
      issue.startedBySession == null &&
      !corpus.sliceSessions.some((session) => session.issueId === issue.id),
  )
  if (target === undefined) throw new Error('no cold finished human child without sessions')
  const issueId = target.id
  const openIssue = hotIssues.find((issue) => issue.closedAt == null)!
  /** The run: an issueless live session, never finished (it keeps without limit). */
  const RUN = 'r3-run'
  const run = (patch: Partial<SliceSession> = {}): SliceSession => ({
    sessionId: RUN,
    cwd: `${LANE}/src`,
    agentKind: 'claude-code',
    headless: false,
    status: 'live',
    archived: false,
    lastActiveAt: new Date(corpus.fixedNow).toISOString(),
    stoppedAt: null,
    readAt: null,
    unread: false,
    ...patch,
  })
  const lane = (path: string): SliceWorktree => ({ path, repoPath: '/r3', repoName: 'r3' })
  const runRecord = (patch: Partial<SliceSession> = {}): RowRecord => ({
    kind: 'session',
    id: RUN,
    value: run(patch),
  })
  /** The corpus rows with the target checked out at `worktreePath`, plus `sessions` and `lanes`. */
  function rows(
    worktreePath: string | null,
    sessions: readonly SliceSession[],
    lanes: readonly string[] = [],
  ): ReturnType<typeof records> {
    const base = records()
    return {
      issues: base.issues.map((record) =>
        record.id === issueId ? issueRecord(issueId, { worktreePath }) : record,
      ),
      sessions: [
        ...base.sessions,
        ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
      ],
      worktrees: [
        ...base.worktrees,
        ...lanes.map((path) => ({ kind: 'worktree' as const, id: path, value: lane(path) })),
      ],
    }
  }
  const resident = (pool: MobxPool, id = issueId) => tracked(() => pool.tables.issue.has(id))
  /**
   * Warmed by a publication that does not carry it: asked for (loading,
   * nothing read by id), then resident after one batch, the partition clean.
   */
  function expectWarmed(r: Rig): void {
    expect(r.pool.residency?.counters.warmed).toBeGreaterThanOrEqual(1)
    expectAskedThenLanded(r, [`issue:${issueId}`])
    expect(resident(r.pool)).toBe(true)
    expect(r.pool.residency?.isCold('issue', issueId)).toBe(false)
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
  }
  function expectCold(r: Rig): void {
    expect(r.pool.residency?.isCold('issue', issueId)).toBe(true)
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
  }

  it('a closed issue only an issueless run in its checkout keeps is resident at startup and drawn, as the oracle draws it', () => {
    const r = rig({ rows: rows(LANE, [run()]) })
    expect(resident(r.pool)).toBe(true)
    expect(r.pool.residency?.isCold('issue', issueId)).toBe(false)
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
    const drawn = tracked(() => [...r.pool.worklist.order])
    // The oracle: the legacy derivation over the same corpus change.
    const legacy = buildCorpus(1)
    // Both spellings: the legacy model takes the projection's when present.
    const wire = legacy.issues.find((issue) => issue.id === issueId)!
    ;(wire as { worktreePath?: string | null }).worktreePath = LANE
    const projection = legacy.issueProjections.find((issue) => issue.id === issueId)
    if (projection !== undefined) (projection as { worktreePath?: string }).worktreePath = LANE
    const template = legacy.sessions.find((session) => session.issueId == null)!
    legacy.sessions.push({
      ...template,
      sessionId: RUN,
      issueId: undefined,
      cwd: `${LANE}/src`,
      agentKind: 'claude-code',
      status: 'live',
      archived: false,
      headless: false,
      lastActiveAt: new Date(corpus.fixedNow).toISOString(),
      stoppedAt: undefined,
      agentState: undefined,
      resume: undefined,
    } as unknown as (typeof legacy.sessions)[number])
    const locals = { selectedIssueId: null, coarseNow: legacy.fixedNow }
    const oracle = visibleIssueRows(runLegacyDerivation(legacy, locals), locals).map(
      (row) => row.issue.id,
    )
    expect(oracle).toContain(issueId)
    expect(drawn).toContain(issueId)
    expect([...drawn].sort()).toEqual([...oracle].sort())
    // Without the run the same row is cold and not drawn (the case is live).
    const control = rig({ rows: rows(LANE, []) })
    expect(control.pool.residency?.isCold('issue', issueId)).toBe(true)
    expect(tracked(() => [...control.pool.worklist.order])).not.toContain(issueId)
  })

  it('startup reads no row by id: the replace carries what its lane keeps, and cold twins are decided from what it handed over (POD-4753)', () => {
    // A closed issue's session and a resumed twin of it, both finished long
    // ago: a twin group of cold rows only, which the collapse must decide.
    const { issue: closed, sessions } = closedWithSessions(1)
    const original = sessions[0]!
    const resume = { kind: 'claude', value: 'r3-cold-twins' }
    const finished = new Date(corpus.fixedNow - 40 * 24 * 60 * 60 * 1000).toISOString()
    const twin: SliceSession = {
      ...original,
      sessionId: 'r3-cold-twin',
      resume,
      status: 'exited',
      stoppedAt: finished,
      lastActiveAt: finished,
      readAt: finished,
      unread: false,
    }
    const base = rows(LANE, [run(), twin])
    base.sessions = base.sessions.map((record) =>
      record.id === original.sessionId ? { ...record, value: { ...original, resume } } : record,
    )
    const r = rig({ rows: base })
    // The setup holds: the twins and their issue are cold, the lane's issue kept.
    expect(r.pool.residency?.isCold('issue', closed.id)).toBe(true)
    expect(r.pool.residency?.isCold('session', original.sessionId)).toBe(true)
    expect(r.pool.residency?.isCold('session', twin.sessionId)).toBe(true)
    expect(resident(r.pool)).toBe(true)
    // Nothing read by id, nothing asked for.
    expect(r.loads).toEqual([])
    expect(r.pool.pendingLoads()).toBe(0)
    // And the pool is right: the partition, and every relation (the twins' collapse among them).
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
    expect(
      runInAction(() => diffRelations(r.pool.graph, knownTables(r.pool, r.replay.source))),
    ).toEqual([])
    const collapsed = [original.sessionId, twin.sessionId].filter((id) =>
      r.pool.graph.isCollapsed('session', id),
    )
    expect(collapsed).toHaveLength(1)
  })

  it('stays resident after the run leaves the checkout (nothing makes a hot row cold)', () => {
    const r = rig({ rows: rows(LANE, [run()]) })
    r.push({ type: 'update', rows: [runRecord({ cwd: '/elsewhere' })] })
    expect(resident(r.pool)).toBe(true)
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
  })

  it('warms when a run arrives in the checkout', () => {
    const r = rig({ rows: rows(LANE, []) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [runRecord()] })
    expectWarmed(r)
  })

  it('warms when a run in the checkout loses its issueId', () => {
    const r = rig({ rows: rows(LANE, [run({ issueId: openIssue.id })]) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [runRecord()] })
    expectWarmed(r)
  })

  it('warms when an issueless run moves into the checkout', () => {
    const r = rig({ rows: rows(LANE, [run({ cwd: '/elsewhere' })]) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [runRecord({ cwd: `${LANE}/deeper/still` })] })
    expectWarmed(r)
  })

  it('warms when a scanned lane that held the run disappears', () => {
    const inner = `${LANE}/inner`
    const r = rig({ rows: rows(LANE, [run({ cwd: `${inner}/x` })], [inner]) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [{ kind: 'worktree', id: inner, value: undefined }] })
    expectWarmed(r)
  })

  it("warms when the issue's own checkout becomes the run's lane", () => {
    // The run sits under a scanned lane; the issue then checks out a path
    // between them, which takes the run (a new, longer root).
    const r = rig({ rows: rows(null, [run({ cwd: `${LANE}/src` })], ['/r3']) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [issueRecord(issueId, { worktreePath: LANE })] })
    // The update carries the issue itself: installed from it, nothing asked for.
    expect(resident(r.pool)).toBe(true)
    expect(r.loads).toEqual([])
    expect(r.timers.filter((timer) => !timer.cancelled)).toEqual([])
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
  })

  it('warms when the issue checks out a lane the run already sits in (its own rule reads the lane)', () => {
    // No session moves: only the issue's update can see the run.
    const r = rig({ rows: rows(null, [run({ cwd: `${LANE}/src` })], [LANE]) })
    expectCold(r)
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [issueRecord(issueId, { worktreePath: LANE })] })
    expect(resident(r.pool)).toBe(true)
    expect(r.timers.filter((timer) => !timer.cancelled)).toEqual([])
    expect(diffResidency(r.pool, r.replay.source)).toEqual([])
  })

  it('warms when a resume-twin collapse flips the run in', () => {
    const resume = { kind: 'claude', value: 'r3-twin' }
    const twin = run({
      sessionId: 'r3-twin',
      cwd: '/elsewhere',
      status: 'hibernated',
      resume,
    })
    const r = rig({
      rows: rows(LANE, [run({ status: 'exited', resume }), twin]),
    })
    // The hibernated twin outranks the run: the run is collapsed away.
    expectCold(r)
    r.pool.stats.reset()
    r.push({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'r3-twin',
          value: {
            ...twin,
            status: 'exited',
            lastActiveAt: new Date(corpus.fixedNow - 1000).toISOString(),
          },
        },
      ],
    })
    expectWarmed(r)
  })

  it('leaves the issue cold when the run cannot keep it (finished long ago, headless, owned)', () => {
    const r = rig({ rows: rows(LANE, []) })
    const days = (n: number) => new Date(corpus.fixedNow - n * 24 * 60 * 60 * 1000).toISOString()
    r.pool.stats.reset()
    r.push({ type: 'update', rows: [runRecord({ stoppedAt: days(30), readAt: days(29) })] })
    r.push({ type: 'update', rows: [runRecord({ headless: true })] })
    r.push({ type: 'update', rows: [runRecord({ issueId: openIssue.id })] })
    expectCold(r)
    expect(r.pool.residency?.counters.warmed).toBe(0)
  })
})
