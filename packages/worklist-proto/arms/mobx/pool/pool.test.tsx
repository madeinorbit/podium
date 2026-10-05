// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the pool's ingest, lifecycle and locals, on the 1x corpus
 * through a replay feed, with the reads fence on and the MobX warn trap armed.
 */

import { isDeepStrictEqual } from 'node:util'
import {
  autorun,
  getObserverTree,
  type IReactionDisposer,
  runInAction,
} from 'mobx'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence, type ReadFence } from '../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '@podium/client-graph/shared/locals-source'
import { type RowView } from '@podium/client-graph/shared/row-view'
import { SCHEMA, tableColdRule } from '@podium/client-graph/shared/schema'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type HarnessMobxPoolHandle, harnessMobxPoolArm, poolPendingLoads, tracked, visibleOrderOf } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { rowViewOf } from '@podium/client-graph/models'
import { ENTITIES } from '@podium/client-graph/tables'
import { FINISHED_GRACE_MS } from '@podium/client-graph/views'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()
const corpus = buildCorpus(1)
/** Open issues: resident from bootstrap (POD-4567; closed ones are cold). */
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
    (entity) =>
      entity === 'issue'
        ? issues
        : entity === 'session'
          ? sessions
          : entity === 'worktree'
            ? new Map(corpus.sliceWorktrees.map((lane) => [lane.path, lane]))
            : undefined,
    corpus.fixedNow,
  )
  return corpus.sliceIssues.filter((issue) => !cold('issue', issue.id))
})()

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  reads: ReadFence
  handle: HarnessMobxPoolHandle
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
  // The load window never fires on its own: a test closes it (`pool.hydrate()`).
  const handle = harnessMobxPoolArm.create(reads.wrapSource(counted), localsSource, reads, {
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

/**
 * Observe every issue's row with one reaction each, reading every row field
 * off the issue as a mounted row does (POD-4756), and count each row's
 * re-runs (`rerun`: the rows a change redrew, since `resetRuns`).
 */
function observeAll(handle: HarnessMobxPoolHandle): {
  views: Map<string, RowView | undefined>
  rerun: Set<string>
  resetRuns(): void
  stop(): void
} {
  const views = new Map<string, RowView | undefined>()
  const rerun = new Set<string>()
  const stops: IReactionDisposer[] = []
  const ids = tracked(() => [...handle.pool.tables.issue.keys()])
  for (const id of ids) {
    stops.push(
      autorun(() => {
        views.set(id, rowViewOf(handle.pool.issue(id)))
        rerun.add(id)
      }),
    )
  }
  rerun.clear()
  return {
    views,
    rerun,
    resetRuns: () => rerun.clear(),
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

describe('enforcement', () => {
  it('is configured, and an untracked read trips the trap', () => {
    const r = rig()
    try {
      const id = openIssues[0]!.id
      const model = tracked(() => r.handle.pool.issue(id)!)
      expect(() => model.title).toThrow(/trapped.*outside a reactive context/)
      expect(trap.warnings.length).toBe(1)
      trap.warnings.length = 0
    } finally {
      r.dispose()
    }
  })
})

describe('ingest', () => {
  it('bootstraps every resident row into its table and builds only the worklist\'s objects', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const sizes = tracked(() => ENTITIES.map((entity) => pool.tables[entity].size))
      const repos = new Set(corpus.sliceWorktrees.map((lane) => lane.repoId).filter(Boolean))
      // Hot plus cold is every row; the split itself is residency.test.ts's.
      // POD-5407: the cold rows are the ones the index knows and the pool does not hold.
      const cold = tracked(() => ENTITIES.map((entity) =>
        pool.residency?.capable(entity) === true ? pool.coldIndex().count(entity) - pool.tables[entity].size : 0))
      expect(sizes.map((size, i) => size + cold[i]!)).toEqual([
        corpus.sliceIssues.length,
        corpus.sliceSessions.length,
        corpus.sliceWorktrees.length,
        repos.size,
      ])
      expect(sizes[0]).toBe(residentIssues.length)
      expect(repos.size).toBeGreaterThan(0)
      // One filing reaction per issue in memory (POD-4945: read per id, since
      // the product exposes no tracked count), and no worktree or repo
      // object until one is read. Model identity is the tracking gate's
      // (`tracking-counts.test.ts` counts IssueModel owners from outside).
      for (const id of tracked(() => [...pool.tables.issue.keys()])) {
        expect(pool.worklist.tracks(id), `hot ${id} is tracked`).toBe(true)
      }
      for (const id of corpus.sliceIssues.map((issue) => issue.id).filter((id) => pool.residency?.isCold('issue', id))) {
        expect(pool.worklist.tracks(id), `cold ${id} is tracked`).toBe(false)
      }
    } finally {
      r.dispose()
    }
  })

  it('stores the borrowed row object, and an unchanged row writes and notifies nothing', () => {
    const r = rig()
    const all = observeAll(r.handle)
    try {
      const { pool } = r.handle
      const id = openIssues[3]!.id
      const stored = runInAction(() => pool.tables.issue.get(id))
      expect(r.reads.isBorrowed(stored)).toBe(true)
      const before = all.views.get(id)
      all.resetRuns()
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
      // Every issue in memory already holds its filing reaction, so nothing
      // moves at all: no reaction built, no membership flip, no row field
      // re-derived, no row re-rendered.
      expect([...all.rerun]).toEqual([])
      expect(all.views.get(id)).toBe(before)
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('applies an update per row: only the changed row re-derives and changes identity', () => {
    const r = rig()
    const all = observeAll(r.handle)
    try {
      const { pool } = r.handle
      const id = openIssues.find((issue) => !issue.isDraftVessel)!.id
      const before = new Map(all.views)
      all.resetRuns()
      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Renamed by the test' })] })
      // Exactly the renamed row redraws; the fields that re-derive are its own.
      expect([...all.rerun]).toEqual([id])
      expect(all.views.get(id)?.title).toBe('Renamed by the test')
      const changed = [...all.views]
        .filter(([key, view]) => before.get(key) !== view)
        .map(([key]) => key)
      expect(changed).toEqual([id])
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('replaces atomically: observers see one transition, unchanged rows keep their objects, the rest leave', () => {
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
      const hotBefore = tracked(() => [pool.tables.issue.size, pool.tables.session.size] as const)
      const seen: [number, number][] = []
      const watch = autorun(() => {
        seen.push([pool.tables.issue.size, pool.tables.session.size])
      })
      const heldBefore = runInAction(() => keep.map((row) => pool.tables.issue.get(row.id)))
      r.push({ type: 'replace', rows: [...sessions, ...keep, renamed, ...lanes] })
      watch()
      expect(seen).toEqual([[...hotBefore], [6, 3]])
      const heldAfter = runInAction(() => keep.map((row) => pool.tables.issue.get(row.id)))
      expect(heldAfter).toEqual(heldBefore)
      for (const [i, row] of heldAfter.entries()) expect(row).toBe(heldBefore[i])
      // The kept rows and lanes were not rewritten: observers saw one transition.
      expect(pool.residency?.ids('issue')).toEqual([])
      expect(pool.residency?.ids('session')).toEqual([])
    } finally {
      r.dispose()
    }
  })

  it('removes a row with its model, and a re-added row reaches its observers', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      // No spin-off origin: its view would build the origin's model too.
      const id = openIssues.find(
        (issue) => !issue.isDraftVessel && !issue.deps?.some((dep) => dep.type === 'discovered-from'),
      )!.id
      const titles: (string | undefined)[] = []
      const watch = autorun(() => {
        titles.push(rowViewOf(pool.issue(id))?.title)
      })
      r.push({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      expect(runInAction(() => pool.tables.issue.has(id))).toBe(false)
      expect(tracked(() => pool.issue(id))).toBeUndefined()
      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Back again' })] })
      watch()
      expect(titles).toEqual([
        corpus.sliceIssues.find((issue) => issue.id === id)!.title,
        undefined,
        'Back again',
      ])
    } finally {
      r.dispose()
    }
  })

  it('derives a repo from its lane, and removes it with the lane that holds it', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const byRepo = new Map<string, string[]>()
      for (const lane of corpus.sliceWorktrees)
        if (lane.repoId) byRepo.set(lane.repoId, [...(byRepo.get(lane.repoId) ?? []), lane.path])
      const [repoId, paths] = [...byRepo].find(([, list]) => list.length === 1)!
      const prefix = tracked(() => pool.model('repo', repoId)?.prefix)
      expect(prefix).toBe(corpus.sliceWorktrees.find((lane) => lane.repoId === repoId)!.prefix)
      r.push({ type: 'update', rows: [{ kind: 'worktree', id: paths[0]!, value: undefined }] })
      expect(runInAction(() => pool.tables.repo.has(repoId))).toBe(false)
      expect(runInAction(() => pool.tables.worktree.has(paths[0]!))).toBe(false)
    } finally {
      r.dispose()
    }
  })
})

describe('locals', () => {
  it('a click re-derives exactly the old and the new selection', () => {
    const r = rig()
    const all = observeAll(r.handle)
    try {
      const [a, b] = openIssues.map((issue) => issue.id)
      r.locals.set({ selectedIssueId: a! })
      r.locals.flush()
      expect(all.views.get(a!)?.selected).toBe(true)
      all.resetRuns()
      r.locals.set({ selectedIssueId: b! })
      r.locals.flush()
      // Exactly the two rows redraw; no row field re-derives (`selected` is a
      // keyed read of the selection, not a derivation).
      expect([...all.rerun].sort()).toEqual([a!, b!].sort())
      expect(all.views.get(a!)?.selected).toBe(false)
      expect(all.views.get(b!)?.selected).toBe(true)
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('a tick re-derives only the rows whose deadline it crosses', () => {
    const r = rig()
    // The grace crossings are closed rows, cold at bootstrap: load every
    // closed issue first, so the tick meets the rows a1 measured.
    const { pool } = r.handle
    tracked(() => {
      for (const issue of corpus.sliceIssues) pool.resident('issue', issue.id)
    })
    pool.hydrate()
    expect(pool.residency?.ids('issue')).toEqual([])
    const all = observeAll(r.handle)
    try {
      let crossings = pool.clock.crossings
      all.resetRuns()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 })
      r.locals.flush()
      // Every redrawn row is a crossing (a row reading two deadlines may
      // cross both, so crossings bound the redrawn rows from above).
      expect(all.rerun.size).toBeLessThanOrEqual(pool.clock.crossings - crossings)
      const beforeGrace = new Map(all.views)
      crossings = pool.clock.crossings
      all.resetRuns()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 + FINISHED_GRACE_MS })
      r.locals.flush()
      const changed = [...all.views].filter(
        ([id, view]) => !isDeepStrictEqual(beforeGrace.get(id), view),
      ).length
      expect(all.rerun.size).toBeLessThanOrEqual(pool.clock.crossings - crossings)
      expect(all.rerun.size).toBeGreaterThan(0)
      // Row fields re-derived: a few per crossing (`closed`, `dismissed`), never the corpus.
      expect(changed).toBeGreaterThan(0)
      writeResult('mobx-pool-tick-1x', {
        issues: corpus.sliceIssues.length,
        graceTick: {
          viewsChanged: changed,
          crossings: pool.clock.crossings - crossings,
        },
      })
    } finally {
      all.stop()
      r.dispose()
    }
  })
})

describe('dispose', () => {
  it('leaves no listener, no observer, no model and empty tables', async () => {
    const r = rig()
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => {
      r.handle.mountWeb(el)
    })
    const { pool } = r.handle
    // Mb1 (POD-4569): the list draws the visible rows; cold ones wait for their load.
    const visibleHot = tracked(
      () => visibleOrderOf(pool).filter((id) => pool.tables.issue.has(id)).length,
    )
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(visibleHot)
    const texts = [...el.querySelectorAll('[data-issue-row]')].map((row) => row.textContent ?? '')
    expect(texts.filter((text) => /^POD-\d+ /.test(text)).length).toBeGreaterThan(visibleHot / 2)
    // A reader asked for a cold row: queued, and disposal must drop the
    // queue with everything else.
    const closed = corpus.sliceIssues.find((issue) => issue.closedAt != null)!
    expect(tracked(() => pool.resident('issue', closed.id))).toBe('loading')
    expect(poolPendingLoads(pool)).toBe(1)
    const models = tracked(() => [...pool.tables.issue.keys()].map((id) => pool.issue(id)!))
    r.locals.set({ selectedIssueId: models[0]!.id })
    r.locals.flush()
    expect(r.listeners()).toBe(2)
    expect(getObserverTree(pool.groups, 'keys').observers?.length ?? 0).toBeGreaterThan(0)
    expect(tracked(() => visibleOrderOf(pool).length)).toBeGreaterThan(0)

    await act(async () => {
      r.dispose()
    })

    expect(r.listeners()).toBe(0)
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(0)
    expect(tracked(() => ENTITIES.map((entity) => pool.tables[entity].size))).toEqual([0, 0, 0, 0])
    for (const entity of ENTITIES) {
      expect(getObserverTree(pool.tables[entity]).observers ?? [], entity).toEqual([])
    }
    expect(tracked(() => pool.selection.size)).toBe(0)
    expect(getObserverTree(pool.groups, 'keys').observers ?? []).toEqual([])
    expect(tracked(() => visibleOrderOf(pool))).toEqual([])
    expect(tracked(() => pool.issue(models[0]!.id))).toBeUndefined()
    // A row view is a cached group on its issue, dropped once unobserved; one
    // still observed would observe its table slots, which the check above
    // finds empty.
    expect(poolPendingLoads(pool)).toBe(0)
    expect(ENTITIES.map((entity) => pool.residency?.ids(entity))).toEqual([[], [], [], []])
    // After disposal the feed can publish; nothing listens.
    r.push({ type: 'update', rows: [issueRecord(models[1]!.id, { title: 'after dispose' })] })
    expect(tracked(() => pool.tables.issue.size)).toBe(0)
    el.remove()
  })
})
