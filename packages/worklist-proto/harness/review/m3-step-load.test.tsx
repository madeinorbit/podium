// @vitest-environment happy-dom
/**
 * POD-4591 (M3), second re-review — does a fence step count the load its OWN
 * change triggers?
 *
 * `arms/mobx/pool/counts.test.tsx` (L2d, POD-4635) settles the mount's load
 * windows and zeroes the counters before step #1, and runs the pool with a
 * load window that never closes on its own (`schedule: () => () => {}`). A
 * load queued INSIDE a step then lands only when `runCountScenario` calls
 * `snapshot()` (which settles), and that is after it has sampled the reads.
 *
 * THE PLANT. From step #2 on, the pool's `sessionActivity` input (which the
 * #2 session change re-runs) also asks where a cold issue P stands
 * (`pool.resident`, as a view does before it reads a row) and, once P is
 * loaded, lists P's sessions (`relations.many`). Before the load that
 * charges one key (P, via the table's `has`) and queues P; once P loads it
 * also charges P's S session keys. P is chosen cold with S = 2, so the
 * charge before the load is 1 + 1 = 2 (#2's budget is 3) and after it is 4.
 * (On this corpus a closed issue's sessions are resident: the first probe
 * found 0 cold sessions under every cold issue, so the load is P itself.)
 *
 * FINAL REVIEW (§7): since POD-4568 G2 the shared fence (`runFenceStep`)
 * awaits the arm's `settleLoads()` inside each step, so the load now lands in
 * #2 under BOTH windows and A is charged what B is. The assertions pin that;
 * the old ones (A charged 2 and passed) pinned the defect.
 *
 * TWO ARMS, same plant, same steps (#1 then #2), same settle and zeroing as
 * counts.test.tsx had before G2:
 * - A, the counts test's pool: the window never closes on its own.
 * - B, the control: the window closes on the next microtask, so the load
 *   lands inside the step's act.
 * The step's reads (`result`) are compared with the fence's reads read again
 * after `runFenceStep` returns (`after`): anything in `after` but not in
 * `result` happened in this step's aftermath and was charged to no step
 * (the next step's reset clears it).
 */

import { appendFileSync } from 'node:fs'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  type HarnessMobxPoolHandle,
  harnessMobxPoolArm,
  poolPendingLoads,
  tracked,
} from '../src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../src/mobx-trap'
import type { Schedule } from '@podium/client-graph/residency'
import type { CheckableArm } from '../../shared/src/arm'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertReads, mountArmForCounts } from '../src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../src/fence-scenarios'

installMobxWarnTrap()

const NEVER: Schedule = () => () => {}
const MICROTASK: Schedule = (run) => {
  let live = true
  queueMicrotask(() => {
    if (live) run()
  })
  return () => {
    live = false
  }
}

interface Plant {
  target: string | null
  /** Plant runs with a target, and how many of them saw P loaded. */
  runs: number
  loadedRuns: number
}

function plantedArm(schedule: Schedule, plant: Plant): CheckableArm {
  return {
    create(source, locals, reads) {
      const handle = harnessMobxPoolArm.create(source, locals, reads, { schedule })
      const pool = handle.pool
      const inputs = pool.inputs as { sessionActivity: (id: string) => number | null }
      const original = inputs.sessionActivity
      inputs.sessionActivity = (id) => {
        const target = plant.target
        if (target !== null) {
          plant.runs += 1
          if (pool.resident('issue', target) === 'resident') {
            plant.loadedRuns += 1
            for (const _ of pool.inputs.links.issue.sessions.ids(target)) void _
          }
        }
        return original(id)
      }
      return handle
    },
  }
}

interface ArmResult {
  arm: string
  target: string
  charged: number
  chargedByEntity: Record<string, number> | undefined
  after: number
  afterByEntity: Record<string, number>
  hydratedInStep: number
  /** Rows loaded after the harness sampled the step's reads: charged to no step. */
  hydratedAfterSample: number
  rowsCommitted: number
  plantRuns: number
  plantLoadedRuns: number
  fence: 'pass' | string
}

async function runArm(name: string, schedule: Schedule, planted: boolean): Promise<ArmResult> {
  const plant: Plant = { target: null, runs: 0, loadedRuns: 0 }
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(plantedArm(schedule, plant), feeds.rows.source, feeds.locals)
  try {
    const { pool } = mounted.handle as HarnessMobxPoolHandle
    const residency = pool.residency
    if (residency === null) throw new Error('the counts pool is lazy; residency is null')
    // Settle exactly as counts.test.tsx does, then zero.
    let rounds = 0
    while (poolPendingLoads(pool) > 0 && rounds < 100) {
      act(() => {
        pool.hydrate()
      })
      rounds += 1
    }
    expect(poolPendingLoads(pool)).toBe(0)
    mounted.log.reset()
    mounted.handle.stats.reset()
    mounted.reads.reset()

    const step = async (methodology: string) => {
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
      if (entry === undefined) throw new Error(`no ${methodology}`)
      return runFenceStep(mounted, ctx, feeds.flush, entry)
    }
    await step('#1')

    // A cold issue with exactly two sessions, still cold after the settle.
    const byIssue = new Map<string, string[]>()
    for (const s of ctx.corpus.sessions) {
      if (s.issueId == null) continue
      byIssue.set(s.issueId, [...(byIssue.get(s.issueId) ?? []), s.sessionId])
    }
    let target: string | null = null
    for (const [issueId, sessions] of byIssue) {
      if (sessions.length !== 2) continue
      // `known` is TRACKED: ask inside a reactive context, as a reader would.
      if (!tracked(() => residency.known('issue', issueId))) continue
      target = issueId
      break
    }
    if (target === null) {
      const shape = tracked(() => {
        const out: Record<string, number> = {}
        for (const [issueId, sessions] of byIssue) {
          if (!residency.known('issue', issueId)) continue
          const cold = sessions.filter((s) => residency.known('session', s)).length
          const key = `${sessions.length}/${cold}`
          out[key] = (out[key] ?? 0) + 1
        }
        return out
      })
      throw new Error(
        `no cold issue with two sessions; cold issues by sessions/coldSessions: ${JSON.stringify(shape)}`,
      )
    }
    if (planted) plant.target = target

    const tableRows = (): number => tracked(() => pool.tables.issue.size + pool.tables.session.size)
    const rowsBefore = tableRows()
    let rowsInStep = -1
    // Count rows installed before runCountScenario samples its reads: the
    // sample is taken right after the step's act, so a load inside the act
    // happens before the first `snapshot()` call.
    const snapshot = mounted.handle.snapshot.bind(mounted.handle)
    mounted.handle.snapshot = () => {
      if (rowsInStep < 0) rowsInStep = tableRows() - rowsBefore
      return snapshot()
    }
    const { result, readsBudget } = await step('#2')
    const after = mounted.reads.stats()
    let fence = 'pass'
    try {
      assertReads(result, { readsPerChange: readsBudget })
    } catch (error) {
      fence = (error as Error).message
    }
    const rowsAfter = tableRows() - rowsBefore
    const out: ArmResult = {
      arm: name,
      target,
      charged: result.readsPerChange ?? -1,
      chargedByEntity: result.reads?.byEntity,
      after: after.rows,
      afterByEntity: after.byEntity,
      hydratedInStep: rowsInStep,
      hydratedAfterSample: rowsAfter - rowsInStep,
      rowsCommitted: result.rowsCommitted,
      plantRuns: plant.runs,
      plantLoadedRuns: plant.loadedRuns,
      fence,
    }
    const line = `[m3-step-load] ${JSON.stringify(out)}\n`
    if (process.env.M3_PROBE_OUT) appendFileSync(process.env.M3_PROBE_OUT, line)
    else console.info(line)
    return out
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('a fence step counts the load its own change triggers (M3 re-review 2)', () => {
  it('A/B on the load window, each with a no-plant control', async () => {
    const d = await runArm('D never, no plant', NEVER, false)
    const a = await runArm('A never, planted', NEVER, true)
    const c = await runArm('C microtask, no plant', MICROTASK, false)
    const b = await runArm('B microtask, planted', MICROTASK, true)
    expect(new Set([a.target, b.target, c.target, d.target]).size).toBe(1)
    // The window alone changes nothing on the clean pool.
    expect(c.charged).toBe(d.charged)
    expect(c.hydratedInStep).toBe(0)
    // THE CONTRACT SINCE POD-4568 G2 (b29ea68ce): the shared fence settles a
    // lazy arm's loads inside the step, so the plant's load lands in #2 under
    // either window and is charged to it. Before G2, A (the counts test's
    // window) landed it after the reads were sampled: hydratedInStep 0,
    // charged 2. The installed-rows lines below verify the charging from
    // outside (table sizes before/at/after the sample); the old reads-budget
    // lines are retired with the fence doors (POD-4759: relation yields and
    // ingest reads are not data reads, so the plant's load costs its feed
    // reads only).
    expect(a.hydratedInStep).toBeGreaterThan(0)
    // Nothing lands after the sample (the fence also refuses that itself).
    expect(a.hydratedAfterSample).toBe(0)
    // The window no longer decides what a step is charged.
    expect(a.charged).toBe(b.charged)
    expect(b.hydratedInStep).toBeGreaterThan(0)
  }, 600_000)

  it('clean pool, steps #1-#4: does any step trigger a load of its own?', async () => {
    for (const [name, schedule] of [
      ['never', NEVER],
      ['microtask', MICROTASK],
    ] as const) {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const plant: Plant = { target: null, runs: 0, loadedRuns: 0 }
      const mounted = mountArmForCounts(
        plantedArm(schedule, plant),
        feeds.rows.source,
        feeds.locals,
      )
      try {
        const { pool } = mounted.handle as HarnessMobxPoolHandle
        while (poolPendingLoads(pool) > 0) act(() => pool.hydrate())
        mounted.log.reset()
        mounted.reads.reset()
        const snapshot = mounted.handle.snapshot.bind(mounted.handle)
        let atSample = -1
        mounted.handle.snapshot = () => {
          if (atSample < 0) atSample = tracked(() => pool.tables.issue.size + pool.tables.session.size)
          return snapshot()
        }
        const cells = []
        for (const methodology of ['#1', '#2', '#3', '#4']) {
          const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)!
          const before = tracked(() => pool.tables.issue.size + pool.tables.session.size)
          atSample = -1
          const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
          const afterStep = tracked(() => pool.tables.issue.size + pool.tables.session.size)
          cells.push({
            methodology,
            charged: result.readsPerChange,
            readsBudget,
            rowsCommitted: result.rowsCommitted,
            hydratedInStep: atSample - before,
            hydratedAfterSample: afterStep - atSample,
          })
        }
        const line = `[m3-step-load clean] ${name} ${JSON.stringify(cells)}\n`
        if (process.env.M3_PROBE_OUT) appendFileSync(process.env.M3_PROBE_OUT, line)
        else console.info(line)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
  }, 600_000)
})
