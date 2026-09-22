// @vitest-environment happy-dom
/**
 * POD-4563 (L6a) — the exact-commit fence, proven ARMED through a real React
 * tree. Three planted reference arms (`ReferencePlant`), each a mistake parity
 * cannot see, each red on the step named, each with parity green:
 *
 * - unmemoised row slot: the #1 heartbeat redraws every visible row (over);
 * - stale view: the #2 phase change never redraws the changed row (under);
 * - remount on every render: the #1 heartbeat remounts every visible row and
 *   COMMITS NONE, so round two's isolation fence (commits ≤ 0) passes it and
 *   the new fence fails it. Both halves are asserted on the same run: that
 *   pair is the evidence this fence sees what the old one did not.
 *
 * The unplanted reference arm passes the same steps (`fences.test.tsx`), so
 * each failure below is the planted mistake, not the scenario.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import {
  assertCommits,
  assertIsolation,
  type CountResult,
  mountArmForCounts,
} from './count-harness'
import { engineLocals, FENCE_SCENARIOS, runFenceStep } from './fence-scenarios'
import { type ReferencePlant, referenceArmFor } from './reference-arm/arm'

async function plantedStep(
  plant: (targets: { visibleRootId: string }) => ReferencePlant,
  methodology: string,
): Promise<{ result: CountResult; visibleRootId: string }> {
  const ctx = await startScenarioEngine(1)
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const mounted = mountArmForCounts(
    referenceArmFor(ctx.engine, plant(ctx.targets)),
    source.source,
    engineLocals(ctx),
  )
  try {
    const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
    if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
    const { result } = await runFenceStep(mounted, ctx, source.flush, entry)
    return { result, visibleRootId: ctx.targets.visibleRootId }
  } finally {
    mounted.unmount()
    source.dispose()
    ctx.engine.destroy()
  }
}

describe('planted arms: the exact-commit fence catches what parity cannot', () => {
  it('unmemoised row slot: #1 over-commits every visible row', async () => {
    const { result } = await plantedStep(() => ({ kind: 'unmemoised' }), '#1')
    expect(result.parity, result.parityDiff ?? '').toBe(true)
    expect(result.oracleChangedRows).toEqual([])
    expect(result.visibleRows).toBe(211)
    expect(result.drawnRows).toHaveLength(result.visibleRows)
    expect(result.remountedRows).toEqual([])
    expect(() => assertCommits(result)).toThrow(
      /\[commits\] unrelatedHeartbeat \(#1\): drew 211 rows, the oracle changed 0\. over=\[.*\(211\)\] under=\[\]/,
    )
  }, 60_000)

  it('stale view: #2 under-commits the changed row', async () => {
    const { result, visibleRootId } = await plantedStep(
      ({ visibleRootId }) => ({ kind: 'stale', id: visibleRootId }),
      '#2',
    )
    expect(result.parity, result.parityDiff ?? '').toBe(true)
    expect(result.oracleChangedRows).toEqual([visibleRootId])
    expect(result.drawnRows).toEqual([])
    expect(() => assertCommits(result)).toThrow(
      new RegExp(`over=\\[\\] under=\\[${visibleRootId}\\]`),
    )
  }, 60_000)

  it('remount on every render: #1 fails the new fence and PASSES round two isolation on the same run', async () => {
    const { result } = await plantedStep(() => ({ kind: 'remount' }), '#1')
    expect(result.parity, result.parityDiff ?? '').toBe(true)
    // Nothing COMMITTED: every visible row remounted instead.
    expect(result.rowsCommitted).toBe(0)
    expect(result.commitsByRow).toEqual({})
    expect(result.remountedRows).toHaveLength(result.visibleRows)
    // The old fence says yes ...
    expect(() => assertIsolation(result, { rowsCommitted: 0 })).not.toThrow()
    // ... the new one says no.
    expect(() => assertCommits(result)).toThrow(
      /\[commits\] unrelatedHeartbeat \(#1\): drew 211 rows, the oracle changed 0\. over=\[.*\(211\)\] under=\[\] remounted=\[.*\(211\)\] rowsCommitted=0/,
    )
  }, 60_000)
})
