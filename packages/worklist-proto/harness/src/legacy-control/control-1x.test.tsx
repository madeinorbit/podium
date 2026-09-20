// @vitest-environment happy-dom
/**
 * POD-4445 — the control at live corpus (1x): the same armed shape as
 * `control.test.tsx` (heartbeat fails isolation, parity exact), plus the CI
 * budget: the whole count run finishes in under 60 s.
 *
 * This is the baseline every arm beats. Counts only — no walls under box
 * load (methodology §5.7); walls come from the Chromium driver.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../../shared/src/row-source'
import { GROWTH_CORPORA, startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceLocals } from '../../../shared/src/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
} from '../count-harness'
import { snapshotFromStore } from '../oracle/index'
import { writeHeartbeat } from '../scenario-writes'
import { legacyControlArmFor } from './arm'

describe('legacy control at 1x', () => {
  it('heartbeat fails isolation with exact parity in under 60 s', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(GROWTH_CORPORA.x1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, locals)
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
      const elapsedMs = performance.now() - started
      // The COST TABLE line the coordinator mail carries.
      console.info(
        `[control-1x] visible=${result.visibleRows} committed=${result.rowsCommitted} ` +
          `stats=${JSON.stringify(result.stats)} parity=${result.parity} ` +
          `elapsedMs=${Math.round(elapsedMs)}`,
      )
      expect(result.visibleRows).toBeGreaterThan(0)
      expect(result.parityDiff).toBeNull()
      expect(result.parity).toBe(true)
      expect(result.rowsCommitted).toBeGreaterThan(0)
      expect(() => assertIsolation(result, { rowsCommitted: 0 })).toThrow(
        /committed \d+ rows, budget 0/,
      )
      // THE CI BUDGET: the count harness on the control at 1x runs in under 60 s.
      expect(elapsedMs).toBeLessThan(60_000)
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
