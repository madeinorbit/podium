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
import { writeResult } from '../../../harness/src/results'
import type { RowSource } from '../../../shared/src/arm'
import {
  createReadFence,
  DISABLED_READ_FENCE,
  type ReadFence,
} from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import type { RowView } from '../../../shared/src/row-view'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { diffResidency } from './enumerate'
import { installMobxWarnTrap } from './mobx-trap'
import { MobxPool, tracked } from './pool'
import { LOAD_WINDOW_MS } from './residency'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()
const corpus = buildCorpus(1)
const issueById = new Map(corpus.sliceIssues.map((issue) => [issue.id, issue]))
const isClosed = (issue: SliceIssue | undefined): boolean => issue?.closedAt != null
/** The rule, restated from the schema doc §5 (not from the code under test). */
const hotIssues = corpus.sliceIssues.filter((issue) => !isClosed(issue))
const hotSessions = corpus.sliceSessions.filter(
  (session) => !(session.issueId != null && isClosed(issueById.get(session.issueId))),
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

function rig(options: { fence?: boolean; realTimer?: boolean } = {}): Rig {
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
    if (!isClosed(issue)) continue
    const sessions = corpus.sliceSessions.filter(
      (session) => session.issueId === issue.id && session.headless !== true,
    )
    if (sessions.length >= n) return { issue, sessions }
  }
  throw new Error(`no closed issue with ${n} sessions`)
}

const hotIds = (pool: MobxPool, entity: 'issue' | 'session'): number =>
  tracked(() => pool.tables[entity].size)

describe('bootstrap', () => {
  it('constructs only the hot rows: the open issues and their sessions, by count', () => {
    // The number the brief names (~2,200 open issues at 1x) from the corpus itself.
    expect(hotIssues.length).toBeGreaterThan(2_000)
    expect(hotIssues.length).toBeLessThan(2_400)
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
    expect(pool.stats.counters.modelsCreated).toBe(0)
    expect(pool.residency?.counters.requests).toBe(0)
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

  it('makes no model observable before first access: models == rows the mounted list drew', async () => {
    const r = rig()
    const { pool } = r
    expect(pool.stats.counters.modelsCreated).toBe(0)
    const el = document.createElement('div')
    document.body.append(el)
    let unmount = (): void => {}
    await act(async () => {
      unmount = r.handle.mountWeb(el)
    })
    const drawn = [...el.querySelectorAll('[data-issue-row]')].map((row) =>
      row.getAttribute('data-issue-row'),
    )
    expect(drawn.length).toBe(hotIssues.length)
    // A drawn row's activity re-composes from its member sessions' cached
    // values (POD-4568), so its resident members get a model too: models ==
    // rows drawn + their resident member sessions, nothing else.
    const members = new Set(
      tracked(() => drawn.flatMap((id) => pool.issue(id!)?.sessionIds ?? [])).filter(
        (id) => tracked(() => pool.resident('session', id)) === 'resident',
      ),
    )
    expect(members.size).toBeGreaterThan(0)
    expect(pool.modelCount('issue')).toBe(drawn.length)
    expect(pool.modelCount('session')).toBe(members.size)
    expect(pool.stats.counters.modelsCreated).toBe(drawn.length + members.size)
    // No cold row got a model, and none was drawn.
    for (const issue of corpus.sliceIssues) {
      if (isClosed(issue)) expect(tracked(() => pool.resident('issue', issue.id))).toBe('loading')
    }
    expect(pool.modelCount('issue')).toBe(drawn.length)
    await act(async () => {
      unmount()
    })
    el.remove()
  })
})

describe('the loader', () => {
  it('loads every row asked for inside one 50 ms window through the per-row read, in one action', () => {
    const r = rig()
    const { pool } = r
    const [a, b] = corpus.sliceIssues.filter(isClosed)
    const seen: string[] = []
    const watch = autorun(() => {
      const state = pool.resident('issue', a!.id)
      const view = pool.issue(a!.id)?.view
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
    // One read per row, one action, both resident.
    expect([...r.loads].sort()).toEqual([`issue:${a!.id}`, `issue:${b!.id}`].sort())
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
    const closed = corpus.sliceIssues.find(isClosed)!
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
    const closed = corpus.sliceIssues.find(isClosed)!
    expect(tracked(() => r.pool.resident('issue', closed.id))).toBe('loading')
    await new Promise((resolve) => setTimeout(resolve, LOAD_WINDOW_MS + 30))
    expect(tracked(() => r.pool.resident('issue', closed.id))).toBe('resident')
    expect(r.pool.residency?.hasQueued()).toBe(false)
  })

  it('loads the current value: an update to a cold row that keeps it cold is not stored', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isClosed)!
    pool.stats.reset()
    r.push({ type: 'update', rows: [issueRecord(closed.id, { title: 'Renamed while cold' })] })
    expect(tracked(() => pool.tables.issue.has(closed.id))).toBe(false)
    expect(pool.residency?.isCold('issue', closed.id)).toBe(true)
    expect(pool.stats.counters.tableWrites).toBe(0)
    expect(pool.stats.notifications).toBe(1)
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('loading')
    r.fire()
    expect(tracked(() => pool.issue(closed.id)?.view?.title)).toBe('Renamed while cold')
  })

  it('leaves a row whose read finds nothing cold until its removal arrives', () => {
    const r = rig()
    const { pool } = r
    const closed = corpus.sliceIssues.find(isClosed)!
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
        !isClosed(issueById.get(id)) && list.some(isClosed) && list.some((kid) => !isClosed(kid)),
    )!
    const hot = kids.filter((kid) => !isClosed(kid)).map((kid) => kid.id)
    const cold = kids.filter(isClosed).map((kid) => kid.id)
    const seen: { ready: number; pending: number }[] = []
    const watch = autorun(() => {
      const members = pool.lazyMany('issue', parentId, 'children')
      seen.push({ ready: members.ready.length, pending: members.pending })
    })
    // The bucket holds every child id, hot or cold; nothing cold was built.
    expect(tracked(() => [...pool.relations.many('issue', parentId, 'children')])).toEqual(
      kids.map((kid) => kid.id).sort(),
    )
    expect(tracked(() => pool.lazyMany('issue', parentId, 'children').ready)).toEqual(
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
        isClosed(issueById.get(session.issueId)),
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
      views.push(pool.issue(issue.id)?.view)
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
    const latest = Math.max(...sessions.map((session) => Date.parse(session.lastActiveAt)))
    expect(last.activityAt).toBe(latest)
  })

  it('a spin-off of a cold origin shows loading, then its tick', () => {
    const r = rig()
    const { pool } = r
    const origin = corpus.sliceIssues.find(isClosed)!
    const spinOff = hotIssues.find((issue) => (issue.deps ?? []).length === 0 && !issue.draft)!
    const views: (RowView | undefined)[] = []
    const watch = autorun(() => {
      views.push(pool.issue(spinOff.id)?.view)
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
    const cold = corpus.sliceIssues.find((issue) => isClosed(issue) && issue.parentId != null)!
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
  it('a reopened issue is resident at once, with its sessions, in one action', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    pool.stats.reset()
    r.push({
      type: 'update',
      rows: [issueRecord(issue.id, { closedAt: null, closedReason: null })],
    })
    expect(pool.stats.notifications).toBe(1)
    expect(tracked(() => pool.tables.issue.has(issue.id))).toBe(true)
    for (const session of sessions) {
      expect(tracked(() => pool.tables.session.has(session.sessionId))).toBe(true)
    }
    expect(pool.residency?.counters.warmed).toBeGreaterThanOrEqual(sessions.length)
    expect(r.timers).toEqual([])
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

  it('removing a cold issue forgets it, and its cold sessions become resident', () => {
    const r = rig()
    const { pool } = r
    const { issue, sessions } = closedWithSessions(1)
    r.push({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
    expect(pool.residency?.isCold('issue', issue.id)).toBe(false)
    for (const session of sessions) {
      expect(tracked(() => pool.resident('session', session.sessionId))).toBe('resident')
    }
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
    const [looked, untouched] = corpus.sliceIssues.filter(isClosed)
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
