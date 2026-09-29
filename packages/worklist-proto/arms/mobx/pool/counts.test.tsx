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
 * THE COMMIT FENCE is asserted on #1-#4. #1 (Ma3): the heartbeat's closed
 * root and its session are cold, so the heartbeat is a registry write and the
 * list never drew the row. #2 and #3 change exactly the visible root the
 * oracle names. #4 (POD-4569): the rename's hidden spin-off (`i933`, open,
 * so resident) still re-derives its ⤷ tick, but the list now draws only the
 * visible collection, so it is never drawn; `worklist/visible.test.tsx`
 * shows a list that draws hidden rows failing #1 and #4.
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
 *
 * A STEP'S OWN LOADS (G2, M3 re-review 2 §6.3). The pool's load window never
 * closes on its own here, so every load lands through the shared fence:
 * `runFenceStep` lands the mount's loads before #1, outside the count, and
 * awaits the arm's `settleLoads()` inside each step, so a load the step's own
 * change triggers is charged to it. Before, this test settled the mount
 * itself and a step's load landed in the harness's `snapshot()`, after the
 * reads were sampled: M3's cold-issue plant charged #2 2 reads and passed.
 * Planted below, it now fails #2's reads fence. The clean cells did not move
 * (#1 reads 2, #2-#4 read 1; commits 0/1/1/1). The fence also refuses a lazy
 * arm without the hooks, or with a settle that lands nothing.
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
import { type HarnessMobxPoolHandle, harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'
import { activityMsOf } from './views'

installMobxWarnTrap()

/** The steps a1 runs, and whether the commit fence applies yet. */
const STEPS: readonly { methodology: string; commits: boolean }[] = [
  { methodology: '#1', commits: true },
  { methodology: '#2', commits: true },
  { methodology: '#3', commits: true },
  { methodology: '#4', commits: true },
]

/**
 * The pool with a load window that never closes on its own: every load lands
 * through the shared fence's `settleLoads` (G2), none by a timer in a later step.
 */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessMobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

describe('fence steps #1-#4', () => {
  it('meets the shared reads budget and holds no copy', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      // Drawn rows reach cold ones on the live-shaped fixture (open issues
      // with closed spin-off origins: live has 842 such edges, POD-4635), so
      // the mount queues loads. The shared fence lands them before step #1,
      // outside the count, and each step's own loads inside it (G2).
      expect((mounted.handle as HarnessMobxPoolHandle).pendingLoads()).toBeGreaterThan(0)
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
          commitFence: step.commits ? 'asserted' : 'not asserted',
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
    let plantedPool: HarnessMobxPoolHandle['pool'] | null = null
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HarnessMobxPoolHandle
        plantedPool = handle.pool
        const inputs = handle.pool.inputs as { sessionActivity: (id: string) => number | null }
        // The pre-POD-4568 activity: each member's row, read again on every run.
        inputs.sessionActivity = (id) => activityMsOf(handle.pool.inputs.session(id))
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
        // than one level's budget, so the fence names it. The family is the
        // row's retained seats, whose stamps `activityAt` reads (POD-4679:
        // legacy `retainedSessions`), not every session naming the issue.
        const family = tracked(
          () => plantedPool!.knownIssue(ctx.targets.visibleRootId)!.retainedSeatIds.length,
        )
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
  it('a load the step itself triggers is charged to it: the cold-issue plant fails #2 (G2)', async () => {
    // M3's plant (harness/review/m3-step-load.test.tsx, `plantedArm`): from
    // #2 on, the `sessionActivity` input the #2 change re-runs also asks
    // whether a cold issue is resident (queueing its load, as a view does
    // before it reads a row) and, once it is, lists its sessions.
    let target: string | null = null
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HarnessMobxPoolHandle
        const { pool } = handle
        const inputs = pool.inputs as { sessionActivity: (id: string) => number | null }
        const original = inputs.sessionActivity
        inputs.sessionActivity = (id) => {
          if (target !== null && pool.resident('issue', target) === 'resident') {
            for (const _ of pool.inputs.links.issue.sessions.ids(target)) void _
          }
          return original(id)
        }
        return handle
      },
    }
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(planted, feeds.rows.source, feeds.locals)
    try {
      const step = (methodology: string) =>
        runFenceStep(
          mounted,
          ctx,
          feeds.flush,
          FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)!,
        )
      const one = await step('#1')
      assertReads(one.result, { readsPerChange: one.readsBudget })
      // A cold issue with two sessions, still cold after the mount's loads.
      const { pool } = mounted.handle as HarnessMobxPoolHandle
      const byIssue = new Map<string, number>()
      for (const s of ctx.corpus.sessions) {
        if (s.issueId != null) byIssue.set(s.issueId, (byIssue.get(s.issueId) ?? 0) + 1)
      }
      target =
        [...byIssue].find(
          ([id, sessions]) => sessions === 2 && tracked(() => pool.residency!.known('issue', id)),
        )?.[0] ?? null
      expect(target, 'a cold issue with two sessions').not.toBeNull()
      const hydrated = pool.residency!.counters.hydrated
      const two = await step('#2')
      // The load lands inside #2, and the reads fence names what it cost. In
      // the a phase that was the resident-issue list re-running over the
      // table the loaded issue joined (M3 §6.3 arm B: 2,839 reads); since Mb1
      // (POD-4569) the list is the maintained visible collection, which does
      // not re-enumerate, so the charge is the load and what the plant reads
      // after it: still over the budget, inside the step.
      expect(pool.residency!.counters.hydrated - hydrated, 'rows loaded in #2').toBeGreaterThan(0)
      expect(two.readsBudget).toBe(3)
      expect(two.result.readsPerChange).toBeGreaterThan(two.readsBudget)
      expect(() => assertReads(two.result, { readsPerChange: two.readsBudget })).toThrow(
        `read ${two.result.readsPerChange} rows, budget ${two.readsBudget}`,
      )
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
  it('a lazy arm without the load hooks, or with a no-op settle, is refused (G2); so is a wrapped flush (N9)', async () => {
    const noHooks = (handle: HarnessMobxPoolHandle): HarnessMobxPoolHandle => {
      const bare: Partial<HarnessMobxPoolHandle> = { ...handle }
      delete bare.settleLoads
      delete bare.pendingLoads
      return bare as HarnessMobxPoolHandle
    }
    for (const [name, strip, wrapFlush, message] of [
      ['no hooks', noHooks, false, 'but has no settleLoads() and pendingLoads()'],
      [
        'a no-op settle',
        (handle: HarnessMobxPoolHandle) => ({ ...handle, settleLoads: () => {} }),
        false,
        'did not settle',
      ],
      // N9: the fence finds the feeds by the flush's identity. A wrapper
      // found none, and a lazy arm without hooks passed unrefused.
      ['no hooks, wrapped flush', noHooks, true, 'the flush is not an openFenceFeeds flush'],
    ] as const) {
      const stripped: CheckableArm = {
        create: (source, locals, reads) =>
          strip(arm.create(source, locals, reads) as HarnessMobxPoolHandle),
      }
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const mounted = mountArmForCounts(stripped, feeds.rows.source, feeds.locals)
      try {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#1')!
        const flush = wrapFlush ? () => feeds.flush() : feeds.flush
        await expect(runFenceStep(mounted, ctx, flush, entry), name).rejects.toThrow(message)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
  }, 120_000)
})
