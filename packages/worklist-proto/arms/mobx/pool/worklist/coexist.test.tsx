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
 * counts equal their solo counts and both parities hold (the arm's through
 * its one named POD-4671 allowance, the control's exactly). The control's
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
import { createRowSource } from '../../../../shared/src/row-source'
import type { SliceLocals } from '../../../../shared/src/slice-types'
import { fixedLocals } from '../../../../shared/src/locals-source'
import {
  startScenarioEngine,
  writeHeartbeat,
  writeSelectionClick,
} from '../../../../shared/src/scenarios'
import { mobxPoolArm } from '../arm'
import { MOBX_POOL_ALLOWANCES } from './known-gaps'

interface SoloCounts {
  rows: number
  stats: CountStats
}

async function soloArm(
  scenario: 'heartbeat' | 'click',
): Promise<SoloCounts & { allowance: string | null }> {
  const methodology = scenario === 'heartbeat' ? '#1' : '#3'
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(mobxPoolArm, feeds.rows.source, feeds.locals)
  try {
    const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
    if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
    const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
    assertReads(result, { readsPerChange: readsBudget })
    let allowance: string | null = null
    if (!result.parity) {
      const actual = mounted.handle.snapshot()
      const oracle = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
      const patched = MOBX_POOL_ALLOWANCES.parity!.accept(
        ctx.corpus,
        mounted.handle,
        oracle,
        actual,
      )
      expect(
        diffSnapshots(actual, patched.snapshot),
        `solo arm ${scenario}: beyond POD-4671's parity allowance`,
      ).toBeNull()
      allowance = patched.applied
    } else {
      expect(result.parity, `solo arm ${scenario}: parity`).toBe(true)
    }
    return {
      rows: result.rowsCommitted,
      stats: result.stats,
      allowance,
    }
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

async function soloControl(scenario: 'heartbeat' | 'click'): Promise<SoloCounts> {
  const ctx = await startScenarioEngine(1)
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
    return { rows: result.rowsCommitted, stats: result.stats }
  } finally {
    mounted.unmount()
    source.dispose()
    ctx.engine.destroy()
  }
}

describe('coexistence: arm and control on one runtime (POD-4576)', () => {
  it('heartbeat and click count the same solo and co-mounted, on both sides', async () => {
    const soloArmHeartbeat = await soloArm('heartbeat')
    const soloControlHeartbeat = await soloControl('heartbeat')
    const soloArmClick = await soloArm('click')
    const soloControlClick = await soloControl('click')
    // The detector is armed: the solo control redraws the world on a heartbeat.
    expect(soloControlHeartbeat.rows, 'control heartbeat over-commits solo').toBeGreaterThan(0)

    const co: Record<string, unknown> = {
      soloArmHeartbeat,
      soloControlHeartbeat,
      soloArmClick,
      soloControlClick,
    }
    const coRun = async (scenario: 'heartbeat' | 'click'): Promise<void> => {
      const ctx = await startScenarioEngine(1)
          const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const fixed = fixedLocals(locals)
      const armMounted = mountArmForCounts(mobxPoolArm, source.source, fixed)
      const controlMounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, fixed)
      try {
        armMounted.handle.stats.reset()
        armMounted.log.reset()
        controlMounted.handle.stats.reset()
        controlMounted.log.reset()
        await act(async () => {
          if (scenario === 'heartbeat') await writeHeartbeat(ctx)
          else await writeSelectionClick(ctx)
          source.flush()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        })
        // The pool settles its lazy loads inside the step; none may land late.
        const pool = armMounted.handle as { settleLoads?: () => void; pendingLoads?: () => number }
        await act(async () => {
          pool.settleLoads?.()
        })
        expect(pool.pendingLoads?.() ?? 0, `${scenario}: no pending loads`).toBe(0)
        const oracle = snapshotFromStore(ctx.engine.getSnapshot(), locals)
        const armActual = armMounted.handle.snapshot()
        const patched = MOBX_POOL_ALLOWANCES.parity!.accept(
          ctx.corpus,
          armMounted.handle,
          oracle,
          armActual,
        )
          expect(
          diffSnapshots(armActual, patched.snapshot),
          `${scenario}: arm parity beside the control`,
        ).toBeNull()
        expect(
          diffSnapshots(controlMounted.handle.snapshot(), oracle),
          `${scenario}: control parity beside the arm`,
        ).toBeNull()
        const armRows = armMounted.log.total()
        const controlRows = controlMounted.log.total()
        const soloArmCounts = scenario === 'heartbeat' ? soloArmHeartbeat : soloArmClick
        const soloControlCounts = scenario === 'heartbeat' ? soloControlHeartbeat : soloControlClick
        expect(armRows, `${scenario}: arm rows co == solo`).toBe(soloArmCounts.rows)
        expect(
          armMounted.handle.stats.rowsDerived,
          `${scenario}: arm rowsDerived co == solo`,
        ).toBe(soloArmCounts.stats.rowsDerived)
        expect(
          armMounted.handle.stats.rollupsDerived,
          `${scenario}: arm rollupsDerived co == solo`,
        ).toBe(soloArmCounts.stats.rollupsDerived)
        expect(controlRows, `${scenario}: control rows co == solo`).toBe(soloControlCounts.rows)
        expect(
          controlMounted.handle.stats.rowsDerived,
          `${scenario}: control rowsDerived co == solo`,
        ).toBe(soloControlCounts.stats.rowsDerived)
        expect(
          controlMounted.handle.stats.rollupsDerived,
          `${scenario}: control rollupsDerived co == solo`,
        ).toBe(soloControlCounts.stats.rollupsDerived)
        co[scenario] = {
          armRows,
          armStats: {
            rowsDerived: armMounted.handle.stats.rowsDerived,
            rollupsDerived: armMounted.handle.stats.rollupsDerived,
            indexUpdates: armMounted.handle.stats.indexUpdates,
            notifications: armMounted.handle.stats.notifications,
          },
          controlRows,
          controlStats: {
            rowsDerived: controlMounted.handle.stats.rowsDerived,
            rollupsDerived: controlMounted.handle.stats.rollupsDerived,
            indexUpdates: controlMounted.handle.stats.indexUpdates,
            notifications: controlMounted.handle.stats.notifications,
          },
        }
      } finally {
        armMounted.unmount()
        controlMounted.unmount()
        fixed.dispose()
        source.dispose()
        ctx.engine.destroy()
      }
    }
    await coRun('heartbeat')
    await coRun('click')
    writeResult('mobx-coexist-mc4', { issue: 'POD-4576', corpus: '1x', ...co })
  }, 300_000)
})
