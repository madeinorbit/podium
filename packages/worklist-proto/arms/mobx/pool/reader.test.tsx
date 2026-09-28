// @vitest-environment happy-dom
/**
 * POD-4743 — the pool's one row reader (`MobxPool.row`) on a row that is not
 * in memory.
 *
 * Under the declared cold rule no VISIBLE row is cold (POD-4665), so the
 * reader is configured (`PoolLazyOptions.outOfMemory`) to keep one visible
 * issue out of memory. The mounted list draws it as loading, the reader
 * answers `LOADING` and queues it, ONE load window requests it, and once that
 * batch lands the list, the snapshot and the rebuild equal an all-in-memory
 * pool's.
 */

import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import type { RowRecord } from '../../../shared/src/stats'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'
import { LOADING } from './worklist/rollup'

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
  readonly handle: MobxPoolHandle
  /** Per-row reads through the feed, `kind:id`. */
  readonly loads: string[]
  /** Load windows armed and not cancelled. */
  armed(): (() => void)[]
  dispose(): void
}

let open: Rig[] = []

function rig(outOfMemory?: (entity: string, id: string) => boolean): Rig {
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
  const handle = mobxPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    ...(outOfMemory === undefined ? {} : { outOfMemory }),
  })
  const r: Rig = {
    handle,
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

describe('POD-4743 the one row reader, not in memory', () => {
  it('a visible issue out of memory draws loading, loads in one batch, and converges', async () => {
    // The all-in-memory result, and one visible issue with a view to hide.
    const eager = rig()
    const want = eager.handle.snapshot()
    const target = Object.keys(want.rowsById).find(
      (id) => corpus.sliceIssues.find((issue) => issue.id === id)?.draft !== true,
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
    // What drawing the list queues anyway (other rows' cold origins and seats).
    const eagerRequests = eager.handle.pool.residency!.counters.requests
    unmountEager()

    const r = rig((entity, rowId) => entity === 'issue' && rowId === id)
    const { pool } = r.handle
    const residency = pool.residency!
    // Kept out of memory, yet decided visible: the visibility parts read it by id.
    expect(tracked(() => pool.tables.issue.has(id))).toBe(false)
    expect(residency.isCold('issue', id)).toBe(true)
    expect(tracked(() => pool.worklist.order)).toContain(id)
    expect(residency.counters.requests).toBe(0)

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
      // by id through the feed — a peek, counted there — but never install it.)
      expect(residency.counters.requests).toBe(eagerRequests + 1)
      expect(residency.counters.batches).toBe(0)
      expect(residency.counters.hydrated).toBe(0)
      const reads = (): number => r.loads.filter((load) => load === `issue:${id}`).length
      const readsBefore = reads()

      // One window, one batch, and it requests the row.
      const windows = r.armed()
      expect(windows).toHaveLength(1)
      await act(async () => {
        windows[0]!()
      })
      expect(residency.counters.batches).toBe(1)
      expect(reads()).toBe(readsBefore + 1)
      expect(residency.counters.hydrated).toBeGreaterThanOrEqual(1)

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
    }
  }, 120_000)
})
