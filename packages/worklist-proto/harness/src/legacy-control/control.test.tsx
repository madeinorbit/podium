// @vitest-environment happy-dom
/**
 * POD-4445 — the ARMED control. This test must FAIL its isolation assertion
 * and PASS parity, every run, in CI.
 *
 * - `unrelatedHeartbeat` (methodology #1, budget: 0 rows committed) commits
 *   every visible row on the legacy control: one whole-world derive, one
 *   publish, unmemoized whole-array-props rows. `assertIsolation` throws with
 *   the counts — that throw is the detector proving it can say NO.
 * - Parity passes exactly: the control projects the same legacy slice the
 *   oracle projects.
 *
 * NEVER weaken this test (no raised budget, no `skip`, no filtering the
 * heartbeat to a visible session). If it goes green without a control change,
 * the detector is blind — treat that as the emergency, not the relief. If it
 * goes red on the parity half, the control no longer renders what the app
 * shows — also an emergency.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../../shared/src/row-source'
import { SMALL_CORPUS, startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceLocals } from '../../../shared/src/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
  type CountResult,
} from '../count-harness'
import { snapshotFromStore } from '../oracle/index'
import { writeHeartbeat } from '../scenario-writes'
import { legacyControlArmFor } from './arm'

describe('legacy control (armed)', () => {
  it('FAILS isolation on unrelatedHeartbeat and passes parity exactly', async () => {
    const ctx = await startScenarioEngine(SMALL_CORPUS)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, locals)
    try {
      // Parity on mount, before any action: the control shows what the app shows.
      const atMount = mounted.handle.snapshot()
      const expectedAtMount = snapshotFromStore(ctx.engine.getSnapshot(), locals)
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(expectedAtMount)

      const result: CountResult = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })

      // The can-say-YES guard: parity true on an empty list would be vacuous.
      expect(result.visibleRows).toBeGreaterThan(0)
      // Parity passes EXACTLY.
      expect(result.parityDiff).toBeNull()
      expect(result.parity).toBe(true)

      // The can-say-NO guard: the heartbeat must have committed rows. A zero
      // here means the detector is blind (stale publisher, lost subscription),
      // not that the control is isolated.
      console.info(
        `[control] heartbeat committed ${result.rowsCommitted}/${result.visibleRows} visible rows; ` +
          `stats=${JSON.stringify(result.stats)} parity=${result.parity}`,
      )
      expect(result.rowsCommitted).toBeGreaterThan(0)

      // THE ARMED ASSERTION: the control FAILS the #1 budget (0 rows).
      expect(() => assertIsolation(result, { rowsCommitted: 0 })).toThrow(
        /committed \d+ rows, budget 0/,
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 30_000)
})
