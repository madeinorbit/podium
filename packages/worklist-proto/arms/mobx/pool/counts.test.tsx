// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the fence steps that need no relation, on the live
 * engine: #1 (an unrelated heartbeat) and #4 (a visible title rename).
 *
 * ONLY THE SHARED FENCES (coordinator ruling): `assertCommits`,
 * `assertReads` with the shared budgets (`FenceScenario.readsBudget`, from
 * `READ_BUDGETS`) and `assertNoCopies`. No arm-local assertion.
 *
 * WHAT a1 CANNOT MEET, and where it lands. Parity: the a1 snapshot has no
 * order and stubs the roll-ups; the roster entry with every scenario and
 * parity is Mb4's (POD-4572). The commit fence on #4: `assertCommits`
 * compares against the oracle's VISIBLE rows, and the a1 list draws every
 * issue (the visible collection is Mb1, POD-4569). #4 renames an origin, so
 * its hidden spin-off's ⤷ tick changes and is drawn, which the fence counts as
 * an over-commit. #4's commit cell is written to the results file, not
 * asserted; the fence asserts it from Mb1.
 *
 * #1 joined #4 with Ma2 (POD-4566). The heartbeat's session belongs to a
 * closed agent-audience root (`scenarios.ts` `heartbeat`), a row the worklist
 * hides. Once `issue.sessions` is maintained, that hidden row's `activityAt`
 * (max `lastActiveAt` of its sessions) moves on the heartbeat, and the a1
 * list, drawing every issue, redraws it: the fence's over-commit is exactly
 * that hidden row (`oracleVisible: false` in the results cell). Its reads
 * stay asserted.
 */

import { describe, expect, it, vi } from 'vitest'
import { assertCommits, assertReads, mountArmForCounts } from '../../../harness/src/count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  openFenceFeeds,
  runFenceStep,
} from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { CheckableArm } from '../../../shared/src/arm'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap()

/** The steps a1 runs, and whether the commit fence applies yet. */
const STEPS: readonly { methodology: string; commits: boolean }[] = [
  { methodology: '#1', commits: true },
  { methodology: '#4', commits: true },
]

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    mobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

describe('fence steps #1 and #4', () => {
  it('meets the shared reads budget and holds no copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
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
      vi.useRealTimers()
    }
  }, 120_000)
})
