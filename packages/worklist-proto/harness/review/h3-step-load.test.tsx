// @vitest-environment happy-dom
/**
 * POD-4598 (H3) — M3's step-load plant (`m3-step-load.test.tsx`, re-review 2
 * G2 and final review §7.2), against the hand pool through the shared fence
 * (`runFenceStep`).
 *
 * THE PLANT. From step #2 on, every read of a session row by a cell (the
 * pool's `inputs.session`, which the #2 session's activity cell calls when
 * that session changes) also asks where a cold issue P stands
 * (`pool.resident`, as a view does before it reads a row) and, once P is
 * loaded, lists P's sessions. Asking queues P's load: a change whose own work
 * triggers a load. The fence must land that load INSIDE step #2 and charge
 * it, so #2 must fail its reads fence; a load that landed after the reads
 * were sampled would be charged to no step (M3's G2).
 *
 * FOUR ARMS, same corpus and steps (#1 then #2):
 * - D: the counts test's window (never closes on its own), no plant;
 * - A: the same window, planted;
 * - C: a window that closes on the next microtask, no plant;
 * - B: the microtask window, planted.
 * Loads are counted by the reviewer (a wrapper on the residency's per-row
 * install), not by the pool's counters, which a stats reset zeroes.
 *
 * Also: the clean pool's #1-#4 under both windows (charged reads, commits,
 * rows loaded in and after each step), and a wrapped flush (M3's N9), which
 * the fence must refuse.
 */

import { appendFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { harnessHandPoolArm, type HarnessHandPoolHandle } from '../src/adapters/hand-pool'
import type { Schedule } from '../../arms/hand/pool/residency'
import type { CheckableArm } from '../../shared/src/arm'
import type { SliceSession } from '@podium/client-graph/shared/slice-types'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertReads, mountArmForCounts } from '../src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../src/fence-scenarios'

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

function report(line: string): void {
  const out = process.env['H3_PROBE_OUT']
  if (out === undefined) console.info(line)
  else appendFileSync(out, `${line}\n`)
}

interface Plant {
  target: string | null
  runs: number
  loadedRuns: number
}

/** Rows the residency actually installed on access, counted outside the pool. */
interface LoadCount {
  rows: number
}

function plantedArm(schedule: Schedule, plant: Plant, loads: LoadCount): CheckableArm {
  return {
    create(source, locals, reads) {
      const handle = harnessHandPoolArm.create(source, locals, reads, { schedule })
      const pool = handle.pool
      const residency = pool.residency
      if (residency === null) throw new Error('the hand arm is lazy; residency is null')
      const install = residency.hydrate.bind(residency)
      residency.hydrate = (target, entity, id, out) => {
        const wasCold = residency.isCold(entity, id)
        install(target, entity, id, out)
        if (wasCold && !residency.isCold(entity, id)) loads.rows += 1
      }
      const inputs = pool.inputs as { session: (id: string) => SliceSession | undefined }
      const original = inputs.session
      inputs.session = (id) => {
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
  loadedInStep: number
  loadedAfterSample: number
  rowsCommitted: number
  plantRuns: number
  plantLoadedRuns: number
  fence: string
}

async function runArm(name: string, schedule: Schedule, planted: boolean): Promise<ArmResult> {
  const plant: Plant = { target: null, runs: 0, loadedRuns: 0 }
  const loads: LoadCount = { rows: 0 }
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(
    plantedArm(schedule, plant, loads),
    feeds.rows.source,
    feeds.locals,
  )
  try {
    const { pool } = mounted.handle as HarnessHandPoolHandle
    const residency = pool.residency!
    const step = async (methodology: string) => {
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
      if (entry === undefined) throw new Error(`no ${methodology}`)
      return runFenceStep(mounted, ctx, feeds.flush, entry)
    }
    await step('#1')

    // A cold issue with sessions, still cold after #1 (two sessions, as M3's, when there is one).
    const byIssue = new Map<string, string[]>()
    for (const s of ctx.corpus.sessions) {
      if (s.issueId == null) continue
      byIssue.set(s.issueId, [...(byIssue.get(s.issueId) ?? []), s.sessionId])
    }
    const cold = [...byIssue].filter(([issueId]) => residency.isCold('issue', issueId))
    const pick = cold.find(([, sessions]) => sessions.length === 2) ?? cold[0]
    if (pick === undefined) throw new Error('no cold issue with a session')
    const target = pick[0]
    if (planted) plant.target = target

    // The sample point moved with POD-4933: the harness handle's
    // snapshot() settles through the adapter's snapshotPool, not a pool
    // method, so the load count at sample time is read off the handle.
    const snapshot = mounted.handle.snapshot.bind(mounted.handle)
    let atSample = -1
    mounted.handle.snapshot = () => {
      if (atSample < 0) atSample = loads.rows
      return snapshot()
    }
    const before = loads.rows
    const { result, readsBudget } = await step('#2')
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
      loadedInStep: atSample - before,
      loadedAfterSample: loads.rows - atSample,
      rowsCommitted: result.rowsCommitted,
      plantRuns: plant.runs,
      plantLoadedRuns: plant.loadedRuns,
      fence,
    }
    report(`[h3-step-load] ${JSON.stringify(out)}`)
    return out
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('a fence step counts the load its own change triggers (hand pool, M3 G2 plant)', () => {
  it('A/B on the load window, each with a no-plant control', async () => {
    const d = await runArm('D never, no plant', NEVER, false)
    const a = await runArm('A never, planted', NEVER, true)
    const c = await runArm('C microtask, no plant', MICROTASK, false)
    const b = await runArm('B microtask, planted', MICROTASK, true)
    expect(new Set([a.target, b.target, c.target, d.target]).size).toBe(1)
    expect(d.fence).toBe('pass')
    expect(c.charged).toBe(d.charged)
    expect(c.loadedInStep).toBe(0)
    // The plant ran, and the load it queued landed inside #2 and was charged there.
    expect(a.plantRuns).toBeGreaterThan(0)
    expect(a.loadedInStep).toBeGreaterThan(0)
    expect(a.loadedAfterSample).toBe(0)
    expect(a.fence).not.toBe('pass')
    expect(a.charged).toBe(b.charged)
    expect(b.loadedInStep).toBeGreaterThan(0)
    expect(b.fence).not.toBe('pass')
  }, 600_000)

  it('clean pool, steps #1-#4: charged reads, commits, and loads in and after each step', async () => {
    for (const [name, schedule] of [
      ['never', NEVER],
      ['microtask', MICROTASK],
    ] as const) {
      const plant: Plant = { target: null, runs: 0, loadedRuns: 0 }
      const loads: LoadCount = { rows: 0 }
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const mounted = mountArmForCounts(
        plantedArm(schedule, plant, loads),
        feeds.rows.source,
        feeds.locals,
      )
      try {
        // As above: sample loads through the harness handle's snapshot().
        const snapshot = mounted.handle.snapshot.bind(mounted.handle)
        let atSample = -1
        mounted.handle.snapshot = () => {
          if (atSample < 0) atSample = loads.rows
          return snapshot()
        }
        const cells = []
        for (const methodology of ['#1', '#2', '#3', '#4']) {
          const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)!
          atSample = -1
          const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
          cells.push({
            methodology,
            charged: result.readsPerChange,
            byEntity: result.reads?.byEntity,
            readsBudget,
            rowsCommitted: result.rowsCommitted,
            loadedAfterSample: loads.rows - atSample,
          })
          expect(loads.rows - atSample, `${methodology}: rows loaded after the sample`).toBe(0)
          assertReads(result, { readsPerChange: readsBudget })
        }
        report(`[h3-step-load clean] ${name} ${JSON.stringify(cells)}`)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
  }, 600_000)

  it('a wrapped flush is refused (M3 N9)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(
      plantedArm(NEVER, { target: null, runs: 0, loadedRuns: 0 }, { rows: 0 }),
      feeds.rows.source,
      feeds.locals,
    )
    try {
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#1')!
      await expect(runFenceStep(mounted, ctx, () => feeds.flush(), entry)).rejects.toThrow(
        /not an openFenceFeeds flush/,
      )
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
