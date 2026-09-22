// @vitest-environment happy-dom
/**
 * POD-4447 — MobX arm against the live engine (SMALL corpus): scenarios
 * #1–#3 through the G4 count harness with oracle parity. The arm input is
 * the real kernel's per-row change stream; expected snapshots come from
 * snapshotFromStore.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { writeHeartbeat, writePhaseChange, writeSelectionClick } from '../../shared/src/scenarios'
import { mobxArm } from './arm'

async function bootArm() {
  const ctx = await startScenarioEngine(1)
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: ctx.engine.getSnapshot().coarseNow,
  }
  const mounted = mountArmForCounts(mobxArm, source.source, locals)
  return { ctx, source, locals, mounted }
}

describe('mobx arm on the engine (fixture 1x)', () => {
  it('scenarios #1-#3: parity green, isolation within budget', async () => {
    const { ctx, source, locals, mounted } = await bootArm()
    try {
      // Parity on mount: the arm shows what the app shows.
      const atMount = mounted.handle.snapshot()
      const expectedAtMount = snapshotFromStore(ctx.engine.getSnapshot(), locals)
      expect(Object.keys((atMount as { rowsById: object }).rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(expectedAtMount)

      const heartbeat = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx] heartbeat committed=${heartbeat.rowsCommitted}/${heartbeat.visibleRows} ` +
          `stats=${JSON.stringify(heartbeat.stats)} parity=${heartbeat.parity}`,
      )
      expect(heartbeat.parityDiff).toBeNull()
      expect(heartbeat.parity).toBe(true)
      expect(() => assertIsolation(heartbeat, { rowsCommitted: 0 })).not.toThrow()
      expect(heartbeat.stats.rowsDerived).toBe(0)
      // POD-4550: on the fixture the #1 target is a session of a closed agent
      // issue, which the arm holds (unlike the retired corpus's archived
      // issue, which it skipped outright). The arm re-derives that one
      // issue's summary: a member's activity can decide whether a closed row
      // is retained. One body, flat across 1x/2x/4x (m3 growth); zero rows
      // commit, which is the methodology budget.
      expect(heartbeat.stats.rollupsDerived).toBe(1)
      expect(heartbeat.stats.indexUpdates).toBe(0)

      const phase = await runCountScenario(mounted, {
        scenario: 'visibleSessionPhaseChange',
        methodology: '#2',
        apply: async () => {
          await writePhaseChange(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx] phase committed=${phase.rowsCommitted}/${phase.visibleRows} ` +
          `stats=${JSON.stringify(phase.stats)} parity=${phase.parity} ` +
          `rows=${JSON.stringify(phase.commitsByRow)}`,
      )
      expect(phase.parityDiff).toBeNull()
      expect(phase.parity).toBe(true)
      // POD-4550: the #2 root's only live session is the one going idle
      // (no other bound session, none seated by prefix), so its row moves
      // and exactly that row commits. On the retired corpus R3 orphans kept
      // the root working and #2 committed nothing (POD-4496).
      expect(phase.rowsCommitted).toBe(1)
      expect(phase.commitsByRow).toEqual({ [ctx.targets.visibleRootId]: 1 })
      expect(phase.stats.rowsDerived).toBe(1)
      expect(phase.stats.rollupsDerived).toBe(3)
      expect(phase.stats.indexUpdates).toBe(0)

      const click = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: async () => {
          await writeSelectionClick(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx] click committed=${click.rowsCommitted}/${click.visibleRows} ` +
          `stats=${JSON.stringify(click.stats)} parity=${click.parity}`,
      )
      expect(click.parityDiff).toBeNull()
      expect(click.parity).toBe(true)
      // Engine-driven selection is locals-only (no row event by design), so
      // the DOM commits nothing here; the eager mark-read row it carries must
      // not move any committed row either. Its readAt re-runs at most the
      // clicked row's flat predicate (unread is a genuine input there).
      expect(click.rowsCommitted).toBe(0)
      expect(click.stats.rowsDerived).toBe(0)
      // The eager mark-read row replaces i1's row object, so its three input
      // checks (flat + summary + aggregate) execute and prove no value change.
      expect(click.stats.rollupsDerived).toBe(3)
      // The methodology's "2 rows" for #3 is the UI click path (selection
      // style on the two rows whose selected-ness flips, zero derivations) —
      // covered by the selection unit test and the UI click test.
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
