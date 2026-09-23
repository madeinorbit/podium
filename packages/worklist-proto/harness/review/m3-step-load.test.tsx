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
 * TWO ARMS, same plant, same steps (#1 then #2), same settle and zeroing as
 * counts.test.tsx:
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
import { mobxPoolArm, type MobxPoolHandle } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { tracked } from '../../arms/mobx/pool/pool'
import type { Schedule } from '../../arms/mobx/pool/residency'
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
      const handle = mobxPoolArm.create(source, locals, reads, { schedule }) as MobxPoolHandle
      const pool = handle.pool
      const inputs = pool.inputs as { sessionActivity: (id: string) => number | null }
      const original = inputs.sessionActivity
      inputs.sessionActivity = (id) => {
        const target = plant.target
        if (target !== null) {
          plant.runs += 1
          if (pool.resident('issue', target) === 'resident') {
            plant.loadedRuns += 1
            for (const _ of pool.inputs.relations.many('issue', target, 'sessions')) void _
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
    const { pool } = mounted.handle as MobxPoolHandle
    const residency = pool.residency
    if (residency === null) throw new Error('the counts pool is lazy; residency is null')
    // Settle exactly as counts.test.tsx does, then zero.
    let rounds = 0
    while (residency.hasQueued() && rounds < 100) {
      act(() => {
        pool.hydrate()
      })
      rounds += 1
    }
    expect(residency.hasQueued()).toBe(false)
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
      byIssue.set(s.issueId, [...(byIssue.get(s.issueId) ?? []), s.id])
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
      throw new Error(`no cold issue with two sessions; cold issues by sessions/coldSessions: ${JSON.stringify(shape)}`)
    }
    if (planted) plant.target = target

    const hydratedBefore = residency.counters.hydrated
    let hydratedInStep = -1
    // Count loads that land before runCountScenario samples its reads: the
    // sample is taken right after the step's act, so a load inside the act
    // happens before the first `snapshot()` call.
    const snapshot = pool.snapshot.bind(pool)
    pool.snapshot = () => {
      if (hydratedInStep < 0) hydratedInStep = residency.counters.hydrated - hydratedBefore
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
    const out: ArmResult = {
      arm: name,
      target,
      charged: result.readsPerChange ?? -1,
      chargedByEntity: result.reads?.byEntity,
      after: after.rows,
      afterByEntity: after.byEntity,
      hydratedInStep,
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
    // The plant's load lands in the step only when the window closes in it:
    // the counts test's pool (A) charges the step its request and passes;
    // the same step with the load inside it (B) fails the reads fence.
    expect(a.hydratedInStep).toBe(0)
    expect(a.fence).toBe('pass')
    expect(b.hydratedInStep).toBeGreaterThan(0)
    expect(b.fence).not.toBe('pass')
  }, 600_000)

  it('clean pool, steps #1-#4: does any step trigger a load of its own?', async () => {
    for (const [name, schedule] of [
      ['never', NEVER],
      ['microtask', MICROTASK],
    ] as const) {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const plant: Plant = { target: null, runs: 0, loadedRuns: 0 }
      const mounted = mountArmForCounts(plantedArm(schedule, plant), feeds.rows.source, feeds.locals)
      try {
        const { pool } = mounted.handle as MobxPoolHandle
        const residency = pool.residency!
        while (residency.hasQueued()) act(() => pool.hydrate())
        mounted.log.reset()
        mounted.handle.stats.reset()
        mounted.reads.reset()
        const snapshot = pool.snapshot.bind(pool)
        let atSample = -1
        pool.snapshot = () => {
          if (atSample < 0) atSample = residency.counters.hydrated
          return snapshot()
        }
        const cells = []
        for (const methodology of ['#1', '#2', '#3', '#4']) {
          const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)!
          const before = residency.counters.hydrated
          atSample = -1
          const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
          cells.push({
            methodology,
            charged: result.readsPerChange,
            readsBudget,
            rowsCommitted: result.rowsCommitted,
            hydratedInStep: atSample - before,
            hydratedAfterSample: residency.counters.hydrated - atSample,
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
