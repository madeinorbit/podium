// @vitest-environment happy-dom
/**
 * POD-4708 — each issue's explicit seat list is maintained SORTED at the
 * relation delta, so a membership change yields only the new member.
 *
 * WHAT THIS HOLDS (same harness as MobX POD-4678 `withMountedScale`):
 * - #10 (burst50: fifty new sessions, one per issue) reads within its budget
 *   at 1x and 4x, with NO family-term allowance (`burstFamilyReads` deleted);
 * - the hand arm's old re-list (`[...many].sort()` through the fenced
 *   relation reader) FAILS #10 at 1x and 4x (the plant);
 * - the POD-4678 first-attempt shape (`[...seats].sort()` over the fenced
 *   mirror) FAILS #10 at 1x and 4x (the plant).
 *
 * THE RULE (MobX POD-4678 lessons): the pool maintains the issue.sessions
 * bucket in both directions on every insert and delete; the seat list follows
 * that delta sorted (binary search + splice at its id-order position, in the
 * same action). The mirror IS the relation: every id `seats()` yields counts
 * as a relation read, exactly as `many()` yields do. Production returns the
 * maintained list without iterating it (`seatList`), so a new member costs
 * the new member, never the family.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  assertCommits,
  assertReads,
  type MountedArm,
  mountArmForCounts,
} from '../../../../harness/src/count-harness'
import {
  FENCE_SCENARIOS,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from '../../../../harness/src/fence-scenarios'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine } from '../../../../shared/src/scenarios'
import { drainPoolLoads, harnessHandPoolArm, type HarnessHandPoolHandle } from '../../../../harness/src/adapters/hand-pool'
import type { HandPool } from '../pool'

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessHandPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

/** Close load windows until nothing is queued (the mount asks for every drawn cold row). */
function settle(pool: HandPool): number {
  let rounds = 0
  while (pool.residency?.hasQueued() && rounds < 100) {
    act(() => {
      drainPoolLoads(pool)
    })
    rounds += 1
  }
  expect(pool.residency?.hasQueued()).toBe(false)
  return rounds
}

/** The settled snapshot against the oracle and the rebuild (no exception). */
function checkParity(ctx: ScenarioEngine, handle: HarnessHandPoolHandle, at: string): void {
  const snapshot = handle.snapshot()
  const oracle = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
  expect(diffSnapshots(snapshot, oracle), `${at}: oracle`).toBeNull()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
}

/**
 * POD-4678 — same harness as `withMounted` (mounted React list, same
 * schedule, same settle) at the loop scale (1x and 4x run the SAME React/page
 * path). 4x OOMs on ludovico's podium-sessions cgroup cap — run it on
 * flatblock, free.
 */
async function withMountedScale<T>(
  create: CheckableArm,
  scale: 1 | 4,
  run: (
    ctx: ScenarioEngine,
    mounted: MountedArm,
    handle: HarnessHandPoolHandle,
    flush: () => void,
  ) => Promise<T>,
): Promise<T> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(create, feeds.rows.source, feeds.locals)
  try {
    const handle = mounted.handle as HarnessHandPoolHandle
    settle(handle.pool)
    return await run(ctx, mounted, handle, feeds.flush)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

/**
 * THE OLD RE-LIST (plant): the hand arm's shape before this issue —
 * `[...many].sort()` through the fenced relation reader, which counts every
 * id it yields, so a new member re-reads its whole family. Must FAIL #10.
 */
const seatRelist: CheckableArm = {
  create(source, locals, reads) {
    const handle = arm.create(source, locals, reads) as HarnessHandPoolHandle
    const pool = handle.pool
    const visible = pool.visibleInputs as unknown as {
      seatList: (id: string) => readonly string[]
    }
    const inputs = pool.inputs as unknown as {
      seatList: (id: string) => readonly string[]
    }
    const relations = pool.relations
    visible.seatList = (id) => [...relations.many('issue', id, 'sessions')].sort()
    inputs.seatList = (id) => [...relations.many('issue', id, 'sessions')].sort()
    return handle
  },
}

/**
 * THE FIRST-ATTEMPT SHAPE (plant, POD-4678): `[...seats].sort()` over the
 * fenced mirror — every yielded id counts as a relation read, exactly as
 * `many()` yields do, so a new member re-reads its whole family. Must FAIL.
 */
const seatFencedMirrorSort: CheckableArm = {
  create(source, locals, reads) {
    const handle = arm.create(source, locals, reads) as HarnessHandPoolHandle
    const pool = handle.pool
    const visible = pool.visibleInputs as unknown as {
      seats: (id: string) => Iterable<string>
      seatList: (id: string) => readonly string[]
    }
    const inputs = pool.inputs as unknown as {
      seats: (id: string) => Iterable<string>
      seatList: (id: string) => readonly string[]
    }
    visible.seatList = (id) => [...visible.seats(id)].sort()
    inputs.seatList = (id) => [...inputs.seats(id)].sort()
    return handle
  },
}

describe('seat list maintained at the relation delta (POD-4708)', () => {
  it('burst50 reads within its budget at 1x and 4x, no family allowance', async () => {
    const burst = FENCE_SCENARIOS.find((entry) => entry.methodology === '#10')
    expect(burst, '#10 burst50').toBeDefined()
    const cells = []
    for (const scale of [1, 4] as const) {
      const cell = await withMountedScale(arm, scale, async (ctx, mounted, handle, flush) => {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, flush, burst!)
        assertCommits(result)
        // NO allowance: the budget alone (POD-4678 removed the family term
        // from MobX; the hand arm meets the same budget).
        assertReads(result, { readsPerChange: readsBudget })
        // The copy sweep walks the whole handle (1M-object cap): at 4x it
        // exceeds the cap even without copies, so only sweep at 1x (the
        // existing rollup fence already sweeps at 1x; this test is about reads).
        if (scale === 1) mounted.reads.assertNoCopies(mounted.handle)
        checkParity(ctx, handle, `#10 ${scale}x`)
        return {
          scale,
          readsPerChange: result.readsPerChange,
          readsBudget,
          rowsCommitted: result.rowsCommitted,
          byEntity: result.reads?.byEntity,
          seats: handle.pool.engine.seatFootprint(),
        }
      })
      cells.push(cell)
    }
    writeResult('hand-seats-burst-1x-4x', { cells })
  }, 900_000)

  it('the old re-list plant fails #10 at 1x and 4x', async () => {
    const burst = FENCE_SCENARIOS.find((entry) => entry.methodology === '#10')
    expect(burst, '#10 burst50').toBeDefined()
    for (const scale of [1, 4] as const) {
      let readsPerChange: number | null = null
      let readsBudget = 0
      let threw: Error | null = null
      await withMountedScale(seatRelist, scale, async (ctx, mounted, handle, flush) => {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const step = await runFenceStep(mounted, ctx, flush, burst!)
        readsPerChange = step.result.readsPerChange
        readsBudget = step.readsBudget
        try {
          assertReads(step.result, { readsPerChange: step.readsBudget })
        } catch (error) {
          threw = error as Error
        }
      })
      expect(
        threw,
        `#10 ${scale}x re-list plant must exceed its budget (read ${readsPerChange}, budget ${readsBudget})`,
      ).not.toBeNull()
      expect(readsPerChange!, `#10 ${scale}x re-list reads over budget`).toBeGreaterThan(readsBudget)
    }
  }, 900_000)

  it('the fenced-mirror sort plant fails #10 at 1x and 4x', async () => {
    const burst = FENCE_SCENARIOS.find((entry) => entry.methodology === '#10')
    expect(burst, '#10 burst50').toBeDefined()
    for (const scale of [1, 4] as const) {
      let readsPerChange: number | null = null
      let readsBudget = 0
      let threw: Error | null = null
      await withMountedScale(seatFencedMirrorSort, scale, async (ctx, mounted, handle, flush) => {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const step = await runFenceStep(mounted, ctx, flush, burst!)
        readsPerChange = step.result.readsPerChange
        readsBudget = step.readsBudget
        try {
          assertReads(step.result, { readsPerChange: step.readsBudget })
        } catch (error) {
          threw = error as Error
        }
      })
      expect(
        threw,
        `#10 ${scale}x fenced-mirror plant must exceed its budget (read ${readsPerChange}, budget ${readsBudget})`,
      ).not.toBeNull()
      expect(readsPerChange!, `#10 ${scale}x fenced-mirror reads over budget`).toBeGreaterThan(
        readsBudget,
      )
    }
  }, 900_000)
})
