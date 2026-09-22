// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the pool's ingest, lifecycle and locals, on the 1x corpus
 * through a replay feed, with the reads fence on and the MobX warn trap armed.
 */

import { _getGlobalState, autorun, getObserverTree, type IReactionDisposer, runInAction } from 'mobx'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { writeResult } from '../../../harness/src/results'
import { buildCorpus } from '../../../harness/src/fixture/index'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence, type ReadFence } from '../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '../../../shared/src/locals-source'
import type { RowView } from '../../../shared/src/row-view'
import type { SliceIssue } from '../../../shared/src/slice-types'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { ENFORCEMENT } from './enforce'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'
import { ENTITIES } from './tables'
import { FINISHED_GRACE_MS } from './views'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()
const corpus = buildCorpus(1)

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  reads: ReadFence
  handle: MobxPoolHandle
  /** Feed subscriptions currently open (row source + locals). */
  listeners(): number
  push(event: RowSourceEvent): void
  dispose(): void
}

function rig(): Rig {
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({ kind: 'session', id: value.sessionId, value })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  let open = 0
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
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
  const handle = mobxPoolArm.create(reads.wrapSource(counted), localsSource, reads)
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

/** Observe every issue's view with one reaction each, like mounted rows do. */
function observeAll(handle: MobxPoolHandle): { views: Map<string, RowView | undefined>; stop(): void } {
  const views = new Map<string, RowView | undefined>()
  const stops: IReactionDisposer[] = []
  const ids = tracked(() => handle.pool.issueIds)
  for (const id of ids) {
    stops.push(
      autorun(() => {
        views.set(id, handle.pool.issue(id)?.view)
      }),
    )
  }
  return { views, stop: () => stops.forEach((stop) => stop()) }
}

function issueRecord(id: string, patch: Partial<SliceIssue> = {}): RowRecord {
  const base = corpus.sliceIssues.find((issue) => issue.id === id)
  if (base === undefined) throw new Error(`no corpus issue ${id}`)
  return { kind: 'issue', id, value: { ...base, ...patch } }
}

describe('enforcement', () => {
  it('is configured, and an untracked read trips the trap', () => {
    const state = _getGlobalState()
    expect(state.enforceActions).toBe(ENFORCEMENT.enforceActions)
    expect(state.computedRequiresReaction).toBe(true)
    expect(state.observableRequiresReaction).toBe(true)
    expect(state.reactionRequiresObservable).toBe(true)
    const r = rig()
    try {
      const id = corpus.sliceIssues[0]!.id
      const model = tracked(() => r.handle.pool.issue(id)!)
      expect(() => model.view).toThrow(/trapped.*outside a reactive context/)
      expect(trap.warnings.length).toBe(1)
      trap.warnings.length = 0
    } finally {
      r.dispose()
    }
  })
})

describe('ingest', () => {
  it('bootstraps every row into its table and builds no model until one is read', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const sizes = tracked(() => ENTITIES.map((entity) => pool.tables[entity].size))
      const repos = new Set(corpus.sliceWorktrees.map((lane) => lane.repoId).filter(Boolean))
      expect(sizes).toEqual([corpus.sliceIssues.length, corpus.sliceSessions.length, corpus.sliceWorktrees.length, repos.size])
      expect(repos.size).toBeGreaterThan(0)
      for (const entity of ENTITIES) expect(pool.modelCount(entity), entity).toBe(0)
      expect(pool.stats.counters.modelsCreated).toBe(0)
    } finally {
      r.dispose()
    }
  })

  it('stores the borrowed row object, and an unchanged row writes and notifies nothing', () => {
    const r = rig()
    const all = observeAll(r.handle)
    try {
      const { pool } = r.handle
      const id = corpus.sliceIssues[3]!.id
      const stored = runInAction(() => pool.tables.issue.get(id))
      expect(r.reads.isBorrowed(stored)).toBe(true)
      const before = all.views.get(id)
      pool.stats.reset()
      // The feed re-sends the very object it holds (a heartbeat-shaped no-op).
      r.push({ type: 'update', rows: [{ kind: 'issue', id, value: r.replay.source.snapshot('issue').find((row) => row.id === id)!.value }] })
      expect(pool.stats.counters.tableWrites).toBe(0)
      expect(pool.stats.notifications).toBe(0)
      expect(pool.stats.rowsDerived).toBe(0)
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
      const id = corpus.sliceIssues.find((issue) => !issue.draft)!.id
      const before = new Map(all.views)
      pool.stats.reset()
      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Renamed by the test' })] })
      expect(pool.stats.notifications).toBe(1)
      expect(pool.stats.counters.tableWrites).toBe(1)
      expect(pool.stats.rowsDerived).toBe(1)
      expect(all.views.get(id)?.title).toBe('Renamed by the test')
      const changed = [...all.views].filter(([key, view]) => before.get(key) !== view).map(([key]) => key)
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
      const keep = r.replay.source.snapshot('issue').slice(0, 5)
      const renamed = issueRecord(corpus.sliceIssues[7]!.id, { title: 'Reseeded' })
      const sessions = r.replay.source.snapshot('session').slice(0, 3)
      const lanes = r.replay.source.snapshot('worktree')
      const seen: [number, number][] = []
      const watch = autorun(() => {
        seen.push([pool.issueIds.length, pool.tables.session.size])
      })
      const heldBefore = runInAction(() => keep.map((row) => pool.tables.issue.get(row.id)))
      pool.stats.reset()
      r.push({ type: 'replace', rows: [...sessions, ...keep, renamed, ...lanes] })
      watch()
      expect(seen).toEqual([
        [corpus.sliceIssues.length, corpus.sliceSessions.length],
        [6, 3],
      ])
      expect(pool.stats.notifications).toBe(1)
      const heldAfter = runInAction(() => keep.map((row) => pool.tables.issue.get(row.id)))
      expect(heldAfter).toEqual(heldBefore)
      heldAfter.forEach((row, i) => expect(row).toBe(heldBefore[i]))
      const removed = corpus.sliceIssues.length - 6 + corpus.sliceSessions.length - 3
      expect(pool.stats.counters.rowsRemoved).toBe(removed)
      // Every write was a removal or the one renamed row: the kept rows and
      // lanes were not rewritten.
      expect(pool.stats.counters.tableWrites).toBe(removed + 1)
    } finally {
      r.dispose()
    }
  })

  it('removes a row with its model, and a re-added row reaches its observers', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const id = corpus.sliceIssues.find((issue) => !issue.draft)!.id
      const titles: (string | undefined)[] = []
      const watch = autorun(() => {
        titles.push(pool.issue(id)?.view?.title)
      })
      expect(pool.modelCount('issue')).toBe(1)
      r.push({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      expect(runInAction(() => pool.tables.issue.has(id))).toBe(false)
      expect(pool.modelCount('issue')).toBe(0)
      expect(pool.stats.counters.rowsRemoved).toBe(1)
      r.push({ type: 'update', rows: [issueRecord(id, { title: 'Back again' })] })
      watch()
      expect(titles).toEqual([corpus.sliceIssues.find((issue) => issue.id === id)!.title, undefined, 'Back again'])
    } finally {
      r.dispose()
    }
  })

  it('derives a repo from its lane, and removes it with the lane that holds it', () => {
    const r = rig()
    try {
      const { pool } = r.handle
      const byRepo = new Map<string, string[]>()
      for (const lane of corpus.sliceWorktrees) if (lane.repoId) byRepo.set(lane.repoId, [...(byRepo.get(lane.repoId) ?? []), lane.path])
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
      const [a, b] = corpus.sliceIssues.map((issue) => issue.id)
      r.locals.set({ selectedIssueId: a! })
      r.locals.flush()
      expect(all.views.get(a!)?.selected).toBe(true)
      r.handle.pool.stats.reset()
      r.locals.set({ selectedIssueId: b! })
      r.locals.flush()
      expect(r.handle.pool.stats.rowsDerived).toBe(2)
      expect(all.views.get(a!)?.selected).toBe(false)
      expect(all.views.get(b!)?.selected).toBe(true)
    } finally {
      all.stop()
      r.dispose()
    }
  })

  it('a tick re-derives only the rows whose deadline it crosses', () => {
    const r = rig()
    const all = observeAll(r.handle)
    try {
      const { pool } = r.handle
      const waiting = pool.clock.waiting
      expect(waiting).toBeGreaterThan(0)
      let crossings = pool.clock.crossings
      pool.stats.reset()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 })
      r.locals.flush()
      // Every re-derivation is a crossing (a row reading two deadlines may
      // cross both, so crossings bound re-derivations from above).
      expect(pool.stats.rowsDerived).toBeLessThanOrEqual(pool.clock.crossings - crossings)
      const beforeGrace = new Map(all.views)
      crossings = pool.clock.crossings
      pool.stats.reset()
      r.locals.set({ coarseNow: corpus.fixedNow + 60_000 + FINISHED_GRACE_MS })
      r.locals.flush()
      const changed = [...all.views].filter(([id, view]) => beforeGrace.get(id) !== view).length
      expect(pool.stats.rowsDerived).toBeLessThanOrEqual(pool.clock.crossings - crossings)
      expect(pool.stats.rowsDerived).toBeGreaterThan(0)
      expect(pool.stats.rowsDerived).toBeLessThan(corpus.sliceIssues.length / 4)
      expect(changed).toBeGreaterThan(0)
      writeResult('mobx-pool-tick-1x', {
        issues: corpus.sliceIssues.length,
        deadlinesWaitedOn: waiting,
        graceTick: { rowsDerived: pool.stats.rowsDerived, viewsChanged: changed, crossings: pool.clock.crossings - crossings },
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
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(corpus.sliceIssues.length)
    const texts = [...el.querySelectorAll('[data-issue-row]')].map((row) => row.textContent ?? '')
    expect(texts.filter((text) => /^POD-\d+ /.test(text)).length).toBeGreaterThan(corpus.sliceIssues.length / 2)
    const models = tracked(() => pool.issueIds.map((id) => pool.issue(id)!))
    r.locals.set({ selectedIssueId: models[0]!.id })
    r.locals.flush()
    expect(r.listeners()).toBe(2)
    expect(getObserverTree(pool, 'issueIds').observers?.length ?? 0).toBeGreaterThan(0)

    await act(async () => {
      r.dispose()
    })

    expect(r.listeners()).toBe(0)
    expect(el.querySelectorAll('[data-issue-row]').length).toBe(0)
    expect(tracked(() => ENTITIES.map((entity) => pool.tables[entity].size))).toEqual([0, 0, 0, 0])
    for (const entity of ENTITIES) {
      expect(pool.modelCount(entity), entity).toBe(0)
      expect(getObserverTree(pool.tables[entity]).observers ?? [], entity).toEqual([])
    }
    expect(tracked(() => pool.selection.size)).toBe(0)
    expect(getObserverTree(pool, 'issueIds').observers ?? []).toEqual([])
    for (const model of models) expect(getObserverTree(model, 'view').observers ?? []).toEqual([])
    expect(pool.clock.waiting).toBe(0)
    expect(_getGlobalState().pendingReactions.length).toBe(0)
    // After disposal the feed can publish; nothing listens.
    r.push({ type: 'update', rows: [issueRecord(models[1]!.id, { title: 'after dispose' })] })
    expect(tracked(() => pool.tables.issue.size)).toBe(0)
    el.remove()
  })
})
