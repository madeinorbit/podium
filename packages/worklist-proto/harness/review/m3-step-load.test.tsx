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
 * #2 session change re-runs) also reads a cold issue's sessions through the
 * lazy relation (`lazyMany`), as a roll-up does, and, for each session that
 * is loaded, follows `session.issue` (`relations.one`). Before the load that
 * charges the S cold session keys; once they load it also charges the issue
 * key. The target issue is chosen with S = 2, so the charge before the load
 * is 1 + 2 = 3 (the #2 budget) and after it is 4.
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

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { mobxPoolArm, type MobxPoolHandle } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
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
  /** Plant runs with a target, and how many of them saw the sessions loaded. */
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
          const { ready } = pool.lazyMany('issue', target, 'sessions')
          plant.runs += 1
          if (ready.length > 0) plant.loadedRuns += 1
          for (const s of ready) pool.inputs.relations.one('session', s, 'issue')
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
  plantRuns: number
  plantLoadedRuns: number
  fence: 'pass' | string
}

async function runArm(name: string, schedule: Schedule): Promise<ArmResult> {
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

    // A closed issue with exactly two sessions, all still cold after the settle.
    const byIssue = new Map<string, string[]>()
    for (const s of ctx.corpus.sessions) {
      if (s.issueId == null) continue
      byIssue.set(s.issueId, [...(byIssue.get(s.issueId) ?? []), s.id])
    }
    let target: string | null = null
    for (const [issueId, sessions] of byIssue) {
      if (sessions.length !== 2) continue
      if (!residency.known('issue', issueId)) continue
      if (!sessions.every((s) => residency.known('session', s))) continue
      target = issueId
      break
    }
    if (target === null) throw new Error('no cold issue with two cold sessions in the corpus')
    plant.target = target

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
      plantRuns: plant.runs,
      plantLoadedRuns: plant.loadedRuns,
      fence,
    }
    console.info(`[m3-step-load] ${JSON.stringify(out)}`)
    return out
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('a fence step counts the load its own change triggers (M3 re-review 2)', () => {
  it('A (counts.test.tsx pool, window never closes) vs B (window closes in the step)', async () => {
    const a = await runArm('A never', NEVER)
    const b = await runArm('B microtask', MICROTASK)
    expect(a.target).toBe(b.target)
    // Recorded, not asserted: the review doc reads the printed lines.
    expect(a.charged).toBeGreaterThan(0)
    expect(b.charged).toBeGreaterThan(0)
  }, 300_000)
})
