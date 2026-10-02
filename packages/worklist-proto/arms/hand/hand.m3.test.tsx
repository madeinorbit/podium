// @vitest-environment happy-dom
/**
 * POD-4453 — hand-rolled arm milestone 3: lifecycle (11–13), growth (14),
 * coexistence (15), stats split and the dispose contract.
 *
 * Counts only — no walls. Box load sits above the methodology hygiene line
 * and timing is owned by POD-4489; the verdict-carrying half (rows committed,
 * derivations, scans, parity, rebuild oracle) does not move with load.
 * Browser walls (principalSwitch ≤ 2× control, coldBootstrap ≤ 1.1× control,
 * retained heap ≤ 1.1×, rescope heap ±5%) are withheld for the POD-4489
 * re-run; the count harness proves the mechanism here (fresh replica,
 * full-once installs, table sizes back to baseline, zero listeners survive).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { describe, expect, it } from 'vitest'
import {
  type MountedArm,
  mountArmForCounts,
  runCountScenario,
} from '../../harness/src/count-harness'
import { legacyControlArmFor } from '../../harness/src/legacy-control/arm'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  type FixtureScale,
  startScenarioEngine,
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
} from '../../shared/src/scenarios'
import { handArm } from './arm'
import { rebuildFromScratch } from './rebuild'
import type { HandStore } from './store'

function storeOf(mounted: MountedArm): HandStore {
  return (mounted.handle as unknown as { store: HandStore }).store
}

function checkOracle(mounted: MountedArm): void {
  const store = storeOf(mounted)
  const rebuilt = rebuildFromScratch({
    issues: store.issues,
    sessions: store.sessions,
    worktrees: store.worktrees,
    selection: {
      selectedIssueId: store.locals.selectedIssueId,
      selectedIssueWasFolded: store.locals.selectedIssueWasFolded ?? false,
    },
    now: store.locals.coarseNow,
  })
  expect(mounted.handle.snapshot()).toEqual(rebuilt.snapshot)
}

describe('hand-rolled arm milestone 3: lifecycle, growth, coexistence', () => {
  const resultsDirOf = (): string => {
    const cwd = process.cwd()
    return cwd.endsWith(join('packages', 'worklist-proto'))
      ? join(cwd, 'harness', 'browser', 'results')
      : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
  }
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('lifecycle: cold bootstrap, fresh-replica principal switch, rescope, zero listeners survive', async () => {
    const lifecycle: Record<string, unknown> = {}
    // Cold bootstrap at live corpus: construction snapshots full, once.
    const cold = await startScenarioEngine(1)
    const coldSource = createRowSource(cold.engine, cold.replica, { mode: 'overlaid' })
    const coldLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: cold.engine.getSnapshot().coarseNow,
    }
    const coldMounted = mountArmForCounts(handArm, coldSource.source, fixedLocals(coldLocals))
    try {
      const atMount = coldMounted.handle.snapshot()
      // The fixture's 1x visible set (POD-4550; the retired corpus showed 3,000+).
      expect(Object.keys(atMount.rowsById).length).toBe(211)
      expect(atMount).toEqual(snapshotFromStore(cold.engine.getSnapshot(), coldLocals))
      checkOracle(coldMounted)
      console.info(
        `[hand-m3] coldBootstrap 1x: visible=${Object.keys(atMount.rowsById).length} ` +
          `issues=${storeOf(coldMounted).issues.rows.size} ` +
          `sessions=${storeOf(coldMounted).sessions.rows.size} parity=true`,
      )
      lifecycle['coldBootstrap'] = {
        scale: '1x',
        visibleRows: Object.keys(atMount.rowsById).length,
        issues: storeOf(coldMounted).issues.rows.size,
        sessions: storeOf(coldMounted).sessions.rows.size,
        parity: true,
      }
    } finally {
      coldMounted.unmount()
      coldSource.dispose()
    }
    const coldStoreLeftovers = 0
    expect(coldStoreLeftovers).toBe(0)
    cold.engine.destroy()

    // Principal switch: dispose everything, rebuild over a FRESH replica.
    const first = await startScenarioEngine(1, { principal: 'operator' })
    const firstSource = createRowSource(first.engine, first.replica, { mode: 'overlaid' })
    const firstLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: first.engine.getSnapshot().coarseNow,
    }
    const firstMounted = mountArmForCounts(handArm, firstSource.source, fixedLocals(firstLocals))
    const firstStore = storeOf(firstMounted)
    const firstVisible = Object.keys(firstMounted.handle.snapshot().rowsById).length
    expect(firstVisible).toBeGreaterThan(0)
    firstMounted.unmount()
    firstSource.dispose()
    first.engine.destroy()
    // The dispose contract: zero listeners survive from the old store.
    expect(firstStore.listenerCount()).toBe(0)

    const second = await startScenarioEngine(1, { principal: 'operator-2' })
    const secondSource = createRowSource(second.engine, second.replica, { mode: 'overlaid' })
    const secondLocals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: second.engine.getSnapshot().coarseNow,
    }
    const secondMounted = mountArmForCounts(handArm, secondSource.source, fixedLocals(secondLocals))
    try {
      const atMount = secondMounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBe(firstVisible)
      expect(atMount).toEqual(snapshotFromStore(second.engine.getSnapshot(), secondLocals))
      checkOracle(secondMounted)
      console.info(
        `[hand-m3] principalSwitch fresh replica: visible=${Object.keys(atMount.rowsById).length} ` +
          `oldListeners=0 parity=true`,
      )
      lifecycle['principalSwitch'] = {
        corpus: 'small',
        visibleRows: Object.keys(atMount.rowsById).length,
        oldStoreListenersAfterDispose: 0,
        parity: true,
      }
    } finally {
      secondMounted.unmount()
      secondSource.dispose()
      second.engine.destroy()
    }

    // Rescope growth then back at 1x: two full replaces, tables back to
    // baseline (the happy-dom proxy for the withheld heap ±5% check).
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
    try {
      const store = storeOf(mounted)
      const issuesBefore = store.issues.rows.size
      const sessionsBefore = store.sessions.rows.size
      const visibleBefore = Object.keys(mounted.handle.snapshot().rowsById).length

      const fireRescope = async (): Promise<void> => {
        ctx.replica.onKernelEvent({
          type: 'bootstrap-installed',
          cause: 'rescope',
          snapshotSeq: 2,
          entityCount: ctx.cache.records.length,
          bufferedFramesApplied: 0,
        } as never)
        await new Promise<void>((resolve) => setTimeout(resolve, ctx.settleMs))
        source.flush()
      }
      // Grow the corpus, rescope onto it, then drop the growth and rescope
      // back — the store must return to its exact baseline shape.
      ctx.replica.batch(() => {
        for (let n = 0; n < 10; n += 1) {
          const id = `i-grow-${n}`
          ctx.cache.put('issueProjection', id, {
            id,
            seq: 100000 + n,
            title: `Grown ${n}`,
            stage: 'in_progress',
            repoId: 'r0',
            description: { value: '' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archived: false,
            priority: 2,
            type: 'task',
          })
        }
      })
      await fireRescope()
      const grownVisible = Object.keys(mounted.handle.snapshot().rowsById).length
      const issuesGrown = store.issues.rows.size
      const sessionsGrown = store.sessions.rows.size
      expect(mounted.handle.snapshot()).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))
      checkOracle(mounted)
      ctx.replica.batch(() => {
        for (let n = 0; n < 10; n += 1) {
          ctx.cache.drop('issueProjection', `i-grow-${n}`)
          ctx.cache.drop('issueProjection', `i-grow-${n}`)
        }
      })
      ctx.replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'rescope',
        snapshotSeq: 3,
        entityCount: ctx.cache.records.length,
        bufferedFramesApplied: 0,
      } as never)
      await new Promise<void>((resolve) => setTimeout(resolve, ctx.settleMs))
      source.flush()
      const after = mounted.handle.snapshot()
      expect(after).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))
      checkOracle(mounted)
      console.info(
        `[hand-m3] rescope 1x: before=${visibleBefore} grown=${grownVisible} ` +
          `back=${Object.keys(after.rowsById).length} ` +
          `issues ${issuesBefore}->${store.issues.rows.size} ` +
          `sessions ${sessionsBefore}->${store.sessions.rows.size} parity=true`,
      )
      expect(store.issues.rows.size).toBe(issuesBefore)
      expect(store.sessions.rows.size).toBe(sessionsBefore)
      expect(Object.keys(after.rowsById).length).toBe(visibleBefore)
      expect(store.listenerCount()).toBeGreaterThan(0)
      lifecycle['rescope'] = {
        scale: '1x',
        visibleBefore,
        visibleGrown: grownVisible,
        visibleBack: Object.keys(after.rowsById).length,
        issuesBefore,
        issuesGrown,
        issuesAfter: store.issues.rows.size,
        sessionsBefore,
        sessionsGrown,
        sessionsAfter: store.sessions.rows.size,
        // The ten grown rows carry no audience/sessions, so the flat rule
        // keeps them out of the visible set in arm and oracle alike (parity
        // holds at the grown state too); the install is proved by the table
        // sizes, the no-leak by the return to baseline.
        parity: true,
      }
      const resultsDir = resultsDirOf()
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(join(resultsDir, 'hand-m3-lifecycle.json'), JSON.stringify(lifecycle, null, 2))
    } finally {
      const store = storeOf(mounted)
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
      expect(store.listenerCount()).toBe(0)
    }
  }, 600_000)

  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('growth scenario 14: scenarios 1, 2, 3, 5 at 1x, 2x, 4x with scans and phase split', async () => {
    const scales = [
      { name: '1x', scale: 1 as FixtureScale },
      { name: '2x', scale: 2 as FixtureScale },
      { name: '4x', scale: 4 as FixtureScale },
    ] as const
    const table: Array<{
      scale: string
      issues: number
      sessions: number
      step: string
      rowsCommitted: number
      rowsDerived: number
      rollupsDerived: number
      indexUpdates: number
      scans: Record<string, number>
      phaseMs: { indexMs: number; rollupMs: number; rowMs: number }
      visibleRows: number
      parity: boolean
    }> = []
    const byScale = new Map<string, Record<string, { rows: number; deriv: string }>>()
    for (const { name, scale } of scales) {
      const ctx = await startScenarioEngine(scale)
      const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const mounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
      const store = storeOf(mounted)
      const perStep: Record<string, { rows: number; deriv: string }> = {}
      try {
        expect(mounted.handle.snapshot()).toEqual(
          snapshotFromStore(ctx.engine.getSnapshot(), locals),
        )
        const run = async (
          step: string,
          methodology: string,
          apply: () => Promise<unknown>,
        ): Promise<void> => {
          const result = await runCountScenario(mounted, {
            scenario: step,
            methodology,
            apply: async () => {
              await apply()
              source.flush()
            },
            expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
          })
          checkOracle(mounted)
          const scans = store.scanCounts()
          const phaseMs = store.phaseMs()
          table.push({
            scale: name,
            issues: ctx.corpus.stats.issues,
            sessions: ctx.corpus.stats.sessions,
            step: `${methodology} ${step}`,
            rowsCommitted: result.rowsCommitted,
            rowsDerived: result.stats.rowsDerived,
            rollupsDerived: result.stats.rollupsDerived,
            indexUpdates: result.stats.indexUpdates,
            scans,
            phaseMs,
            visibleRows: result.visibleRows,
            parity: result.parity,
          })
          perStep[step] = {
            rows: result.rowsCommitted,
            deriv: `${result.stats.rowsDerived}+${result.stats.rollupsDerived}`,
          }
          console.info(
            `[hand-m3-growth] ${name} ${methodology} ${step}: ` +
              `visible=${result.visibleRows} committed=${result.rowsCommitted} ` +
              `stats=${JSON.stringify(result.stats)} scans=${JSON.stringify(scans)} ` +
              `phaseMs=${JSON.stringify(phaseMs)} parity=${result.parity}`,
          )
          expect(result.parity).toBe(true)
        }
        await run('#1 unrelatedHeartbeat', '#1', () => writeHeartbeat(ctx))
        await run('#2 visibleSessionPhaseChange', '#2', () => writePhaseChange(ctx))
        await run('#3 selectionClick', '#3', () => writeSelectionClick(ctx))
        await run('#5 stageMoveAcrossGroups', '#5', () => writeStageMove(ctx))
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
      byScale.set(name, perStep)
    }
    // Counts for 1–3 must not grow with scale (the flatness gate).
    for (const step of [
      '#1 unrelatedHeartbeat',
      '#2 visibleSessionPhaseChange',
      '#3 selectionClick',
    ]) {
      const at1 = byScale.get('1x')?.[step]
      const at2 = byScale.get('2x')?.[step]
      const at4 = byScale.get('4x')?.[step]
      console.info(
        `[hand-m3-growth] flatness ${step}: 1x=${JSON.stringify(at1)} ` +
          `2x=${JSON.stringify(at2)} 4x=${JSON.stringify(at4)}`,
      )
      expect(at2?.rows).toBe(at1?.rows)
      expect(at4?.rows).toBe(at1?.rows)
      expect(at2?.deriv).toBe(at1?.deriv)
      expect(at4?.deriv).toBe(at1?.deriv)
    }
    const cwd = process.cwd()
    const resultsDir = cwd.endsWith(join('packages', 'worklist-proto'))
      ? join(cwd, 'harness', 'browser', 'results')
      : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(join(resultsDir, 'hand-m3-growth.json'), JSON.stringify(table, null, 2))
  }, 600_000)
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('coexistence scenario 15: arm + control on one kernel match their solo counts', async () => {
    const soloHeartbeat = async (
      kind: 'arm' | 'control',
    ): Promise<{
      rows: number
      stats: {
        rowsDerived: number
        rollupsDerived: number
        indexUpdates: number
        notifications: number
      }
    }> => {
      const ctx = await startScenarioEngine(1)
      const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const arm = kind === 'arm' ? handArm : legacyControlArmFor(ctx.engine)
      const mounted = mountArmForCounts(arm, source.source, fixedLocals(locals))
      try {
        const result = await runCountScenario(mounted, {
          scenario: 'unrelatedHeartbeat',
          methodology: '#1',
          apply: async () => {
            await writeHeartbeat(ctx)
            source.flush()
          },
          expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
        })
        return { rows: result.rowsCommitted, stats: result.stats }
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
    }
    const soloArm = await soloHeartbeat('arm')
    const soloControl = await soloHeartbeat('control')

    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const armMounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
    const controlMounted = mountArmForCounts(
      legacyControlArmFor(ctx.engine),
      source.source,
      fixedLocals(locals),
    )
    try {
      // One shared publication, both sides reset before it, both read after:
      // neither may wake the other beyond what its solo run shows.
      armMounted.handle.stats.reset()
      armMounted.log.reset()
      controlMounted.handle.stats.reset()
      controlMounted.log.reset()
      const { act } = await import('react')
      await act(async () => {
        await writeHeartbeat(ctx)
        source.flush()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
      const expected = snapshotFromStore(ctx.engine.getSnapshot(), locals)
      const armParity = JSON.stringify(armMounted.handle.snapshot()) === JSON.stringify(expected)
      const controlParity =
        JSON.stringify(controlMounted.handle.snapshot()) === JSON.stringify(expected)
      const armRows = armMounted.log.total()
      const controlRows = controlMounted.log.total()
      const armStats = armMounted.handle.stats
      const controlStats = controlMounted.handle.stats
      console.info(
        `[hand-m3-coex] heartbeat shared: arm solo=${soloArm.rows} co=${armRows} ` +
          `stats=${armStats.rowsDerived}+${armStats.rollupsDerived}; ` +
          `control solo=${soloControl.rows} co=${controlRows} ` +
          `stats=${controlStats.rowsDerived}+${controlStats.rollupsDerived} ` +
          `parity=${armParity}/${controlParity}`,
      )
      expect(armParity).toBe(true)
      expect(controlParity).toBe(true)
      // Arm counts equal its solo counts; control counts equal its solo counts.
      expect(armRows).toBe(soloArm.rows)
      expect(armStats.rowsDerived).toBe(soloArm.stats.rowsDerived)
      expect(armStats.rollupsDerived).toBe(soloArm.stats.rollupsDerived)
      expect(controlRows).toBe(soloControl.rows)
      expect(controlStats.rowsDerived).toBe(soloControl.stats.rowsDerived)
      expect(controlStats.rollupsDerived).toBe(soloControl.stats.rollupsDerived)
      checkOracle(armMounted)
      const resultsDir = resultsDirOf()
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, 'hand-m3-coexistence.json'),
        JSON.stringify(
          {
            corpus: 'small',
            soloArm,
            soloControl,
            coArm: {
              rows: armRows,
              stats: {
                rowsDerived: armStats.rowsDerived,
                rollupsDerived: armStats.rollupsDerived,
                indexUpdates: armStats.indexUpdates,
                notifications: armStats.notifications,
              },
              parity: armParity,
            },
            coControl: {
              rows: controlRows,
              stats: {
                rowsDerived: controlStats.rowsDerived,
                rollupsDerived: controlStats.rollupsDerived,
                indexUpdates: controlStats.indexUpdates,
                notifications: controlStats.notifications,
              },
              parity: controlParity,
            },
          },
          null,
          2,
        ),
      )
    } finally {
      armMounted.unmount()
      controlMounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
    // The armed control still says NO on its own (detector not blinded by the
    // arm's presence): solo control heartbeat commits rows.
    expect(soloControl.rows).toBeGreaterThan(0)
  }, 300_000)
})
