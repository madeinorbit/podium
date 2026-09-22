// @vitest-environment happy-dom
/**
 * POD-4447 — MobX arm on the native renderer: mountNative() through
 * mountNativeForCounts, scenarios #1–#3 with parity. Same RowShell
 * profilers, same runCountScenario as the web lane.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import { mountNativeForCounts, runCountScenario } from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
} from '../../shared/src/scenarios'
import { mobxArm, preloadMobxNative } from '../../arms/mobx/arm'

describe('mobx arm on the native renderer', () => {
  it('runs count scenarios #1-#3 with parity; #1 commits zero', async () => {
    await preloadMobxNative()
    const ctx = await startScenarioEngine(1)
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
      // POD-4550: on the fixture the #1 target is a session of a closed agent
      // issue, which the arm holds (unlike the retired corpus's archived
      // issue, which it skipped outright). The arm re-derives that one
      // issue's summary: a member's activity can decide whether a closed row
      // is retained. One body, flat across 1x/2x/4x (m3 growth); zero rows
      // commit, which is the methodology budget.
      expect(heartbeat.stats.rollupsDerived).toBe(1)

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
      // POD-4550: the #2 root's only live session goes idle, so exactly its
      // row commits (on the retired corpus R3 orphans kept it working).
      expect(phase.rowsCommitted).toBe(1)
      expect(phase.stats.rowsDerived).toBe(1)

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
