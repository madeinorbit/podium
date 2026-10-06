import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { upsertIssue } from '../../../../shared/src/scenarios'

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
 * roll-up fields and `activityAt` included: no allowance is left on the
 * commit fence since POD-4674 made `activityAt` the legacy's, POD-4679) and
 * reads within its budget. #10 (POD-4678): a new explicit member costs the
 * new member, not the family — the seat set is maintained from the
 * relation's own bucket delta, never re-listed through the fenced `many()`.
 *
 * NO NAMED EXCEPTION (POD-4671 fixed): the corpus's unscanned-worktree
 * orphan seats through the schema's R3 union roots (scanned lanes PLUS every
 * issue's own worktreePath), so parity holds with no allowance. Each check
 * records a null gap.
 *
 * THE L1d SHAPE (`corpus.edgedAskers`): an asking session on a hidden
 * (archived or proposed) child of a visible root. The pool's root reads not
 * asking, as the oracle's does; `hidden-askers.ts` holds the oracle to it.
 *
 * THE CHAIN FENCE. A session on a row four nest levels deep (four ancestors,
 * every one visible, the fixture's own shape) turns to a question. Counted:
 * the rows read (the shared reads fence, budget 3 x (4 + 1)), and the
 * which must be EXACTLY 5: the changed row and each of its four ancestors.
 * The reads fence cannot see this alone, because a composition reads cached
 * results, which the fence does not count (coordinator ruling on L5a): a
 * roll-up that re-ran every aggregate would read no more rows. So the count
 * is proven able to fail: the same pool planted to invalidate every aggregate
 * on every feed event (`everyAggregate`) must turn it red, and does, while
 * its parity stays green (the mistake is invisible to correctness checks).
 *
 * COLD ROWS (POD-4754, operator decision 2026-09-28: load the family on
 * demand). Over the declared rule's own cold rows (POD-4945: no test seam):
 * a drawn row whose progress needs closed children shows `loading`, asks for
 * exactly that family in one load window, and once it lands equals the
 * oracle's progress; a row nobody draws asks for nothing; a deep closed
 * chain asks for one level per window and converges. At first paint (1x and
 * 4x, the default cold rule) the mounted list's rows ask for their closed
 * children in the first window and settle with nothing loading. Attention
 * keeps Ma3's pending marker: a row reopened to review whose ask depends on
 * a cold spin-off shows `loading` until the spin-off lands, then the
 * oracle's withdrawn ask.
 */

import { rowViewOf } from '@podium/client-graph/models'
import type { MobxPool } from '@podium/client-graph/pool'
import type { RowView } from '@podium/client-graph/shared/row-view'
import { observable, reaction, runInAction } from 'mobx'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  type HarnessMobxPoolHandle,
  harnessMobxPoolArm,
  poolPendingLoads,
  tracked,
  visibleOrderOf,
} from '../../../../harness/src/adapters/mobx-pool'
import {
  assertCommits,
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
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import { rowViewsFromStore, snapshotFromStore } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine, upsert } from '../../../../shared/src/scenarios'

installMobxWarnTrap()

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessMobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
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
    const handle = harnessMobxPoolArm.create(bumped, locals, reads, { schedule: () => () => {} })
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
  while (poolPendingLoads(pool) > 0 && rounds < 100) {
    act(() => {
      pool.hydrate()
    })
    rounds += 1
  }
  expect(poolPendingLoads(pool)).toBe(0)
  return rounds
}

/** The settled snapshot against the oracle and the rebuild (no exception). */
function checkParity(
  ctx: ScenarioEngine,
  handle: HarnessMobxPoolHandle,
  at: string,
): string | null {
  const snapshot = handle.snapshot()
  const oracle = snapshotFromStore(referenceState(ctx.engine), parityLocals(ctx))
  expect(diffSnapshots(snapshot, oracle), `${at}: oracle`).toBeNull()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
  return null
}

async function withMounted<T>(
  create: CheckableArm,
  run: (
    ctx: ScenarioEngine,
    mounted: MountedArm,
    handle: HarnessMobxPoolHandle,
    flush: () => void,
  ) => Promise<T>,
): Promise<T> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const mounted = mountArmForCounts(create, feeds.rows.source, feeds.locals)
  try {
    const handle = mounted.handle as HarnessMobxPoolHandle
    settle(handle.pool)
    return await run(ctx, mounted, handle, feeds.flush)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.dispose()
  }
}

/**
 * POD-4678 — same harness as `withMounted` (mounted React list, same
 * schedule, same settle) at the loop scale (1x: 732 rows, 4x: 2928 rows).
 * 1x and 4x run the SAME React/page path; the scale comparison compares the
 * same harness at two data sizes (coordinator ruling: do not use a direct
 * pool for 4x). 4x OOMs on ludovico's podium-sessions cgroup cap — run it on
 * flatblock, free.
 */
async function withMountedScale<T>(
  create: CheckableArm,
  scale: 1 | 4,
  run: (
    ctx: ScenarioEngine,
    mounted: MountedArm,
    handle: HarnessMobxPoolHandle,
    flush: () => void,
  ) => Promise<T>,
): Promise<T> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const mounted = mountArmForCounts(create, feeds.rows.source, feeds.locals)
  try {
    const handle = mounted.handle as HarnessMobxPoolHandle
    settle(handle.pool)
    return await run(ctx, mounted, handle, feeds.flush)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.dispose()
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
    for (const id of visibleOrderOf(pool)) {
      const rows = [id]
      let node = pool.knownIssue(id)
      while (node !== undefined && node.nestParent !== null && rows.length <= 5) {
        if (node.standing?.parentId !== node.nestParent) break
        rows.push(node.nestParent)
        node = pool.knownIssue(node.nestParent)
      }
      if (rows.length !== 5 || node?.nestParent !== null) continue
      if (node.standing?.parentId !== null) continue
      if (node.aggregate.finished.waiting) continue
      const bottom = pool.knownIssue(id)
      const seat = bottom?.rosterIds.find((sessionId) => {
        const verdict = pool.visibleInputs.session(sessionId).verdict
        return (
          typeof verdict === 'object' &&
          verdict.finished !== 'waiting' &&
          verdict.open !== 'waiting'
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
  readonly rowsCommitted: number
  readonly oracleChanged: readonly string[] | null
}

async function chainStep(create: CheckableArm, parity: boolean): Promise<ChainCell> {
  return withMounted(create, async (ctx, mounted, handle, flush) => {
    const chain = findChain(handle.pool)
    mounted.log.reset()
    mounted.reads.reset()
    const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, questionOn(chain))
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
      rowsCommitted: result.rowsCommitted,
      oracleChanged: result.oracleChangedRows,
    }
  })
}

// ------------------------------------------------------------ cold progress

const PROGRESS = ['progressDone', 'progressTotal'] as const

/**
 * The pool at 1x over the scenario engine, with the declared rule's own cold
 * rows (closed issues nothing keeps: POD-4945, no test seam), a load window
 * that never closes on its own, and nothing drawn.
 * `eagerRollups` is the plant: every visible row's roll-up derived and kept
 * alive whether or not it is drawn.
 */
async function familyRig(eagerRollups = false) {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
    schedule: () => () => {},
  }) as HarnessMobxPoolHandle
  const { pool } = handle
  const residency = pool.residency!
  const stops: (() => void)[] = []
  if (eagerRollups) {
    stops.push(
      reaction(
        () => visibleOrderOf(pool).map((id) => pool.knownIssue(id)?.rollup),
        () => {},
      ),
    )
  }
  /** A queued row as the tests compare it: an issue by its id, any other row `kind:id`. */
  const key = ([entity, id]: readonly [string, string]): string =>
    entity === 'issue' ? id : `${entity}:${id}`
  /** Every row the load windows asked for, in order: one entry per window. */
  const windows: string[][] = []
  /** What the load queue holds now, without landing it. */
  const queued = (): string[] => {
    const batch = residency.take()
    for (const [entity, id] of batch) residency.request(entity, id)
    return batch.map(key)
  }
  /** Close one window: record the rows it asks for, then land them. */
  const land = (): string[] => {
    const rows = queued()
    windows.push(rows)
    pool.hydrate()
    return rows
  }
  /** The formal children (inside a tracked read). */
  const children = (id: string): string[] => [...pool.relations.many('issue', id, 'children')]
  const oracle = (id: string): RowView =>
    rowViewsFromStore(referenceState(ctx.engine), { ...parityLocals(ctx), selectedIssueId: null })[
      id
    ] as RowView
  /** Draw a row: keep its view observed, as a mounted row does. */
  const draw = (id: string): void => {
    stops.push(
      reaction(
        () => rowViewOf(pool.issue(id)),
        () => {},
      ),
    )
  }
  const view = (id: string): RowView => tracked(() => rowViewOf(pool.issue(id))!)
  /** The progress markers below a row (its closure's cold units) and its attention's. */
  const pending = (id: string) =>
    tracked(() => {
      const node = pool.knownIssue(id)!
      return { progress: node.unitsBelow.pending, attention: node.aggregate.pending }
    })
  /** Land what the pool asks for with nothing drawn; returns those issues and the visible set. */
  const settleOwn = (): string[] & { visible: ReadonlySet<string> } => {
    const asked: string[] = []
    for (;;) {
      const batch = residency.take()
      if (batch.length === 0) break
      for (const [entity, id] of batch) residency.request(entity, id)
      asked.push(...batch.map(key))
      windows.push(batch.map(key))
      pool.hydrate()
    }
    windows.length = 0
    return Object.assign(asked, { visible: new Set(tracked(() => visibleOrderOf(pool))) })
  }
  return {
    ctx,
    pool,
    residency,
    windows,
    land,
    queued,
    children,
    oracle,
    draw,
    view,
    pending,
    settleOwn,
    dispose() {
      for (const stop of stops) stop()
      handle.dispose()
      feeds.dispose()
      ctx.dispose()
    },
  }
}

type FamilyRig = Awaited<ReturnType<typeof familyRig>>

/**
 * The formal closure of `root` (root excluded) by COLD DEPTH: level k holds
 * the cold descendants with k cold rows on their path from `root` (itself
 * included). A drawn root's progress loads level k in window k: a hot row's
 * children are read at once, a cold one's only once it has landed.
 */
function coldLevels(rig: FamilyRig, root: string): string[][] {
  const levels: string[][] = []
  const walk = (id: string, depth: number): void => {
    for (const child of rig.children(id)) {
      const cold = rig.residency.isCold('issue', child)
      const at = cold ? depth + 1 : depth
      if (cold) {
        levels[at - 1] ??= []
        levels[at - 1]!.push(child)
      }
      walk(child, at)
    }
  }
  walk(root, 0)
  return levels.map((level) => [...level].sort())
}

/** A hot visible row whose progress needs closed children, and no cold row besides its closure's. */
function familyParents(rig: FamilyRig): { id: string; levels: string[][] }[] {
  return tracked(() =>
    visibleOrderOf(rig.pool)
      .filter((id) => !rig.residency.isCold('issue', id))
      .filter((id) => {
        const node = rig.pool.knownIssue(id)!
        // No cold row the ATTENTION roll-up would ask for: no spin-off, no origin.
        return (
          node.spinOffIds.length === 0 &&
          rig.pool.relations.one('issue', id, 'discoveredFrom') === null
        )
      })
      .map((id) => ({ id, levels: coldLevels(rig, id) }))
      .filter((parent) => parent.levels.length > 0),
  )
}

// ------------------------------------------------------------ tests

describe('row roll-ups (Mb3)', () => {
  it('parity with the oracle and the rebuild on every fence scenario; commits and reads follow the change', async () => {
    const cells = await withMounted(arm, async (ctx, mounted, handle, flush) => {
      const gapAtBoot = checkParity(ctx, handle, 'bootstrap')
      expect(gapAtBoot, 'POD-4671 fixed: no gap').toBeNull()
      const out = []
      for (const entry of FENCE_SCENARIOS) {
        mounted.log.reset()
        mounted.reads.reset()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, entry)
        assertCommits(result)
        // Reads are recorded, not held to a fixed budget: whether they grow
        // with the data is the work-per-change check's (POD-4746).
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
        })
      }
      return out
    })
    expect(cells).toHaveLength(FENCE_SCENARIOS.length)
    // #7 moves a child between parents: their progress changes, and they redraw.
    const reparent = cells.find((cell) => cell.methodology === '#7')
    expect(reparent?.rowsCommitted).toBeGreaterThan(0)
    // A heartbeat composes nothing.
    writeResult('mobx-rollups-1x', { scale: 1, cells })
  }, 900_000)

  it('a question four levels deep reads the chain and composes exactly the chain', async () => {
    const correct = await chainStep(arm, true)
    expect(correct.rows).toHaveLength(5)
    expect(correct.readsPerChange).not.toBeNull()
    // The changed row and each of its four ancestors: one composition each.
    // The asked row's own view changed; the commit fence (exact, above) held the rest.
    expect(correct.oracleChanged).toContain(correct.rows[0])

    const planted = await chainStep(everyAggregate, false)
    expect(planted.rows).toEqual(correct.rows)
    // The plant recomposes more (its reads exceed the correct run's); parity still holds.
    expect(planted.readsPerChange!).toBeGreaterThanOrEqual(correct.readsPerChange!)
    writeResult('mobx-rollups-chain-1x', { scale: 1, correct, planted })
  }, 600_000)

  it('first paint at 1x and 4x: the drawn rows ask for their closed children in the first window, then settle', async () => {
    const cells = []
    for (const scale of [1, 4] as const) {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'pooled')
      const readsAtOpen = feeds.rowReads()
      const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
      const handle = mounted.handle as HarnessMobxPoolHandle
      const { pool } = handle
      try {
        const residency = pool.residency!
        // Mounted, nothing landed yet: what every drawn row shows.
        const visible = tracked(() => [...visibleOrderOf(pool)])
        const firstPaint = tracked(() =>
          visible.map((id) => {
            const view = rowViewOf(pool.issue(id))
            return {
              id,
              resident: view !== undefined,
              loading: view?.loading === true,
              rollupLoading: pool.knownIssue(id)?.rollup?.loading === true,
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
            for (const spinOff of pool.knownIssue(id)?.spinOffIds ?? []) others.add(spinOff)
          }
          const out = new Set<string>()
          for (const id of visible) {
            for (const child of pool.relations.many('issue', id, 'children')) {
              if (residency.isCold('issue', child) && !others.has(child)) out.add(child)
            }
          }
          return out
        })
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
          // Per-row reads through the feed (outside the pool) before any load lands.
          feedRowReadsAtFirstPaint: rowReadsAtFirstPaint,
          windows,
        }
        // The declared rule: no visible row is cold (POD-4665).
        expect(cell.coldVisible).toBe(0)
        // Every drawn row's progress asks for its closed children, all in the
        // first window (a visible row is hot, so they are its first cold level).
        expect(cell.coldFormalChildrenOfVisibleRows).toBeGreaterThan(0)
        expect(cell.progressLoads).toBe(cell.coldFormalChildrenOfVisibleRows)
        expect(cell.loadingRows, 'drawn rows wait for their families').toBeGreaterThan(0)
        const settled = tracked(() =>
          visible.filter((id) => rowViewOf(pool.issue(id))?.loading === true),
        )
        expect(settled).toEqual([])
        cells.push(cell)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.dispose()
      }
    }
    writeResult('mobx-rollups-first-paint', { cells })
  }, 600_000)

  it('a drawn row loads its closed family in one batch, shows loading until it lands, then equals the oracle; an undrawn row loads nothing', async () => {
    const rig = await familyRig()
    try {
      // Nothing drawn, nothing asked for: visibility reads cold rows by id
      // without loading them, and no visible row is cold by the rule. They
      // land first (none here).
      const own = rig.settleOwn()
      expect(own.length, 'nothing asked for with nothing drawn').toBe(0)
      const parents = familyParents(rig)
      // One cold level only (the chain test below covers deeper ones), two
      // or more closed children, and a second such row to leave undrawn.
      const flat = parents.filter((p) => p.levels.length === 1 && p.levels[0]!.length >= 2)
      expect(flat.length, 'two rows with a one-level closed family').toBeGreaterThanOrEqual(2)
      const drawn = flat[0]!
      const undrawn = flat[flat.length - 1]!
      const family = drawn.levels[0]!
      expect(family.some((id) => undrawn.levels[0]!.includes(id))).toBe(false)

      rig.draw(drawn.id)
      const first = rig.view(drawn.id)
      expect(first.loading, 'drawn: loading while its family is out of memory').toBe(true)
      const firstPending = rig.pending(drawn.id)
      expect(firstPending.progress, 'one progress marker per closed child').toBe(family.length)
      // One window asks for exactly its closed children: no other row.
      const batch = rig.land()
      expect([...batch].sort(), 'one batch: exactly the family').toEqual(family)
      expect(rig.queued(), 'the family landed: nothing more to load').toEqual([])
      for (const id of family) expect(rig.residency.isCold('issue', id)).toBe(false)

      const landed = rig.view(drawn.id)
      const oracle = rig.oracle(drawn.id)
      expect(landed.loading, 'landed: no longer loading').toBeUndefined()
      expect(rig.pending(drawn.id).progress).toBe(0)
      for (const field of PROGRESS) expect(landed[field], field).toBe(oracle[field])
      expect(oracle.progressTotal, 'the family counts').toBeGreaterThan(0)
      // The undrawn row's family was never asked for, and stays out of memory.
      for (const id of undrawn.levels[0]!) {
        expect(rig.residency.isCold('issue', id), `${id} (undrawn family)`).toBe(true)
      }
      expect(rig.windows.flat().filter((id) => undrawn.levels[0]!.includes(id))).toEqual([])
      writeResult('mobx-rollups-family-load-1x', {
        drawn: drawn.id,
        family: family.length,
        first: {
          loading: first.loading,
          done: first.progressDone,
          total: first.progressTotal,
          ...firstPending,
        },
        landed: { done: landed.progressDone, total: landed.progressTotal },
        oracle: { done: oracle.progressDone, total: oracle.progressTotal },
        undrawn: undrawn.id,
        undrawnFamily: undrawn.levels[0]!.length,
        flatCandidates: flat.length,
      })
    } finally {
      rig.dispose()
    }
  }, 300_000)

  it('burst seats are O(1): the re-list plant sorts more than the maintained list (POD-4678, outside)', async () => {
    /**
     * THE PLANTED MISTAKE, measured from outside. `seatList` re-listed as
     * `[...links.issue.sessions.ids(id)].sort()` copies + sorts the whole
     * family on every read (50 runs at #10); the maintained SORTED list is
     * returned without iterating it. Values stay right (parity blind); only
     * an outside sort count sees it. `countSorted` patches
     * `Array.prototype.sort` for the step (same pattern as
     * `scaling.test.ts`); relation yields and row reads cost the same either
     * way, so the reads fence cannot tell them apart.
     */
    const seatRelist: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HarnessMobxPoolHandle
        const pool = handle.pool
        const visible = pool.visibleInputs as {
          seatList: (id: string) => readonly string[]
        } & { links: { issue: { sessions: { ids(id: string): Iterable<string> } } } }
        const views = pool.inputs as {
          seatList: (id: string) => readonly string[]
        } & { links: { issue: { sessions: { ids(id: string): Iterable<string> } } } }
        visible.seatList = (id) => [...visible.links.issue.sessions.ids(id)].sort()
        views.seatList = (id) => [...views.links.issue.sessions.ids(id)].sort()
        return handle
      },
    }
    const countSorted = (run: () => Promise<void>): Promise<number> =>
      (async () => {
        const original = Array.prototype.sort
        let sorted = 0
        Array.prototype.sort = function <T>(
          this: T[],
          ...args: [compare?: (a: T, b: T) => number]
        ): T[] {
          sorted += this.length
          return (original as (...a: unknown[]) => T[]).apply(this, args)
        }
        try {
          await run()
        } finally {
          Array.prototype.sort = original
        }
        return sorted
      })()
    const burst = FENCE_SCENARIOS.find((entry) => entry.methodology === '#10')
    expect(burst, '#10 burst50').toBeDefined()
    const cells = []
    for (const scale of [1, 4] as const) {
      const sortedOf = async (create: CheckableArm): Promise<{ sorts: number; rows: number }> => {
        let sorts = 0
        let rows = 0
        await withMountedScale(create, scale, async (ctx, mounted, handle, flush) => {
          sorts = await countSorted(async () => {
            const { result } = await runFenceStep(mounted, ctx, flush, burst!)
            rows = result.rowsCommitted
            assertCommits(result)
          })
          checkParity(ctx, handle, `#10 ${scale}x`)
        })
        return { sorts, rows }
      }
      const correct = await sortedOf(arm)
      const planted = await sortedOf(seatRelist)
      expect(planted.rows, `#10 ${scale}x planted commits`).toBe(correct.rows)
      expect(
        planted.sorts,
        `#10 ${scale}x planted sorts more than the maintained list`,
      ).toBeGreaterThan(correct.sorts)
      cells.push({ scale, correctSorts: correct.sorts, plantedSorts: planted.sorts })
    }
    writeResult('mobx-rollups-burst-sorts-1x-4x', { cells })
  }, 900_000)

  it('a deep closed chain loads one level per window and converges to the oracle', async () => {
    const rig = await familyRig()
    try {
      rig.settleOwn()
      const deepest = familyParents(rig).sort((a, b) => b.levels.length - a.levels.length)[0]
      expect(deepest, 'a drawn row over a closed chain').toBeDefined()
      const { id, levels } = deepest!
      expect(levels.length, 'two or more closed levels').toBeGreaterThanOrEqual(2)
      rig.draw(id)
      const seen: { loading: boolean; done: number; total: number }[] = []
      for (const level of levels) {
        const view = rig.view(id)
        seen.push({
          loading: view.loading === true,
          done: view.progressDone,
          total: view.progressTotal,
        })
        expect(view.loading, 'loading while a level is out of memory').toBe(true)
        expect(rig.pending(id).progress, 'one marker per row of this level').toBe(level.length)
        // Window k asks for level k and nothing deeper.
        expect([...rig.land()].sort()).toEqual(level)
      }
      expect(rig.queued(), 'converged: nothing more to load').toEqual([])
      const landed = rig.view(id)
      const oracle = rig.oracle(id)
      expect(landed.loading).toBeUndefined()
      for (const field of PROGRESS) expect(landed[field], field).toBe(oracle[field])
      writeResult('mobx-rollups-family-chain-1x', {
        row: id,
        levels: levels.map((level) => level.length),
        seen,
        landed: { done: landed.progressDone, total: landed.progressTotal },
        oracle: { done: oracle.progressDone, total: oracle.progressTotal },
      })
    } finally {
      rig.dispose()
    }
  }, 300_000)

  it('attention keeps the pending marker: a review ask waits on a cold spin-off, then withdraws (Ma3 addendum)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = arm.create(feeds.rows.source, feeds.locals.source) as HarnessMobxPoolHandle
    const { pool } = handle
    const residency = pool.residency!
    let observe = () => {}
    try {
      // A visible human row with no session on the task and a cold spin-off
      // that has left the mission: reopened to review, its ask is withdrawn by
      // that continuation (`issueContinuation`), which only the spin-off's own
      // row can tell.
      const found = tracked(() => {
        for (const id of visibleOrderOf(pool)) {
          const node = pool.knownIssue(id)!
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
      observe = reaction(
        () => rowViewOf(pool.issue(id)),
        () => {},
      )
      const wire = ctx.cache.read('issueProjection', id)?.value as object
      const projection = ctx.cache.read('issueProjection', id)?.value as object | undefined
      ctx.replica.batch(() => {
        upsertIssue(ctx, id, { ...wire, stage: 'review', closedReason: null, closedAt: null })
      })
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      feeds.flush()
      expect(residency.isCold('issue', spinOff), 'the spin-off stays cold').toBe(true)
      const waiting = tracked(() => rowViewOf(pool.issue(id))!)
      const batch = residency.take()
      for (const [entity, rowId] of batch) residency.request(entity, rowId)
      expect(waiting.loading, 'loading while the spin-off is pending').toBe(true)
      expect(batch.some(([entity, rowId]) => entity === 'issue' && rowId === spinOff)).toBe(true)
      let windows = 0
      while (poolPendingLoads(pool) > 0 && windows < 16) {
        pool.hydrate()
        windows += 1
      }
      const landed = tracked(() => rowViewOf(pool.issue(id))!)
      const oracle = rowViewsFromStore(referenceState(ctx.engine), {
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
      ctx.dispose()
    }
  }, 300_000)
})
