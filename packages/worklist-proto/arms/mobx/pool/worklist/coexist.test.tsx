// @vitest-environment happy-dom
/**
 * POD-4576 (Mc4) — the MobX pool runs beside the legacy control on one
 * kernel: heartbeat (#1) and click (#3), solo counts against co-mounted
 * counts on both sides.
 *
 * Each side's solo run (arm alone, control alone) records rows committed,
 * rows derived and roll-ups derived. The co-run mounts both on one engine's
 * feed, resets both, applies one shared write, and reads both afterwards:
 * neither may wake the other beyond what its solo run shows, so both sides'
 * counts equal their solo counts and both parities hold exactly (POD-4671
 * seated the unscanned orphan, so no allowance remains). The control's
 * solo heartbeat commits the whole list — the detector proving it can say NO
 * is armed by the run itself (`soloControlHeartbeat.rows > 0`).
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  assertReads,
  mountArmForCounts,
  runCountScenario,
  type CountStats,
} from '../../../../harness/src/count-harness'
import { openFenceFeeds, parityLocals, runFenceStep } from '../../../../harness/src/fence-scenarios'
import { FENCE_SCENARIOS } from '../../../../harness/src/fence-scenarios'
import { legacyControlArmFor } from '../../../../harness/src/legacy-control/arm'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import {
  startScenarioEngine,
  type FixtureScale,
  writeHeartbeat,
  writeSelectionClick,
} from '../../../../shared/src/scenarios'
import { harnessMobxPoolArm } from '../../../../harness/src/adapters/mobx-pool'

interface SoloCounts {
  rows: number
  stats: CountStats
  reads: number
}

async function soloArm(scenario: 'heartbeat' | 'click', scale: FixtureScale): Promise<SoloCounts> {
  const methodology = scenario === 'heartbeat' ? '#1' : '#3'
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(harnessMobxPoolArm, feeds.rows.source, feeds.locals)
  try {
    const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
    if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
    const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
    console.info(`[sidebar-reads] ${scenario} ${scale}x solo: ${JSON.stringify(result.reads)}`)
    assertReads(result, { readsPerChange: readsBudget })
    expect(result.parity, `solo arm ${scenario}: parity (${result.parityDiff ?? ''})`).toBe(true)
    return {
      rows: result.rowsCommitted,
      stats: result.stats,
      reads: result.readsPerChange!,
    }
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

async function soloControl(scenario: 'heartbeat' | 'click', scale: FixtureScale): Promise<SoloCounts> {
  const ctx = await startScenarioEngine(scale)
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: ctx.engine.getSnapshot().coarseNow,
  }
  const mounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, fixedLocals(locals))
  try {
    const result = await runCountScenario(mounted, {
      scenario: scenario === 'heartbeat' ? 'unrelatedHeartbeat' : 'selectionClick',
      methodology: scenario === 'heartbeat' ? '#1' : '#3',
      apply: async () => {
        if (scenario === 'heartbeat') await writeHeartbeat(ctx)
        else await writeSelectionClick(ctx)
        source.flush()
      },
      expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
    })
    expect(result.parity, `solo control ${scenario}: parity`).toBe(true)
    expect(result.readsPerChange).not.toBeNull()
    return { rows: result.rowsCommitted, stats: result.stats, reads: result.readsPerChange! }
  } finally {
    mounted.unmount()
    source.dispose()
    ctx.engine.destroy()
  }
}

describe('coexistence: arm and control on one runtime (POD-4576)', () => {
  it.each([1, 4] as const)('heartbeat and click count the same solo and co-mounted, on both sides (%ix corpus)', async (scale) => {
    const soloArmHeartbeat = await soloArm('heartbeat', scale)
    const soloControlHeartbeat = await soloControl('heartbeat', scale)
    const soloArmClick = await soloArm('click', scale)
    const soloControlClick = await soloControl('click', scale)
    // The detector is armed: the solo control redraws the world on a heartbeat.
    expect(soloControlHeartbeat.rows, 'control heartbeat over-commits solo').toBeGreaterThan(0)

    const co: Record<string, unknown> = {
      soloArmHeartbeat,
      soloControlHeartbeat,
      soloArmClick,
      soloControlClick,
    }
    const coRun = async (scenario: 'heartbeat' | 'click'): Promise<void> => {
      const ctx = await startScenarioEngine(scale)
      // Engine-backed locals (POD-4608): the click's selection reaches both
      // arms through the same channel the solo runs use.
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const armMounted = mountArmForCounts(harnessMobxPoolArm, feeds.rows.source, feeds.locals)
      const controlMounted = mountArmForCounts(
        legacyControlArmFor(ctx.engine),
        feeds.rows.source,
        feeds.locals,
      )
      try {
        // Settle the mount's lazy loads BEFORE the step (what runFenceStep
        // does): landing them inside the step would commit rows the change
        // never touched.
        const pool = armMounted.handle as { settleLoads?: () => void; pendingLoads?: () => number }
        await act(async () => {
          pool.settleLoads?.()
        })
        expect(pool.pendingLoads?.() ?? 0, `${scenario}: mount loads settled`).toBe(0)
        armMounted.log.reset()
        controlMounted.log.reset()
        armMounted.reads.reset()
        controlMounted.reads.reset()
        await act(async () => {
          if (scenario === 'heartbeat') await writeHeartbeat(ctx)
          else await writeSelectionClick(ctx)
          feeds.flush()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        })
        // The pool settles its lazy loads inside the step; none may land late.
        await act(async () => {
          pool.settleLoads?.()
        })
        expect(pool.pendingLoads?.() ?? 0, `${scenario}: no pending loads`).toBe(0)
        const armRows = armMounted.log.total()
        const controlRows = controlMounted.log.total()
        // Take the fence cells before either whole-output parity projection.
        const armReads = armMounted.reads.stats()
        const controlReads = controlMounted.reads.stats()
        console.info(`[sidebar-reads] ${scenario} ${scale}x co-mounted: ${JSON.stringify(armReads)}`)
        const oracle = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
        expect(
          diffSnapshots(armMounted.handle.snapshot(), oracle),
          `${scenario}: arm parity beside the control`,
        ).toBeNull()
        expect(
          diffSnapshots(controlMounted.handle.snapshot(), oracle),
          `${scenario}: control parity beside the arm`,
        ).toBeNull()
        const soloArmCounts = scenario === 'heartbeat' ? soloArmHeartbeat : soloArmClick
        const soloControlCounts = scenario === 'heartbeat' ? soloControlHeartbeat : soloControlClick
        expect(armRows, `${scenario}: arm rows co == solo`).toBe(soloArmCounts.rows)
        expect(controlRows, `${scenario}: control rows co == solo`).toBe(soloControlCounts.rows)
        expect(armReads.rows, `${scenario}: arm reads co == solo`).toBe(soloArmCounts.reads)
        expect(controlReads.rows, `${scenario}: control reads co == solo`).toBe(soloControlCounts.reads)
        co[scenario] = {
          armRows,
          controlRows,
          armReads,
          controlReads,
        }
      } finally {
        armMounted.unmount()
        controlMounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
    await coRun('heartbeat')
    await coRun('click')
    writeResult(`mobx-coexist-mc4-${scale}x`, { issue: 'POD-4576', corpus: `${scale}x`, ...co })
  }, 300_000)
})
