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
 * is written but not asserted says so in its `commitFence` cell, and is held
 * instead to the narrower claim a1 CAN meet: every row it drew that the
 * oracle did not change is a row the oracle does not show.
 *
 * #1 joined that set at Ha2 (POD-4579): its session is bound to a closed
 * agent root the worklist never shows, and now that `issue.sessions` is
 * maintained the heartbeat really moves that hidden row's `activityAt`, so
 * the a1 list redraws it.
 *
 * RESIDENCY (POD-4580, Ha3). The pool is lazy: the a1 list draws RESIDENT
 * issues. #1's closed root and its session are cold, so the heartbeat is a
 * registry write and nothing is drawn: its commit fence is asserted again.
 * #8b's grace rows are closed issues inside the 24 h grace window: visible,
 * yet cold by the schema's rule, so the a1 list does not draw the cold ones
 * (Hb1's visible collection loads them on first paint, as Mb1's must). Its
 * commit cell is written, not asserted, and it is held instead to: every row
 * the oracle changed that was not drawn is a row the pool holds cold.
 */

import { act } from 'react'
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
import type { CheckableArm } from '../../../shared/src/arm'
import { type HandPoolHandle, handPoolArm } from './arm'

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    handPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

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
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      // POD-4580: drawn rows reach cold ones (open issues with closed origins
      // on the live-shaped fixture), so the mount queues loads. Close the
      // window before counting, under act as the mount's redraw commits, then
      // start the log, stats and reads from zero: the counted steps see a
      // settled pool and no load lands inside one.
      const { pool } = mounted.handle as HandPoolHandle
      let rounds = 0
      while (pool.residency?.hasQueued() && rounds < 100) {
        act(() => {
          pool.hydrate()
        })
        rounds += 1
      }
      expect(pool.residency?.hasQueued()).toBe(false)
      mounted.log.reset()
      mounted.handle.stats.reset()
      mounted.reads.reset()
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
            : 'Hb1 (the a1 list draws resident rows, hidden ones included); extra drawn rows asserted hidden, missed rows asserted cold',
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
