// @vitest-environment happy-dom
/**
 * POD-4446 — hand-rolled arm on the native renderer: mountNative() through
 * mountNativeForCounts, scenarios #1–#3 with parity and the rebuild oracle.
 * Same RowShell profilers, same runCountScenario as the web lane.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { SMALL_CORPUS, startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import { mountNativeForCounts, runCountScenario } from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
} from '../../harness/src/scenario-writes'
import { handArm, preloadHandNative } from '../../arms/hand/arm'
import { rebuildFromScratch } from '../../arms/hand/rebuild'
import type { HandStore } from '../../arms/hand/store'

describe('hand-rolled arm on the native renderer', () => {
  it('runs count scenarios #1-#3 with parity; #1 commits zero', async () => {
    await preloadHandNative()
    const ctx = await startScenarioEngine(SMALL_CORPUS)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const handle = handArm.create(source.source, locals)
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
