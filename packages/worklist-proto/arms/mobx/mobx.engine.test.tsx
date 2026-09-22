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
  const source = createRowSource(ctx.engine, ctx.replica)
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: ctx.engine.getSnapshot().coarseNow,
  }
  const mounted = mountArmForCounts(mobxArm, source.source, locals)
  return { ctx, source, locals, mounted }
}

describe('mobx arm on the engine (SMALL)', () => {
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
      expect(heartbeat.stats.rollupsDerived).toBe(0)
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
      // POD-4496: SMALL #2 now commits nothing. writePhaseChange flips s0
      // (bound to i0) working→idle, but i0 keeps two working R3 sessions
      // (s6, s48: unbound, cwd under i0's /repo-0/wt-0 anchor, phase
      // working) now that the seed dual-carries the anchor on the
      // projection (legacy reads projection, issue-view-models.ts:88).
      // i0's SliceRow never moves, so the oracle changes 0 rows and the
      // arm commits 0 — parity green with an empty commit set. The three
      // derivation bodies still execute (flat + summary + aggregate input
      // checks on the replaced session object) and prove zero value
      // change, hence rollupsDerived stays 3.
      expect(phase.rowsCommitted).toBe(0)
      expect(phase.commitsByRow).toEqual({})
      expect(phase.stats.rowsDerived).toBe(0)
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
