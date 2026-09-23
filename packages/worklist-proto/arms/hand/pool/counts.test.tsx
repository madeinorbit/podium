// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the fence steps that need no relation, on the live 1x
 * engine: #1 (an unrelated heartbeat), #3 (a selection click), #4 (a visible
 * title rename), #8 (a clock tick) and #8b (a tick across the finished
 * grace).
 *
 * ONLY THE SHARED FENCES (coordinator ruling on Ma1, applied symmetrically):
 * `assertCommits`, `assertReads` with the shared budgets
 * (`FenceScenario.readsBudget`, from `READ_BUDGETS`) and `assertNoCopies`. No
 * arm-local budget or assertion.
 *
 * WHAT a1 CANNOT MEET, and where it lands. Parity: the a1 snapshot has no
 * order and stubs the roll-ups; the roster entry with parity is Ha4's
 * (POD-4581). The commit fence where a step changes a HIDDEN row: the fence
 * compares against the oracle's VISIBLE rows and the a1 list draws every
 * issue (the visible collection is Hb1, POD-4582). A step whose commit cell
 * is written but not asserted says so in its `commitFence` cell.
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
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { handPoolArm } from './arm'

/** The steps a1 runs, and whether the commit fence applies yet. */
const STEPS: readonly { methodology: string; commits: boolean }[] = [
  { methodology: '#1', commits: true },
  { methodology: '#3', commits: true },
  { methodology: '#4', commits: false },
  { methodology: '#8', commits: true },
  { methodology: '#8b', commits: false },
]

describe('fence steps #1, #3, #4, #8, #8b', () => {
  it('meets the shared reads budget and holds no copy; the commit fence where a1 can', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(handPoolArm, feeds.rows.source, feeds.locals)
    try {
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
          commitFence: step.commits ? 'asserted' : 'Hb1 (the a1 list draws hidden rows)',
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
})
