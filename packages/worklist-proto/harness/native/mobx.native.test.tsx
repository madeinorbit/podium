// @vitest-environment happy-dom
/**
 * POD-4447 — MobX arm on the native renderer: mountNative() through
 * mountNativeForCounts, scenarios #1–#3 with parity. Same RowShell
 * profilers, same runCountScenario as the web lane.
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
import { mobxArm, preloadMobxNative } from '../../arms/mobx/arm'

describe('mobx arm on the native renderer', () => {
  it('runs count scenarios #1-#3 with parity; #1 commits zero', async () => {
    await preloadMobxNative()
    const ctx = await startScenarioEngine(SMALL_CORPUS)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const handle = mobxArm.create(source.source, locals)
    const mounted = await mountNativeForCounts(handle)
    try {
      const list = document.querySelector('[data-testid="mobx-list"]')
      console.info(
        `[mobx-native] mounted rows: ${list?.querySelectorAll('[data-testid^="row-"]').length ?? 'NO-LIST'}`,
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
        `[mobx-native] heartbeat committed ${heartbeat.rowsCommitted}/${heartbeat.visibleRows}; ` +
          `stats=${JSON.stringify(heartbeat.stats)}`,
      )
      expect(heartbeat.rowsCommitted).toBe(0)
      expect(heartbeat.stats.rowsDerived).toBe(0)
      expect(heartbeat.stats.rollupsDerived).toBe(0)

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
        `[mobx-native] phase committed ${phase.rowsCommitted}/${phase.visibleRows}; ` +
          `stats=${JSON.stringify(phase.stats)}`,
      )
      // POD-4496: SMALL #2 now commits nothing — s0 flips working→idle but
      // i0 stays working via its R3 sessions s6/s48 (seed dual-carries the
      // anchor on the projection; legacy reads projection,
      // issue-view-models.ts:88). Oracle changes 0 rows, arm commits 0.
      expect(phase.rowsCommitted).toBe(0)
      expect(phase.stats.rowsDerived).toBe(0)

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
        `[mobx-native] click committed ${click.rowsCommitted}/${click.visibleRows}; ` +
          `stats=${JSON.stringify(click.stats)}`,
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
