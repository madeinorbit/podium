// @vitest-environment happy-dom
/**
 * POD-4743 — the pool's one row reader (`MobxPool.row`) on a row that is not
 * in memory.
 *
 * Under the declared cold rule no VISIBLE row is cold (POD-4665), so the
 * test keeps one visible issue out of memory from the harness side (POD-4945:
 * the product has no out-of-memory knob): it evicts the row, re-applies it
 * while the residency's own rule answers cold for it, and tracks it by hand.
 * The mounted list draws it as loading, the reader answers `LOADING` and
 * queues it, ONE load window requests it, and once that batch lands the
 * list, the snapshot and the rebuild equal an all-in-memory pool's.
 */

import { act } from 'react'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import type { RowRecord } from '../../../shared/src/stats'
import {
  type HarnessMobxPoolHandle,
  harnessMobxPoolArm,
  poolPendingLoads,
  tracked,
  visibleOrderOf,
} from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()
const corpus = buildCorpus(1)

function records(): RowRecord[] {
  return [
    ...corpus.sliceSessions.map((value): RowRecord => ({ kind: 'session', id: value.sessionId, value })),
    ...corpus.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
    ...corpus.sliceWorktrees.map((value): RowRecord => ({ kind: 'worktree', id: value.path, value })),
  ]
}

interface Rig {
  readonly handle: HarnessMobxPoolHandle
  readonly replay: ReplaySource
  /** Per-row reads through the feed, `kind:id`. */
  readonly loads: string[]
  /** Load windows armed and not cancelled. */
  armed(): (() => void)[]
  dispose(): void
}

let open: Rig[] = []

function rig(): Rig {
  const all = records()
  const replay = createReplaySource({
    issues: all.filter((r) => r.kind === 'issue'),
    sessions: all.filter((r) => r.kind === 'session'),
    worktrees: all.filter((r) => r.kind === 'worktree'),
  })
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
  const timers: { run: () => void; cancelled: boolean }[] = []
  const handle = harnessMobxPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const r: Rig = {
    handle,
    replay,
    loads,
    armed: () =>
      timers
        .filter((timer) => !timer.cancelled)
        .map((timer) => () => {
          timer.cancelled = true
          timer.run()
        }),
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

function drawnRows(el: Element): string[] {
  return [...el.querySelectorAll('[data-issue-row]')].map((row) => row.getAttribute('data-issue-row')!)
}

/**
 * Keep `id` out of memory beside the declared rule, from the harness side
 * (POD-4945): the product has no out-of-memory knob. The row is evicted,
 * then re-applied while the residency's own rule answers cold for it, and
 * tracked by hand with its cold marker forced off — the two things the
 * pool did for such a row. Only existing public methods are driven; no
 * second tracking path is added. Returns the restore (call inside an
 * action): the rule answers by the schema again and the hand tracking ends.
 */
function forceCold(pool: MobxPool, replay: ReplaySource, id: string): () => void {
  const residency = pool.residency!
  const value = replay.source.snapshot('issue').find((record) => record.id === id)?.value
  if (value === undefined) throw new Error(`no feed row ${id}`)
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
  const coldRule = residency.coldRule.bind(residency)
  residency.coldRule = (entity, row) =>
    entity === 'issue' && (row as { id?: unknown }).id === id ? true : coldRule(entity, row)
  const row = pool.row.bind(pool)
  // Visibility uses the one reader's non-loading marker to distinguish cold
  // rows. Only this held-out fixture bypasses that marker; drawing still
  // requests the real row through the ordinary loading mode below.
  pool.row = ((entity: string, rowId: string, absent?: string) =>
    entity === 'issue' && rowId === id && absent === 'mark' ? undefined :
      (row as Function)(entity, rowId, absent)) as typeof pool.row
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value }] })
  runInAction(() => pool.worklist.track(id))
  return () => {
    residency.coldRule = coldRule
    pool.row = row
    pool.worklist.untrack(id)
  }
}

/** How many rows the load queue holds, read without landing them (take, then ask again). */
function queuedCount(pool: MobxPool): number {
  const residency = pool.residency!
  const batch = residency.take()
  for (const [entity, id] of batch) residency.request(entity, id)
  return batch.length
}

describe('POD-4743 the one row reader, not in memory', () => {
  it('a visible issue out of memory draws loading, loads in one batch, and converges', async () => {
    // The all-in-memory result, and one visible issue with a view to hide.
    const eager = rig()
    const want = eager.handle.snapshot()
    // No sub-issues: a row's closed family is asked for only once the row
    // itself is drawn (POD-4754), so a held-out row with one would defer it.
    const target = Object.keys(want.rowsById).find(
      (id) =>
        corpus.sliceIssues.find((issue) => issue.id === id)?.isDraftVessel !== true &&
        !corpus.sliceIssues.some((issue) => issue.parentId === id),
    )
    expect(target).toBeDefined()
    const id = target!
    const eagerEl = document.createElement('div')
    document.body.append(eagerEl)
    let unmountEager = (): void => {}
    await act(async () => {
      unmountEager = eager.handle.mountWeb(eagerEl)
    })
    const wantDrawn = drawnRows(eagerEl)
    expect(wantDrawn).toContain(id)
    unmountEager()
    // What drawing the list queues anyway before any window closes (other
    // rows' cold origins, seats and closed children), on a fresh pool.
    const fresh = rig()
    const freshEl = document.createElement('div')
    document.body.append(freshEl)
    let unmountFresh = (): void => {}
    await act(async () => {
      unmountFresh = fresh.handle.mountWeb(freshEl)
    })
    const eagerQueued = queuedCount(fresh.handle.pool)
    unmountFresh()
    fresh.dispose()

    const r = rig()
    const { pool } = r.handle
    const residency = pool.residency!
    const restore = forceCold(pool, r.replay, id)
    // Kept out of memory, yet decided visible: the visibility parts read it by id.
    expect(tracked(() => pool.tables.issue.has(id))).toBe(false)
    expect(residency.isCold('issue', id)).toBe(true)
    expect(tracked(() => visibleOrderOf(pool))).toContain(id)
    expect(queuedCount(pool)).toBe(0)

    const el = document.createElement('div')
    document.body.append(el)
    let unmount = (): void => {}
    await act(async () => {
      unmount = r.handle.mountWeb(el)
    })
    try {
      // Its row shows loading; the reader answers LOADING, never a row.
      expect(el.querySelector(`[data-loading-row="${id}"]`)).not.toBeNull()
      expect(drawnRows(el)).not.toContain(id)
      expect(tracked(() => pool.row('issue', id))).toBe(LOADING)
      expect(tracked(() => pool.resident('issue', id))).toBe('loading')
      expect(tracked(() => pool.issue(id))).toBeUndefined()
      // Queued once, beside what drawing the list queues anyway, and nothing
      // loaded before the window closes. (The visibility parts read the row
      // by id through the feed — a peek — but never install it.)
      expect(queuedCount(pool)).toBe(eagerQueued + 1)
      expect(poolPendingLoads(pool)).toBe(1)
      const reads = (): number => r.loads.filter((load) => load === `issue:${id}`).length
      const readsBefore = reads()

      // One window, one batch, and it requests the row.
      const windows = r.armed()
      expect(windows).toHaveLength(1)
      await act(async () => {
        windows[0]!()
      })
      expect(reads()).toBe(readsBefore + 1)

      // Converged: in memory, drawn as a row, and equal to the all-in-memory pool.
      expect(tracked(() => pool.tables.issue.has(id))).toBe(true)
      expect(tracked(() => pool.row('issue', id) === pool.tables.issue.get(id))).toBe(true)
      expect(el.querySelector(`[data-loading-row="${id}"]`)).toBeNull()
      expect(drawnRows(el)).toEqual(wantDrawn)
      expect(r.handle.snapshot()).toEqual(want)
      expect(r.handle.rebuildFromScratch()).toEqual(want)
      // Loaded once: in memory now, so nothing reads it through the feed again.
      expect(reads()).toBe(readsBefore + 1)
    } finally {
      unmount()
      runInAction(restore)
    }
  }, 120_000)
})
