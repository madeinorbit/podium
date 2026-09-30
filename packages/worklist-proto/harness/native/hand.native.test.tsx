// @vitest-environment happy-dom
/**
 * POD-4446 — hand-rolled arm on the native renderer: mountNative() through
 * mountNativeForCounts, scenarios #1–#3 with parity and the rebuild oracle.
 * Same RowShell profilers, same runCountScenario as the web lane.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { mountNativeForCounts, runCountScenario } from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
} from '../../shared/src/scenarios'
import { handArm, preloadHandNative } from '../../arms/hand/arm'
import { rebuildFromScratch } from '../../arms/hand/rebuild'
import type { HandStore } from '../../arms/hand/store'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

describe('hand-rolled arm on the native renderer', () => {
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm. Marked by POD-4608: the POD-4551 sweep never reached the native lane.
  it.fails('runs count scenarios #1-#3 with parity; #1 commits zero', async () => {
    await preloadHandNative()
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const handle = handArm.create(source.source, fixedLocals(locals).source)
    const store = (handle as unknown as { store: HandStore }).store
    const mounted = await mountNativeForCounts(handle)
    const checkOracle = (): void => {
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
      expect(handle.snapshot()).toEqual(rebuilt.snapshot)
    }
    try {
      const list = document.querySelector('[data-testid="hand-list"]')
      console.info(
        `[hand-native] mounted rows: ${list?.querySelectorAll('[data-testid^="row-"]').length ?? 'NO-LIST'}`,
      )
      expect(list).not.toBeNull()

      const heartbeat = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(heartbeat.visibleRows).toBeGreaterThan(0)
      expect(heartbeat.parity).toBe(true)
      console.info(
        `[hand-native] heartbeat committed ${heartbeat.rowsCommitted}/${heartbeat.visibleRows}; ` +
          `stats=${JSON.stringify(heartbeat.stats)}`,
      )
      expect(heartbeat.rowsCommitted).toBe(0)
      checkOracle()

      const phase = await runCountScenario(mounted, {
        scenario: 'visibleSessionPhaseChange',
        methodology: '#2',
        apply: async () => {
          await writePhaseChange(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(phase.parity).toBe(true)
      console.info(
        `[hand-native] phase committed ${phase.rowsCommitted}/${phase.visibleRows}; ` +
          `stats=${JSON.stringify(phase.stats)}`,
      )
      checkOracle()

      const click = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: async () => {
          await writeSelectionClick(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      expect(click.parity).toBe(true)
      expect(click.rowsCommitted).toBe(0)
      expect(click.stats.rowsDerived).toBe(0)
      console.info(
        `[hand-native] click committed ${click.rowsCommitted}/${click.visibleRows}; ` +
          `stats=${JSON.stringify(click.stats)}`,
      )
      checkOracle()
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
