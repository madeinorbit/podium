// @vitest-environment happy-dom
/**
 * POD-4568 (Ma4) — the a-phase fence steps on the live engine: #1 (an
 * unrelated heartbeat), #2 (a visible session phase change), #3 (a selection
 * click), and #4 (a visible title rename), in methodology order on one
 * engine, as the roster runs them.
 *
 * ONLY THE SHARED FENCES (coordinator ruling): `assertCommits`,
 * `assertReads` with the shared budgets (`FenceScenario.readsBudget`, from
 * `READ_BUDGETS`) and `assertNoCopies`. No arm-local assertion. No parity:
 * the a-phase snapshot has no order and stubs the roll-ups, so the roster
 * entry with every scenario and parity is Mb4's (POD-4572; coordinator
 * correction of 2026-09-23).
 *
 * THE COMMIT FENCE is asserted on #1-#3. #1 (Ma3): the heartbeat's closed
 * root and its session are cold, so the heartbeat is a registry write and the
 * list never drew the row. #2 and #3 change exactly the visible root the
 * oracle names. #4's commit cell is written, not asserted: #4 renames an
 * origin, its hidden spin-off (`i933`, open, so resident) redraws its ⤷
 * tick, and the a1 list draws every resident issue; the visible collection
 * is Mb1's (POD-4569), which asserts it.
 *
 * #2 BEFORE AND AFTER (POD-4568). Before this issue an issue's `activityAt`
 * and draft title read every member session's ROW on any member's change:
 * at base 1cd21c6aa #2 read 4 rows (`s34`, its siblings `s35` and `s507`,
 * and `i17`) against a budget of 3, and failed. The parts now re-compose
 * from each member's cached value (`SessionModel.activityMs`) and a
 * non-draft title reads no member: #2 reads 1.
 *
 * THE SIBLING RE-READ, planted below. On the old fixture's target (`i17`, 3
 * member sessions) re-reading the whole family cost 3 reads, the budget of
 * one level, and passed; the base failed only because a second part also
 * read `i17`. POD-4635 changed the #2 target rule (`pickTargets`,
 * `PHASE_FAMILY_FLOOR`): the target's family is now larger than one level's
 * budget, so the planted pool (member activity read from the rows again)
 * must FAIL #2's reads fence on its own.
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
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'
import { sessionActivityOf } from './views'

installMobxWarnTrap()

/** The steps a1 runs, and whether the commit fence applies yet. */
const STEPS: readonly { methodology: string; commits: boolean }[] = [
  { methodology: '#1', commits: true },
  { methodology: '#2', commits: true },
  { methodology: '#3', commits: true },
  { methodology: '#4', commits: false },
]

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    mobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

describe('fence steps #1-#4', () => {
  it('meets the shared reads budget and holds no copy', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      // At 1x no drawn row reaches a cold one (no open issue has a closed
      // origin; an open issue's sessions are hot by rule), so nothing is
      // queued and the counted steps see a settled pool.
      expect((mounted.handle as MobxPoolHandle).pool.residency?.hasQueued()).toBe(false)
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
        cells.push({
          methodology: result.methodology,
          scenario: result.scenario,
          commitFence: step.commits ? 'asserted' : 'Mb1 (the a1 list draws hidden rows)',
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
      writeResult('mobx-pool-counts-1x', { scale: 1, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a sibling re-read alone fails #2: the target family is larger than the budget', async () => {
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as MobxPoolHandle
        const inputs = handle.pool.inputs as { sessionActivity: (id: string) => number | null }
        // The pre-POD-4568 activity: each member's row, read again on every run.
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
        // The whole family of the changed session, and nothing else: more
        // than one level's budget, so the fence names it.
        const family = ctx.corpus.sessions.filter(
          (s) => s.issueId === ctx.targets.visibleRootId,
        ).length
        expect(readsBudget).toBe(3)
        expect(family).toBeGreaterThan(readsBudget)
        expect(result.reads?.byEntity).toEqual({ session: family })
        expect(() => assertReads(result, { readsPerChange: readsBudget })).toThrow(
          `read ${family} rows, budget ${readsBudget}`,
        )
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
