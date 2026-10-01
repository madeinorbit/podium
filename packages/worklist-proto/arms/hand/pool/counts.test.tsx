// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the fence steps on the live 1x engine: #1 (an unrelated
 * heartbeat), #2 (a visible session phase change, added at Ha4, POD-4581),
 * #3 (a selection click), #4 (a visible title rename), #8 (a clock tick) and
 * #8b (a tick across the finished grace).
 *
 * ONLY THE SHARED FENCES (coordinator ruling on Ma1, applied symmetrically):
 * `assertCommits`, `assertReads` with the shared budgets
 * (`FenceScenario.readsBudget`, from `READ_BUDGETS`) and `assertNoCopies`. No
 * arm-local budget or assertion.
 *
 * PARITY is not here: the roll-ups are stubs until Hb3, and the visible
 * order's parity is `worklist/visible.test.tsx`; the roster entry with parity
 * is Hb4's (POD-4585; coordinator correction of 2026-09-23). A step whose
 * commit cell is written but not asserted (`commits: false`, none since Hb1)
 * is held to the narrower claims in the loop below.
 *
 * #1: its session is bound to a closed agent root the worklist never shows;
 * the root and its session are cold (Ha3, POD-4580), so the heartbeat is a
 * registry write and nothing is drawn.
 *
 * HB1 (POD-4582): the list draws the visible collection in rank order, and
 * since POD-4665 every visible row is resident, so the commit fence is
 * asserted on every step: #4's hidden spin-off re-derives its tick but is not
 * drawn, and #8b's grace rows are resident and drawn. A list that draws
 * hidden rows failing #1 and a #4-shaped rename is `worklist/visible.test.tsx`.
 *
 * #2 BEFORE AND AFTER (POD-4581, Ma4's lesson). Before this issue an issue's
 * `activityAt` walked its `issue.sessions` bucket and read every member's
 * ROW whenever any member changed: at cc666f264 #2 read 7 sessions (the
 * target's whole family, POD-4635) against a budget of 3, and failed. The
 * bucket is now read once into the `sessionIds` part, each member's
 * contribution is its own cell (`HandPool.sessionActivity`), and `activityAt`
 * re-composes from those cached values: #2 reads 1.
 *
 * THE SIBLING RE-READ, planted below: the same pool with member activity read
 * from the rows again inside `activityAt`. The target's family is larger than
 * one level's budget, so the plant must FAIL #2's reads fence on its own.
 */

import { describe, expect, it } from 'vitest'
import { assertCommits, assertReads, mountArmForCounts } from '../../../harness/src/count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  openFenceFeeds,
  runFenceStep,
} from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm } from '../../../shared/src/arm'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { harnessHandPoolArm, poolPendingLoads, type HarnessHandPoolHandle } from '../../../harness/src/adapters/hand-pool'
import { sessionActivityOf } from './views'

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessHandPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

/** The steps a1 runs, and whether the commit fence applies yet. */
const STEPS: readonly { methodology: string; commits: boolean }[] = [
  { methodology: '#1', commits: true },
  { methodology: '#2', commits: true },
  { methodology: '#3', commits: true },
  { methodology: '#4', commits: true },
  { methodology: '#8', commits: true },
  { methodology: '#8b', commits: true },
]

describe('fence steps #1-#4, #8, #8b', () => {
  it('meets the shared reads budget and holds no copy; the commit fence where a1 can', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      // POD-4580: drawn rows reach cold ones (open issues with closed origins
      // on the live-shaped fixture), so the mount queues loads. The window
      // never closes on its own here. The shared fence (POD-4568, G2) lands
      // them through the arm's `settleLoads()`: the mount's before #1,
      // outside the count, and each step's own inside it, charged to it.
      const { pool } = mounted.handle as HarnessHandPoolHandle
      expect(poolPendingLoads(pool)).toBeGreaterThan(0)
      const cells = []
      for (const step of STEPS) {
        const entry = FENCE_SCENARIOS.find(
          (candidate) => candidate.methodology === step.methodology,
        )
        expect(entry, step.methodology).toBeDefined()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        if (step.commits) assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        const visible = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
        if (!step.commits) {
          const changed = new Set(result.oracleChangedRows ?? [])
          const shownExtra = (result.drawnRows ?? []).filter(
            (id) => !changed.has(id) && visible[id] !== undefined,
          )
          expect(
            shownExtra,
            `${step.methodology}: drew a VISIBLE row the oracle did not change`,
          ).toEqual([])
          const drawn = new Set(result.drawnRows ?? [])
          const missed = [...changed].filter((id) => !drawn.has(id))
          expect(
            missed.filter((id) => pool.residency?.isCold('issue', id) !== true),
            `${step.methodology}: missed a changed row the pool holds resident`,
          ).toEqual([])
        }
        cells.push({
          methodology: result.methodology,
          scenario: result.scenario,
          commitFence: step.commits
            ? 'asserted'
            : 'not asserted; extra drawn rows asserted hidden, missed rows asserted cold',
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
          oracleVisible: Object.fromEntries(
            (result.drawnRows ?? []).map((id) => [id, visible[id] !== undefined]),
          ),
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsByEntity: result.reads?.byEntity,
          readsBudget,
          stats: result.stats,
        })
      }
      writeResult('hand-pool-counts-1x', { scale: 1, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a sibling re-read alone fails #2: the retained seats are larger than the budget', async () => {
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HarnessHandPoolHandle
        const inputs = handle.pool.inputs as { sessionActivity: (id: string) => number | null }
        // Uncached per-member row reads: each retained seat's row, read again
        // on every run.
        inputs.sessionActivity = (id) => sessionActivityOf(handle.pool.inputs.session(id))
        return handle
      },
    }
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(planted, feeds.rows.source, feeds.locals)
    try {
      for (const methodology of ['#1', '#2']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        assertCommits(result)
        if (methodology !== '#2') {
          assertReads(result, { readsPerChange: readsBudget })
          continue
        }
        // The retained seats of the changed session's row, plus its owner:
        // more than one level's budget, so the fence names it. Since POD-4953
        // the owner issue carries denormalized sessionFacts (row-source
        // installSessionFacts: replica/tip max lastActiveAt per owner, for
        // complete sidebar parity). #2's phase change bumps lastActiveAt
        // (writePhaseChange patches lastActiveAt:now), moving the owner's
        // sessionFacts, so the plant reads the owner issue (1) in addition to
        // the 5 retained sessions. The read is needed (otherwise the arm
        // misses the sessionFacts move); session reads alone (5) still exceed
        // the budget (3), so the plant still fails for its intended reason.
        const family = (mounted.handle as HarnessHandPoolHandle).pool.inputs.retainedSeats(
          ctx.targets.visibleRootId,
        ).length
        expect(readsBudget).toBe(3)
        expect(family).toBeGreaterThan(readsBudget)
        expect(result.reads?.byEntity).toEqual({ issue: 1, session: family })
        expect(() => assertReads(result, { readsPerChange: readsBudget })).toThrow(
          `read ${family + 1} rows, budget ${readsBudget}`,
        )
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
