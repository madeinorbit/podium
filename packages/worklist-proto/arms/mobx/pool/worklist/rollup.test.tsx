// @vitest-environment happy-dom
/**
 * POD-4571 (Mb3) — the row roll-ups on the live engine, 1x live-shaped
 * fixture, mounted as the count harness mounts an arm.
 *
 * PARITY on every fence scenario (#1-#10, `FENCE_SCENARIOS`, in methodology
 * order on one engine): after bootstrap and after each step the settled
 * snapshot equals the legacy oracle's (every row field: `phase`, progress,
 * `working`, `asking`, `closed`, and the grouped order) and the pool's own
 * rebuild; each step commits exactly the rows whose oracle view changed (the
 * roll-up fields included: no stub allowance is left) and reads within its
 * budget.
 *
 * THE L1d SHAPE (`corpus.edgedAskers`): an asking session on a hidden
 * (archived or proposed) child of a visible root. The pool's root reads not
 * asking, as the oracle's does; `hidden-askers.ts` holds the oracle to it.
 *
 * THE CHAIN FENCE. A session on a row four nest levels deep (four ancestors,
 * every one visible, the fixture's own shape) turns to a question. Counted:
 * the rows read (the shared reads fence, budget 3 x (4 + 1)), and the
 * roll-up compositions that ran (the shared `ArmStats.rollupsDerived`),
 * which must be EXACTLY 5: the changed row and each of its four ancestors.
 * The reads fence cannot see this alone, because a composition reads cached
 * results, which the fence does not count (coordinator ruling on L5a): a
 * roll-up that re-ran every aggregate would read no more rows. So the count
 * is proven able to fail: the same pool planted to invalidate every aggregate
 * on every feed event (`everyAggregate`) must turn it red, and does, while
 * its parity stays green (the mistake is invisible to correctness checks).
 *
 * COLD CHILDREN (Ma3's lazy read, the coordinator's addendum). A hot visible
 * parent with cold formal children, read before any load lands: its row view
 * says `loading` and shows the progress of its READY children only; the one
 * read queues its cold children and nothing below them (a cold row is only
 * its pending marker until it lands: one level per window); after the
 * load window closes and the row settles, `loading` clears and every roll-up
 * field matches the oracle.
 */

import { observable, runInAction } from 'mobx'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  assertCommits,
  assertReads,
  type MountedArm,
  mountArmForCounts,
  phaseChangeReadBudget,
} from '../../../../harness/src/count-harness'
import {
  FENCE_SCENARIOS,
  type FenceScenario,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from '../../../../harness/src/fence-scenarios'
import { rowViewsFromStore, snapshotFromStore } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import type { RowView } from '../../../../shared/src/row-view'
import { type ScenarioEngine, startScenarioEngine, upsert } from '../../../../shared/src/scenarios'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import { issueAbandoned } from '../views'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'
import { type MobxPool, tracked } from '../pool'

installMobxWarnTrap()

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    mobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

/**
 * THE PLANTED MISTAKE: every aggregate reads one observable epoch that every
 * feed event bumps, so every aggregate re-runs on every change. Values stay
 * right (parity is blind to it); only the composition count can see it.
 */
const everyAggregate: CheckableArm = {
  create(source, locals, reads) {
    const epoch = observable.box(0, { name: 'plant.epoch' })
    const bumped: RowSource = {
      ...source,
      ...(source.row === undefined ? {} : { row: source.row.bind(source) }),
      snapshot: (kind) => source.snapshot(kind),
      subscribe: (listener) =>
        source.subscribe((event) => {
          listener(event)
          runInAction(() => epoch.set(epoch.get() + 1))
        }),
    }
    const handle = mobxPoolArm.create(bumped, locals, reads, { schedule: () => () => {} })
    const inputs = handle.pool.visibleInputs as { nested: (id: string) => Iterable<string> }
    const nested = inputs.nested
    inputs.nested = (id) => {
      epoch.get()
      return nested(id)
    }
    return handle
  },
}

/** Close load windows until nothing is queued (the mount asks for every drawn cold row). */
function settle(pool: MobxPool): number {
  let rounds = 0
  while (pool.residency?.hasQueued() && rounds < 100) {
    act(() => {
      pool.hydrate()
    })
    rounds += 1
  }
  expect(pool.residency?.hasQueued()).toBe(false)
  return rounds
}

/** The settled snapshot against the oracle and the rebuild. */
function checkParity(ctx: ScenarioEngine, handle: MobxPoolHandle, at: string): void {
  const snapshot = handle.snapshot()
  const expected = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
  expect(diffSnapshots(snapshot, expected), `${at}: oracle`).toBeNull()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
}

async function withMounted<T>(
  create: CheckableArm,
  run: (ctx: ScenarioEngine, mounted: MountedArm, handle: MobxPoolHandle, flush: () => void) => Promise<T>,
): Promise<T> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(create, feeds.rows.source, feeds.locals)
  try {
    const handle = mounted.handle as MobxPoolHandle
    settle(handle.pool)
    return await run(ctx, mounted, handle, feeds.flush)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

// ------------------------------------------------------------ the chain

interface Chain {
  /** Bottom first: the row, then each nest ancestor up to its root. */
  readonly rows: readonly string[]
  readonly sessionId: string
}

/**
 * A row with exactly four nest ancestors, each its raw `parentId` parent
 * (so the budget's ancestor count is the chain's), a seat on the row that
 * does not wait, and a root nothing waits under (so a question on the seat
 * changes every aggregate up to the root).
 */
function findChain(pool: MobxPool): Chain {
  return tracked(() => {
    for (const id of pool.worklist.order) {
      const rows = [id]
      let node = pool.worklist.issue(id)
      while (node !== undefined && node.nestParent !== null && rows.length <= 5) {
        if (node.standing?.parentId !== node.nestParent) break
        rows.push(node.nestParent)
        node = pool.worklist.issue(node.nestParent)
      }
      if (rows.length !== 5 || node?.nestParent !== null) continue
      if (node.standing?.parentId !== null) continue
      if (node.aggregate.open.waiting || node.aggregate.finished.waiting || node.aggregate.deciding) {
        continue
      }
      const bottom = pool.worklist.issue(id)
      const seat = bottom?.rosterIds.find((sessionId) => {
        const verdict = pool.worklist.session(sessionId).verdict
        return typeof verdict === 'object' && verdict.open !== 'waiting'
      })
      if (seat !== undefined) return { rows, sessionId: seat }
    }
    throw new Error('no row four nest levels deep with a quiet seat in the fixture')
  })
}

/** The chain step: one session of the bottom row turns to a question. */
function questionOn(chain: Chain): FenceScenario {
  return {
    scenario: 'deepSessionQuestion',
    methodology: 'Mb3 depth 4',
    async write(ctx) {
      const current = ctx.cache.read('session', chain.sessionId)?.value as object | undefined
      if (current === undefined) throw new Error(`${chain.sessionId} missing from the server cache`)
      upsert(ctx, 'session', chain.sessionId, {
        ...current,
        agentState: { phase: 'idle', idle: { kind: 'question' }, since: ctx.stamp() },
      })
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
    },
    readsBudget: () => phaseChangeReadBudget(chain.rows.length - 1),
  }
}

interface ChainCell {
  readonly rows: readonly string[]
  readonly sessionId: string
  readonly readsPerChange: number | null
  readonly readsBudget: number
  readonly readSample: readonly string[]
  readonly rollupsDerived: number
  readonly rowsCommitted: number
  readonly oracleChanged: readonly string[] | null
}

async function chainStep(create: CheckableArm, parity: boolean): Promise<ChainCell> {
  return withMounted(create, async (ctx, mounted, handle, flush) => {
    const chain = findChain(handle.pool)
    mounted.log.reset()
    handle.stats.reset()
    mounted.reads.reset()
    const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, questionOn(chain))
    const rollupsDerived = handle.stats.rollupsDerived
    if (parity) {
      assertCommits(result)
      checkParity(ctx, handle, 'depth 4')
    }
    return {
      rows: chain.rows,
      sessionId: chain.sessionId,
      readsPerChange: result.readsPerChange,
      readsBudget,
      readSample: result.reads?.sample ?? [],
      rollupsDerived,
      rowsCommitted: result.rowsCommitted,
      oracleChanged: result.oracleChangedRows,
    }
  })
}

// ------------------------------------------------------------ tests

describe('row roll-ups (Mb3)', () => {
  it('parity with the oracle and the rebuild on every fence scenario; commits and reads follow the change', async () => {
    const cells = await withMounted(arm, async (ctx, mounted, handle, flush) => {
      checkParity(ctx, handle, 'bootstrap')
      const out = []
      for (const entry of FENCE_SCENARIOS) {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, entry)
        const rollupsDerived = handle.stats.rollupsDerived
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        checkParity(ctx, handle, entry.methodology)
        out.push({
          methodology: entry.methodology,
          scenario: entry.scenario,
          oracleChanged: result.oracleChangedRows,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsBudget,
          rollupsDerived,
        })
      }
      return out
    })
    expect(cells).toHaveLength(FENCE_SCENARIOS.length)
    // #7 moves a child between parents: their progress changes, and they redraw.
    const reparent = cells.find((cell) => cell.methodology === '#7')
    expect(reparent?.rowsCommitted).toBeGreaterThan(0)
    expect(reparent?.rollupsDerived).toBeGreaterThan(0)
    // A heartbeat composes nothing.
    expect(cells.find((cell) => cell.methodology === '#1')?.rollupsDerived).toBe(0)
    writeResult('mobx-rollups-1x', { scale: 1, cells })
  }, 900_000)

  it('the L1d shape: an ask on a hidden child leaves its visible root quiet, as in the oracle', async () => {
    await withMounted(arm, async (ctx, _mounted, handle) => {
      const askers = ctx.corpus.edgedAskers
      expect(askers.length, 'hidden askers in the 1x fixture').toBeGreaterThan(0)
      const snapshot = handle.snapshot()
      const oracle = rowViewsFromStore(ctx.engine.getSnapshot(), {
        ...parityLocals(ctx),
        selectedIssueId: null,
      })
      let checked = 0
      for (const { rootId, childId } of askers) {
        const row = snapshot.rowsById[rootId]
        if (row === undefined) continue
        checked += 1
        expect(tracked(() => handle.pool.worklist.issue(childId)?.present), childId).toBe(false)
        expect(row.asking, `${rootId}: asking`).toBe((oracle[rootId] as RowView).asking)
        expect(row.phase, `${rootId}: phase`).toBe((oracle[rootId] as RowView).phase)
      }
      expect(checked, 'visible roots over hidden askers').toBeGreaterThan(0)
    })
  }, 300_000)

  it('a question four levels deep reads within the chain budget and composes exactly the chain', async () => {
    const correct = await chainStep(arm, true)
    expect(correct.rows).toHaveLength(5)
    expect(correct.readsPerChange).not.toBeNull()
    expect(correct.readsPerChange!).toBeLessThanOrEqual(correct.readsBudget)
    // The changed row and each of its four ancestors: one composition each.
    expect(correct.rollupsDerived).toBe(correct.rows.length)
    // Every row of the chain changed in the oracle's views (the root included).
    for (const id of correct.rows) expect(correct.oracleChanged, id).toContain(id)

    const planted = await chainStep(everyAggregate, false)
    expect(planted.rows).toEqual(correct.rows)
    // The fence the plant slips past, and the count that catches it.
    expect(planted.readsPerChange!).toBeLessThanOrEqual(planted.readsBudget)
    expect(planted.rollupsDerived).toBeGreaterThan(planted.rows.length)
    writeResult('mobx-rollups-chain-1x', { scale: 1, correct, planted })
  }, 600_000)

  it('cold children: loading and partial progress first, the oracle once they land (Ma3 addendum)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = arm.create(feeds.rows.source, feeds.locals.source) as MobxPoolHandle
    const { pool } = handle
    try {
      const residency = pool.residency!
      // A resident visible parent with a hot child and a cold one that counts
      // as a unit (so the ready children's progress is strictly partial).
      const coldUnit = (childId: string) => {
        if (!residency.isCold('issue', childId)) return false
        const row = residency.read('issue', childId) as SliceIssue | undefined
        return row !== undefined && row.stage !== 'proposed' && !issueAbandoned(row)
      }
      const parent = tracked(() =>
        pool.worklist.order.find((id) => {
          const node = pool.worklist.issue(id)
          return (
            pool.fenced.issue.has(id) &&
            node !== undefined &&
            node.childIds.some(coldUnit) &&
            node.childIds.some((childId) => pool.fenced.issue.has(childId))
          )
        }),
      )
      expect(parent, 'a hot visible parent with a hot child and a cold unit child').toBeDefined()
      const id = parent as string
      const childIds = tracked(() => pool.worklist.issue(id)!.childIds)
      const coldChildren = childIds.filter((childId) => residency.isCold('issue', childId))
      // Everything below the cold children: none of it may be asked for yet.
      const deeper = new Set<string>()
      const stack = [...coldChildren]
      while (stack.length > 0) {
        const next = stack.pop() as string
        for (const grandchild of tracked(() => pool.worklist.issue(next)?.childIds ?? [])) {
          if (deeper.has(grandchild)) continue
          deeper.add(grandchild)
          stack.push(grandchild)
        }
      }

      pool.hydrate()
      expect(residency.hasQueued()).toBe(false)
      const first = tracked(() => pool.issue(id)!.view!)
      const batch = residency.take()
      for (const [entity, rowId] of batch) residency.request(entity, rowId)
      const queued = batch.length
      expect(first.loading, 'loading while cold children are pending').toBe(true)
      const asked = new Set(batch.filter(([entity]) => entity === 'issue').map(([, rowId]) => rowId))
      for (const childId of coldChildren) expect(asked.has(childId), `${childId} asked for`).toBe(true)
      // One level: no row below a cold child is asked for by this read (a row
      // nested straight under the parent through a hidden child is its own level).
      const nestedHere = new Set(tracked(() => [...pool.worklist.nested(id)]))
      expect([...deeper].filter((rowId) => asked.has(rowId) && !nestedHere.has(rowId))).toEqual([])
      const store = ctx.engine.getSnapshot()
      const oracle = rowViewsFromStore(store, { ...parityLocals(ctx), selectedIssueId: null })[
        id
      ] as RowView
      expect(oracle, `${id} in the oracle`).toBeDefined()
      expect(first.progressTotal, 'partial progress: the ready children only').toBeLessThan(
        oracle.progressTotal,
      )

      let windows = 0
      let view = first
      while (residency.hasQueued() && windows < 16) {
        pool.hydrate()
        windows += 1
        view = tracked(() => pool.issue(id)!.view!)
      }
      expect(view.loading, 'loading clears once everything it reads has landed').toBeUndefined()
      for (const field of ['phase', 'progressDone', 'progressTotal', 'working', 'asking', 'closed'] as const) {
        expect(view[field], `${id}.${field}`).toEqual(oracle[field])
      }
      writeResult('mobx-rollups-cold-1x', {
        scale: 1,
        parent: id,
        children: childIds.length,
        coldChildren: coldChildren.length,
        queuedByFirstRead: queued,
        windows,
        first: { progressDone: first.progressDone, progressTotal: first.progressTotal },
        settled: { progressDone: view.progressDone, progressTotal: view.progressTotal },
      })
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})
