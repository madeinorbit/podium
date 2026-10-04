// @vitest-environment happy-dom
/**
 * POD-4446 — hand-rolled arm against the live engine (SMALL corpus):
 * scenarios #1–#3 through the G4 count harness with oracle parity and the
 * rebuild oracle after every scenario. The arm input is the real kernel's
 * per-row change stream; expected snapshots come from snapshotFromStore.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { writeHeartbeat, writePhaseChange, writeSelectionClick } from '../../shared/src/scenarios'
import { handArm } from './arm'
import { rebuildFromScratch } from './rebuild'
import { HandStore } from './store'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

async function bootArm() {
  const ctx = await startScenarioEngine(1)
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: ctx.engine.access.coarseNow,
  }
  const mounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
  return { ctx, source, locals, mounted }
}

function expectOracle(mounted: { handle: { snapshot(): unknown } }, store: HandStore): void {
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

describe('hand-rolled arm on the engine (fixture 1x)', () => {
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('scenarios #1-#3: parity green, rebuild oracle green, isolation within budget', async () => {
    const { ctx, source, locals, mounted } = await bootArm()
    // Reach the live store behind the mounted handle for the rebuild oracle.
    const store = (mounted.handle as unknown as { store?: HandStore }).store
    try {
      // Parity on mount: the arm shows what the app shows.
      const atMount = mounted.handle.snapshot()
      const expectedAtMount = snapshotFromStore(ctx.engine.access, locals)
      expect(Object.keys((atMount as { rowsById: object }).rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(expectedAtMount)

      const heartbeat = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      console.info(
        `[hand] heartbeat committed=${heartbeat.rowsCommitted}/${heartbeat.visibleRows} ` +
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
      // is retained. Two bodies (own summary + visibility predicate), flat across 1x/2x/4x (m3 growth); zero rows
      // commit, which is the methodology budget.
      expect(heartbeat.stats.rollupsDerived).toBe(2)

      const phase = await runCountScenario(mounted, {
        scenario: 'visibleSessionPhaseChange',
        methodology: '#2',
        apply: async () => {
          await writePhaseChange(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      console.info(
        `[hand] phase committed=${phase.rowsCommitted}/${phase.visibleRows} ` +
          `stats=${JSON.stringify(phase.stats)} parity=${phase.parity} ` +
          `rows=${JSON.stringify(phase.commitsByRow)}`,
      )
      expect(phase.parityDiff).toBeNull()
      expect(phase.parity).toBe(true)

      const click = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: async () => {
          await writeSelectionClick(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      })
      console.info(
        `[hand] click committed=${click.rowsCommitted}/${click.visibleRows} ` +
          `stats=${JSON.stringify(click.stats)} parity=${click.parity}`,
      )
      expect(click.parityDiff).toBeNull()
      expect(click.parity).toBe(true)
      // Engine-driven selection is locals-only (no row event by design), so
      // the DOM commits nothing here; the eager mark-read row it carries must
      // not move any committed row either. Its readAt touches no summary,
      // visibility or aggregate VALUE, but the three input checks that prove
      // that still execute (honest classification cost, counted):
      // own-summary, visibility predicate, subtree aggregate.
      expect(click.rowsCommitted).toBe(0)
      expect(click.stats.rowsDerived).toBe(0)
      // The methodology's "2 rows" for #3 is the UI click path (selection
      // style on the two rows whose selected-ness flips, zero derivations) —
      // covered by the selection unit test and the UI click test.

      if (store !== undefined) expectOracle(mounted, store)
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
