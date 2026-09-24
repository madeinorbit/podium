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
 * budget, with one named allowance on the commit fence: a row whose oracle
 * view changed in `activityAt` ALONE may be missing from the redraw
 * (POD-4674 owns `activityAt`; the legacy raises it by nested seats). #10
 * also carries a named reads allowance (POD-4678): a new explicit
 * member re-lists its issue's `sessions` bucket, so the burst also reads the
 * burst issues' other explicit sessions, counted before the step.
 *
 * ONE NAMED EXCEPTION (POD-4671, `known-gaps.ts`): the corpus's unscanned-
 * worktree orphan has no seat in the shared schema's R3 relation, so its
 * issue's row may differ from the oracle's in the fields that seat feeds,
 * and nowhere else; the exception throws once the seat exists. Each check
 * records whether it applied.
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
 * COLD ROWS (coordinator ruling 2026-09-24, option A). Progress reads a
 * cold child's R-ROLL facts by id through the cold-read path, never loading
 * it: at first paint (1x and 4x) no cold formal child of a visible row is
 * asked to load; a cold child's change moves its parent's progress to the
 * oracle's, and the same pool with that read untracked stays stale.
 * Attention keeps Ma3's pending marker: a row reopened to review whose ask
 * depends on a cold spin-off shows `loading` until the spin-off lands, then
 * the oracle's withdrawn ask.
 */

import { observable, reaction, runInAction, untracked } from 'mobx'
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
  engineLocals,
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
import { acceptUnscannedGap } from './known-gaps'

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

/**
 * The shared commit fence, with ONE named allowance (POD-4674 owns
 * `activityAt` in both pools, coordinator 2026-09-24): a row whose oracle
 * view changed in `activityAt` alone may be missing from the redraw (the
 * legacy raises it by the nested seats, `rows.ts:336-339`). A row drawn that
 * the oracle did not change never may. Returns the allowed rows.
 */
function assertCommitsBesideActivity(
  result: Parameters<typeof assertCommits>[0],
  before: Record<string, RowView>,
  after: Record<string, RowView>,
): string[] {
  try {
    assertCommits(result)
    return []
  } catch (error) {
    const drawn = new Set(result.drawnRows ?? [])
    const changed = new Set(result.oracleChangedRows ?? [])
    if ([...drawn].some((id) => !changed.has(id))) throw error
    const under = [...changed].filter((id) => !drawn.has(id))
    for (const id of under) {
      const a = before[id] as unknown as Record<string, unknown> | undefined
      const b = after[id] as unknown as Record<string, unknown> | undefined
      if (a === undefined || b === undefined) throw error
      const fields = Object.keys(b).filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))
      if (fields.some((f) => f !== 'activityAt')) throw error
    }
    return under.sort()
  }
}

/** The oracle's row views at the engine's locals (the commit fence's). */
function oracleViews(ctx: ScenarioEngine): Record<string, RowView> {
  return rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
}

/** The settled snapshot against the oracle and the rebuild. */
function checkParity(ctx: ScenarioEngine, handle: MobxPoolHandle, at: string): string | null {
  const snapshot = handle.snapshot()
  const oracle = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
  const { snapshot: expected, applied } = acceptUnscannedGap(ctx.corpus, handle.pool, oracle, snapshot)
  expect(diffSnapshots(snapshot, expected), `${at}: oracle`).toBeNull()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
  return applied
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
 * does not wait (under either kind of root), and a root whose aggregate has no
 * such seat either. A question waits under either kind of root, so it flips the
 * finished-root flag of every aggregate up to the root: each composition
 * re-runs and changes. (At 1x both depth-4 missions already wait under an
 * open root, so the open-root flag would stop the propagation early, which
 * is the early stop working, not a count to assert.)
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
      if (node.aggregate.finished.waiting) continue
      const bottom = pool.worklist.issue(id)
      const seat = bottom?.rosterIds.find((sessionId) => {
        const verdict = pool.worklist.session(sessionId).verdict
        return (
          typeof verdict === 'object' && verdict.finished !== 'waiting' && verdict.open !== 'waiting'
        )
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

// ------------------------------------------------------------ cold progress

const PROGRESS = ['progressDone', 'progressTotal'] as const

interface ColdProgressRun {
  readonly parent: string
  readonly child: string
  readonly first: RowView
  readonly after: RowView
  readonly oracleBefore: RowView
  readonly oracleAfter: RowView
  readonly childAsked: boolean
  readonly childStillCold: boolean
  readonly feedRowReadsInStep: number
}

function summary(run: ColdProgressRun) {
  const pick = (view: RowView) => ({ done: view.progressDone, total: view.progressTotal })
  return {
    parent: run.parent,
    child: run.child,
    first: pick(run.first),
    after: pick(run.after),
    oracleBefore: pick(run.oracleBefore),
    oracleAfter: pick(run.oracleAfter),
    feedRowReadsInStep: run.feedRowReadsInStep,
  }
}

/**
 * A hot visible parent with two or more accepted members, one of them a cold
 * closed child that counts as a done unit. Its view is observed (as a drawn
 * row), then the cold child is closed as cancelled (abandoned: it leaves the
 * members) and stays cold. `plant` takes the tracking away from exactly the
 * progress facts read (`untracked`).
 */
async function coldProgressRun(plant: boolean): Promise<ColdProgressRun> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = arm.create(feeds.rows.source, feeds.locals.source) as MobxPoolHandle
  const { pool } = handle
  const residency = pool.residency!
  if (plant) {
    const inputs = pool.visibleInputs as { progressFacts: (id: string) => unknown }
    const progressFacts = inputs.progressFacts
    inputs.progressFacts = (id) => untracked(() => progressFacts(id))
  }
  let observe = () => {}
  try {
    const coldDone = (childId: string): boolean => {
      if (!residency.isCold('issue', childId)) return false
      const row = pool.visibleInputs.issueRow(childId)
      // A UNIT: accepted, and not a vacated origin (no spin-off), so
      // abandoning it moves the total.
      return (
        row !== undefined &&
        row.stage !== 'proposed' &&
        !issueAbandoned(row) &&
        row.closedReason != null &&
        pool.relations.size('issue', childId, 'spinOffs') === 0
      )
    }
    const found = tracked(() => {
      for (const id of pool.worklist.order) {
        const node = pool.worklist.issue(id)!
        if (!pool.fenced.issue.has(id) || node.unitsBelow.members < 2) continue
        const child = [...pool.worklist.formalChildren(id)].sort().find(coldDone)
        if (child !== undefined) return { parent: id, child }
      }
      return null
    })
    expect(found, 'a hot visible parent with a cold done child').not.toBeNull()
    const { parent, child } = found!
    observe = reaction(() => pool.issue(parent)?.view, () => {})
    const oracleOf = () =>
      rowViewsFromStore(ctx.engine.getSnapshot(), { ...parityLocals(ctx), selectedIssueId: null })[
        parent
      ] as RowView
    // The first read, and every load it and its landings ask for (the row's
    // own seats and origin, Ma1's), settled: the cold child is never among them.
    tracked(() => pool.issue(parent)!.view!)
    let childAsked = false
    for (let round = 0; residency.hasQueued() && round < 16; round += 1) {
      const batch = residency.take()
      if (batch.some(([entity, rowId]) => entity === 'issue' && rowId === child)) childAsked = true
      for (const [entity, rowId] of batch) residency.request(entity, rowId)
      pool.hydrate()
      tracked(() => pool.issue(parent)!.view!)
    }
    const first = tracked(() => pool.issue(parent)!.view!)
    const oracleBefore = oracleOf()
    const readsBefore = feeds.rowReads()
    const wire = ctx.cache.read('issue', child)?.value as object
    const projection = ctx.cache.read('issueProjection', child)?.value as object | undefined
    ctx.replica.batch(() => {
      upsert(ctx, 'issue', child, { ...wire, closedReason: 'cancelled' })
      upsert(ctx, 'issueProjection', child, { ...(projection ?? {}), closedReason: 'cancelled' })
    })
    await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
    feeds.flush()
    const after = tracked(() => pool.issue(parent)!.view!)
    return {
      parent,
      child,
      first,
      after,
      oracleBefore,
      oracleAfter: oracleOf(),
      childAsked,
      childStillCold: residency.isCold('issue', child),
      feedRowReadsInStep: feeds.rowReads() - readsBefore,
    }
  } finally {
    observe()
    handle.dispose()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

// ------------------------------------------------------------ tests

describe('row roll-ups (Mb3)', () => {
  it('parity with the oracle and the rebuild on every fence scenario; commits and reads follow the change', async () => {
    const cells = await withMounted(arm, async (ctx, mounted, handle, flush) => {
      const gapAtBoot = checkParity(ctx, handle, 'bootstrap')
      expect(gapAtBoot, 'the POD-4671 row, named').toBe(ctx.corpus.unscannedWorktree.issueId)
      const out = []
      for (const entry of FENCE_SCENARIOS) {
        // POD-4678: a new explicit member re-lists its issue's `sessions`
        // bucket, so #10 also reads each burst issue's other explicit
        // sessions. That family term, counted before the step, is the only
        // allowance, named.
        const family =
          entry.methodology === '#10'
            ? tracked(() =>
                ctx.targets.burstIssueIds.reduce(
                  (sum, id) => sum + (handle.pool.worklist.issue(id)?.seatIds.length ?? 0),
                  0,
                ),
              )
            : 0
        const viewsBefore = oracleViews(ctx)
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, entry)
        const rollupsDerived = handle.stats.rollupsDerived
        const activityOnly = assertCommitsBesideActivity(result, viewsBefore, oracleViews(ctx))
        assertReads(result, { readsPerChange: readsBudget + family })
        mounted.reads.assertNoCopies(mounted.handle)
        const gap = checkParity(ctx, handle, entry.methodology)
        out.push({
          gap,
          methodology: entry.methodology,
          scenario: entry.scenario,
          oracleChanged: result.oracleChangedRows,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsBudget,
          familyAllowance: family,
          activityOnly,
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
    // The asked row's own view changed; the commit fence (exact, above) held the rest.
    expect(correct.oracleChanged).toContain(correct.rows[0])

    const planted = await chainStep(everyAggregate, false)
    expect(planted.rows).toEqual(correct.rows)
    // The fence the plant slips past, and the count that catches it.
    expect(planted.readsPerChange!).toBeLessThanOrEqual(planted.readsBudget)
    expect(planted.rollupsDerived).toBeGreaterThan(planted.rows.length)
    writeResult('mobx-rollups-chain-1x', { scale: 1, correct, planted })
  }, 600_000)

  it('first paint at 1x and 4x: no progress load, pending markers and cold reads counted from outside', async () => {
    const cells = []
    for (const scale of [1, 4] as const) {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const readsAtOpen = feeds.rowReads()
      const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
      const handle = mounted.handle as MobxPoolHandle
      const { pool } = handle
      try {
        const residency = pool.residency!
        // Mounted, nothing landed yet: what every drawn row shows.
        const visible = tracked(() => [...pool.worklist.order])
        const firstPaint = tracked(() =>
          visible.map((id) => {
            const view = pool.issue(id)?.view
            return {
              id,
              resident: view !== undefined,
              loading: view?.loading === true,
              rollupLoading: pool.worklist.issue(id)?.rollup?.loading === true,
            }
          }),
        )
        const rowReadsAtFirstPaint = feeds.rowReads() - readsAtOpen
        // What the first paint asked to load, looked at and put back.
        const batch = residency.take()
        for (const [entity, rowId] of batch) residency.request(entity, rowId)
        const asked = new Set(batch.filter(([entity]) => entity === 'issue').map(([, id]) => id))
        // Cold formal children of visible rows that no OTHER path reads: not a
        // visible row's origin (Ma1's tick loads it) and not its spin-off (the
        // attention path's continuation loads it). A load of one of these can
        // only be progress's.
        const coldChildren = tracked(() => {
          const others = new Set<string>()
          for (const id of visible) {
            const origin = pool.relations.one('issue', id, 'discoveredFrom')
            if (origin !== null) others.add(origin)
            for (const spinOff of pool.worklist.issue(id)?.spinOffIds ?? []) others.add(spinOff)
          }
          const out = new Set<string>()
          for (const id of visible) {
            for (const child of pool.worklist.formalChildren(id)) {
              if (residency.isCold('issue', child) && !others.has(child)) out.add(child)
            }
          }
          return out
        })
        const hydratedBefore = residency.counters.hydrated
        const windows = settle(pool)
        const cell = {
          scale,
          visible: visible.length,
          coldVisible: firstPaint.filter((row) => !row.resident).length,
          loadingRows: firstPaint.filter((row) => row.loading).length,
          rollupPendingRows: firstPaint.filter((row) => row.rollupLoading).length,
          queuedAtFirstPaint: batch.length,
          coldFormalChildrenOfVisibleRows: coldChildren.size,
          progressLoads: [...coldChildren].filter((id) => asked.has(id)).length,
          // Per-row reads through the feed (outside the pool): cold reads by id
          // plus nothing loaded yet at first paint.
          feedRowReadsAtFirstPaint: rowReadsAtFirstPaint,
          windows,
          loaded: residency.counters.hydrated - hydratedBefore,
        }
        // The declared rule: no visible row is cold (POD-4665).
        expect(cell.coldVisible).toBe(0)
        // Option A: progress reads cold children by id, never loads one.
        expect(cell.coldFormalChildrenOfVisibleRows).toBeGreaterThan(0)
        expect(cell.progressLoads).toBe(0)
        const settled = tracked(() => visible.filter((id) => pool.issue(id)?.view?.loading === true))
        expect(settled).toEqual([])
        cells.push(cell)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
    writeResult('mobx-rollups-first-paint', { cells })
  }, 600_000)

  it('a cold child counts in its parent\'s progress by a tracked cold read: its change moves the parent, and the untracked plant stays stale', async () => {
    const correct = await coldProgressRun(false)
    expect(correct.first.loading, 'no loading: nothing is waited for').toBeUndefined()
    expect(correct.childAsked, 'the cold child is never asked to load').toBe(false)
    expect(correct.childStillCold).toBe(true)
    for (const field of PROGRESS) {
      expect(correct.first[field], `before: ${field}`).toBe(correct.oracleBefore[field])
      expect(correct.after[field], `after: ${field}`).toBe(correct.oracleAfter[field])
    }
    expect(correct.oracleAfter.progressTotal, 'the change moves the oracle').not.toBe(
      correct.oracleBefore.progressTotal,
    )
    expect(correct.feedRowReadsInStep, 'the cold read is a counted feed read').toBeGreaterThan(0)

    const planted = await coldProgressRun(true)
    expect(planted.parent).toBe(correct.parent)
    expect(planted.after.progressTotal, 'untracked: stale').toBe(planted.first.progressTotal)
    expect(planted.after.progressTotal).not.toBe(planted.oracleAfter.progressTotal)
    writeResult('mobx-rollups-cold-progress-1x', { correct: summary(correct), planted: summary(planted) })
  }, 300_000)

  it('attention keeps the pending marker: a review ask waits on a cold spin-off, then withdraws (Ma3 addendum)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = arm.create(feeds.rows.source, feeds.locals.source) as MobxPoolHandle
    const { pool } = handle
    const residency = pool.residency!
    let observe = () => {}
    try {
      // A visible human row with no session on the task and a cold spin-off
      // that has left the mission: reopened to review, its ask is withdrawn by
      // that continuation (`issueContinuation`), which only the spin-off's own
      // row can tell.
      const found = tracked(() => {
        for (const id of pool.worklist.order) {
          const node = pool.worklist.issue(id)!
          const row = pool.visibleInputs.issueRow(id)
          if (row?.audience !== 'human' || node.openOwn || node.rosterIds.length > 0) continue
          const spinOff = node.spinOffIds.find((spinOffId) => {
            if (!residency.isCold('issue', spinOffId)) return false
            const spin = pool.visibleInputs.issueRow(spinOffId)
            return (
              spin !== undefined &&
              spin.archived !== true &&
              spin.deletedAt == null &&
              spin.stage !== 'backlog' &&
              spin.stage !== 'proposed'
            )
          })
          if (spinOff !== undefined) return { id, spinOff }
        }
        return null
      })
      expect(found, 'a visible row with a cold, started spin-off').not.toBeNull()
      const { id, spinOff } = found!
      observe = reaction(() => pool.issue(id)?.view, () => {})
      const wire = ctx.cache.read('issue', id)?.value as object
      const projection = ctx.cache.read('issueProjection', id)?.value as object | undefined
      ctx.replica.batch(() => {
        upsert(ctx, 'issue', id, { ...wire, stage: 'review', closedReason: null, closedAt: null })
        upsert(ctx, 'issueProjection', id, {
          ...(projection ?? {}),
          stage: 'review',
          closedReason: null,
          closedAt: null,
        })
      })
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      feeds.flush()
      expect(residency.isCold('issue', spinOff), 'the spin-off stays cold').toBe(true)
      const waiting = tracked(() => pool.issue(id)!.view!)
      const batch = residency.take()
      for (const [entity, rowId] of batch) residency.request(entity, rowId)
      expect(waiting.loading, 'loading while the spin-off is pending').toBe(true)
      expect(batch.some(([entity, rowId]) => entity === 'issue' && rowId === spinOff)).toBe(true)
      let windows = 0
      while (residency.hasQueued() && windows < 16) {
        pool.hydrate()
        windows += 1
      }
      const landed = tracked(() => pool.issue(id)!.view!)
      const oracle = rowViewsFromStore(ctx.engine.getSnapshot(), {
        ...parityLocals(ctx),
        selectedIssueId: null,
      })[id] as RowView
      expect(landed.loading).toBeUndefined()
      expect(landed.asking, 'withdrawn by the continuation, as in the oracle').toBe(oracle.asking)
      expect(landed.phase).toBe(oracle.phase)
      expect(oracle.asking).toBe(false)
      writeResult('mobx-rollups-attention-pending-1x', {
        row: id,
        spinOff,
        waiting: { loading: waiting.loading, asking: waiting.asking, phase: waiting.phase },
        windows,
        landed: { asking: landed.asking, phase: landed.phase },
      })
    } finally {
      observe()
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

