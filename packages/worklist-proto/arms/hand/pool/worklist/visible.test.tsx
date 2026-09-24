// @vitest-environment happy-dom
/**
 * POD-4582 (Hb1) — the visible collection and its order on the live engine,
 * 1x live-shaped fixture, fence steps #1-#5 in methodology order on one
 * engine. The same instruments as the MobX arm's Mb1 test
 * (`arms/mobx/pool/worklist/visible.test.tsx`): the legacy oracle, the
 * shared fences, the checker.
 *
 * PARITY, after bootstrap and after every step: the pool's order equals the
 * legacy oracle's flat rows (`visibleIssueRows` over the engine's store: the
 * rows the app would show, in R-ORDER), the settled snapshot equals the
 * pool's own rebuild from scratch (which decides visibility over every row,
 * cold ones included), and the fields the rows carry from the own row and
 * one hop equal the oracle's row views. The roll-ups (`phase`, progress,
 * `working`, `asking`) and `closed` are Hb3's stubs and stay out of the
 * field comparison.
 *
 * FENCES the brief names: a heartbeat reads nothing of the visible set and
 * places nothing; a rank change places one row, shifting at most the visible
 * count, and commits only rows whose view changed; #1-#5 commit exactly the
 * oracle-changed rows, and a list that draws hidden rows fails #1 and a
 * #4-shaped rename of an origin with a hidden spin-off.
 */

import { act, type ReactElement, useCallback, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  assertCommits,
  assertReads,
  mountArmForCounts,
} from '../../../../harness/src/count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from '../../../../harness/src/fence-scenarios'
import {
  legacyDerivationFromStore,
  rowViewsFromStore,
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { checkArm, diffSnapshots } from '../../../../shared/src/gen/check'
import { CommitLogContext, currentCommitLog, RowShell } from '../../../../shared/src/row-shell'
import {
  type ScenarioEngine,
  startScenarioEngine,
  upsert,
  writeTitleRename,
} from '../../../../shared/src/scenarios'
import { type HandPoolHandle, handPoolArm } from '../arm'
import type { HandPool } from '../pool'
import { PoolRow } from '../react/row'

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    handPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

/** The row fields Hb1's rows carry from the own row and one hop (the roll-ups are Hb3's stubs). */
const OWN_FIELDS = [
  'displayRef',
  'title',
  'band',
  'repoKey',
  'pinned',
  'sortKey',
  'createdAt',
  'seq',
  'foldAt',
  'originTick',
] as const

/** Land every queued load (the mount and the visibility parts ask for cold rows). */
function settle(handle: HandPoolHandle): number {
  const before = handle.pool.residency?.counters.hydrated ?? 0
  act(() => {
    handle.settleLoads()
  })
  expect(handle.pool.pendingLoads()).toBe(0)
  return (handle.pool.residency?.counters.hydrated ?? 0) - before
}

/** The oracle's flat order: the rows the app would show, in R-ORDER. */
function oracleOrder(ctx: ScenarioEngine): string[] {
  const locals = parityLocals(ctx)
  const derivation = legacyDerivationFromStore(ctx.engine.getSnapshot(), locals.coarseNow)
  return visibleIssueRows(derivation, locals).map((row) => row.issue.id)
}

interface ParityCell {
  readonly at: string
  readonly visible: number
  readonly orderEqual: boolean
  readonly rebuildDiff: string | null
  readonly fieldDiffs: number
}

function checkParity(ctx: ScenarioEngine, handle: HandPoolHandle, at: string): ParityCell {
  const { pool } = handle
  const snapshot = handle.snapshot()
  const expected = oracleOrder(ctx)
  const order = [...pool.order()]
  expect(order, `${at}: visible order`).toEqual(expected)
  expect(Object.keys(snapshot.rowsById), `${at}: snapshot rows`).toEqual(expected)
  const rebuildDiff = diffSnapshots(snapshot, handle.rebuildFromScratch())
  expect(rebuildDiff, `${at}: rebuild`).toBeNull()
  const views = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
  const diffs: string[] = []
  for (const id of order) {
    const live = pool.view(id)
    const oracle = views[id]
    for (const field of OWN_FIELDS) {
      if (JSON.stringify(live?.[field]) !== JSON.stringify(oracle?.[field])) {
        diffs.push(
          `${id}.${field}: ${JSON.stringify(live?.[field])} (oracle ${JSON.stringify(oracle?.[field])})`,
        )
      }
    }
  }
  expect(diffs.slice(0, 10), `${at}: own-row fields`).toEqual([])
  return { at, visible: order.length, orderEqual: true, rebuildDiff, fieldDiffs: diffs.length }
}

/** The order's counters, copied (they are reset between steps). */
function orderCounters(pool: HandPool) {
  const c = pool.stats.counters
  return {
    membershipFlips: c.membershipFlips,
    orderMoves: c.orderMoves,
    orderShifted: c.orderShifted,
    orderSorts: c.orderSorts,
    orderSorted: c.orderSorted,
  }
}

describe('visible collection and order (Hb1)', () => {
  it('parity at 1x through #1-#5; the commit and reads fences hold', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HandPoolHandle
    const { pool } = handle
    try {
      // First paint: the order before any load lands. Answers that wait on a
      // cold row's own fields are provisional until then.
      const firstPaint = [...pool.order()]
      const residentAtPaint = pool.tables.issue.size
      const bootstrapLoads = settle(handle)
      const settled = new Set(pool.order())
      const painted = new Set(firstPaint)
      const bootstrap = {
        visibleAtFirstPaint: firstPaint.length,
        addedAfterFirstPaint: [...settled].filter((id) => !painted.has(id)),
        removedAfterFirstPaint: firstPaint.filter((id) => !settled.has(id)),
        rowsLoadedSettling: bootstrapLoads,
        residentAtFirstPaint: residentAtPaint,
        residentSettled: pool.tables.issue.size,
        coldSettled: pool.residency?.size('issue') ?? 0,
        issueCellSets: pool.worklist.held('issue'),
        sessionCellSets: pool.worklist.held('session'),
        visibleCells: pool.worklist.held('member'),
      }
      const parity: ParityCell[] = [checkParity(ctx, handle, 'bootstrap')]
      mounted.log.reset()
      handle.stats.reset()
      mounted.reads.reset()
      const cells = []
      for (const methodology of ['#1', '#2', '#3', '#4', '#5']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const visibleBefore = new Set(pool.order())
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        const counters = orderCounters(pool)
        if (methodology === '#1') {
          // A heartbeat reads 0 of the visible set and places nothing.
          const readIds = (result.reads?.sample ?? []).map((key) => key.split(':')[1] ?? '')
          expect(result.reads?.rows ?? 0).toBeLessThanOrEqual(8)
          expect(readIds.filter((id) => visibleBefore.has(id))).toEqual([])
          expect(counters).toEqual({
            membershipFlips: 0,
            orderMoves: 0,
            orderShifted: 0,
            orderSorts: 0,
            orderSorted: 0,
          })
        }
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsBudget,
          readsByEntity: result.reads?.byEntity,
          ...counters,
          visible: visibleBefore.size,
        })
        parity.push(checkParity(ctx, handle, methodology))
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
      }
      writeResult('hand-visible-1x', { scale: 1, bootstrap, parity, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('bootstrap: deciding visibility loads no row; it reads the cold rows it walks through by id', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    // No list mounted: only the pool's own `visible` cells have run.
    const handle = handPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
    const { pool } = handle
    try {
      const residency = pool.residency!
      expect(pool.pendingLoads()).toBe(0)
      expect(residency.counters.requests).toBe(0)
      expect(pool.order().length).toBe(oracleOrder(ctx).length)
      writeResult('hand-visible-bootstrap-1x', {
        visible: pool.order().length,
        loadsQueued: residency.counters.requests,
        coldReadsById: residency.counters.peeks,
        feedRowReads: feeds.rowReads(),
        resident: pool.tables.issue.size,
        cold: residency.size('issue'),
        issueCellSets: pool.worklist.held('issue'),
        sessionCellSets: pool.worklist.held('session'),
        visibleCells: pool.worklist.held('member'),
        cellsCreated: pool.stats.counters.cellsCreated,
        cellRuns: pool.stats.counters.cellRuns,
      })
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('a rank change places one row, shifting at most the visible count, and commits only it', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const before = [...pool.order()]
      // Pin the LAST visible unpinned row: band 1 → 0, so it moves to the top block.
      const target = [...before].reverse().find((id) => pool.view(id)?.pinned === false)
      expect(target).toBeDefined()
      mounted.log.reset()
      pool.stats.reset()
      await act(async () => {
        const wire = ctx.cache.read('issue', target!)?.value as object | undefined
        expect(wire).toBeDefined()
        ctx.replica.batch(() => upsert(ctx, 'issue', target!, { ...wire, pinned: true }))
        await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
        feeds.flush()
      })
      const after = [...pool.order()]
      const counters = orderCounters(pool)
      expect(counters.orderSorts).toBe(0)
      expect(counters.orderMoves).toBe(1)
      expect(counters.membershipFlips).toBe(0)
      expect(counters.orderShifted).toBeLessThanOrEqual(before.length)
      expect(counters.orderShifted).toBe(before.indexOf(target!) - after.indexOf(target!) + 1)
      expect(after.indexOf(target!)).toBeLessThan(before.indexOf(target!))
      expect(new Set(after)).toEqual(new Set(before))
      // The pinned row redraws (its view's `band`/`pinned` moved); no other row commits.
      expect([...mounted.log.counts.keys()]).toEqual([target])
      expect(after).toEqual(oracleOrder(ctx))
      writeResult('hand-visible-rank-1x', { target, visible: before.length, ...counters })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('a rename of an origin with a hidden open spin-off commits only visible rows (#4 shape)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      settle(mounted.handle as HandPoolHandle)
      mounted.log.reset()
      mounted.handle.stats.reset()
      mounted.reads.reset()
      const { result, readsBudget } = await runHiddenSpinOffRename(mounted, ctx, feeds.flush)
      assertCommits(result)
      assertReads(result, { readsPerChange: readsBudget })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('an evicted parent re-added places its descendants again (the MobX gate seed 1, step 112)', async () => {
    // The sequence that caught the MobX arm's untracked node registry: here a
    // part's lookup of another issue goes through the tracked presence and
    // coldness doors, so the re-added parent re-runs its descendants' walks.
    const plain: CheckableArm = {
      create: (source, locals, reads) => handPoolArm.create(source, locals, reads),
    }
    const result = await checkArm(
      plain,
      [
        { kind: 'evict', id: 'i234' },
        { kind: 'reAdd', id: 'i234' },
      ] as never,
      { oracleEvery: 0, shrink: false },
    )
    expect(result.ok ? null : `${result.against}: ${result.diff}`).toBeNull()
  }, 300_000)

  it('a list that draws hidden rows fails the commit fence on a hidden spin-off rename (#1 no longer moves a hidden row)', async () => {
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HandPoolHandle
        const { pool } = handle
        return {
          ...handle,
          mountWeb(el: Element): () => void {
            const root = createRoot(el)
            root.render(
              <CommitLogContext.Provider value={currentCommitLog()}>
                <AllKnownList pool={pool} />
              </CommitLogContext.Provider>,
            )
            return () => root.unmount()
          },
        }
      },
    }
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(planted, feeds.rows.source, feeds.locals)
    try {
      settle(mounted.handle as HandPoolHandle)
      mounted.log.reset()
      mounted.handle.stats.reset()
      mounted.reads.reset()
      const failures: Record<string, string> = {}
      for (const methodology of ['#1', '#2', '#3', '#4']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        try {
          assertCommits(result)
        } catch (error) {
          failures[methodology] = (error as Error).message
        }
        mounted.log.reset()
        mounted.handle.stats.reset()
        mounted.reads.reset()
      }
      const renamed = await runHiddenSpinOffRename(mounted, ctx, feeds.flush)
      try {
        assertCommits(renamed.result)
      } catch (error) {
        failures['#4 hidden spin-off'] = (error as Error).message
      }
      // #4's corpus target has no spin-off, so only the #4-shaped rename of
      // an origin with a hidden spin-off can show it. #1's heartbeat lands
      // on a member that retains nothing, so since Hb3 reads activityAt off
      // the retained seats (as the legacy does), it moves no hidden row.
      expect(Object.keys(failures).sort()).toEqual(['#4 hidden spin-off'])
      expect(failures['#4 hidden spin-off']).toContain(`over=[${renamed.spinOff}`)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

/**
 * #4's write (`writeTitleRename`) on a visible origin that has an OPEN (so
 * resident) spin-off the worklist hides: the origin's rename re-derives the
 * hidden spin-off's ⤷ tick. The origin is picked from the oracle before the
 * write; the same budget as #4.
 */
async function runHiddenSpinOffRename(
  mounted: ReturnType<typeof mountArmForCounts>,
  ctx: ScenarioEngine,
  flush: () => void,
) {
  const store = ctx.engine.getSnapshot()
  const visible = rowViewsFromStore(store, engineLocals(ctx))
  let origin: string | undefined
  let spinOff: string | undefined
  for (const issue of store.issues) {
    const from = issue.deps?.find((dep) => dep.type === 'discovered-from')?.id
    if (from === undefined || visible[from] === undefined) continue
    if (issue.closedAt != null || visible[issue.id] !== undefined) continue
    origin = from
    spinOff = issue.id
    break
  }
  expect(origin, 'a visible origin with an open hidden spin-off').toBeDefined()
  const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#4')
  const step = await runFenceStep(mounted, ctx, flush, {
    ...entry!,
    scenario: 'hiddenSpinOffOriginRename',
    write: (c) => writeTitleRename(c, origin),
  })
  return { ...step, origin: origin as string, spinOff: spinOff as string }
}

/** The plant: every issue the pool KNOWS drawn, hidden ones included (a cold one loads, then draws). */
function AllKnownSlot({ pool, id }: { pool: HandPool; id: string }): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  if (view === undefined) {
    pool.resident('issue', id)
    return null
  }
  return <RowShell row={view} component={PoolRow} />
}

function AllKnownList({ pool }: { pool: HandPool }): ReactElement {
  const resident = useSyncExternalStore(pool.subscribeIds, pool.issueIds)
  const [cold] = useState(() => pool.residency?.ids('issue') ?? [])
  const ids = [...new Set([...resident, ...cold])]
  return (
    <div>
      {ids.map((id) => (
        <AllKnownSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
}
