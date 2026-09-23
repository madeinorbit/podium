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
 * - deaf to the locals channel (POD-4608): the #3 click never selects the
 *   row and the #8b grace-crossing tick never folds the grace rows (under),
 *   while the same arm following the channel passes both exactly.
 *
 * - bare ref (POD-4624): the one plant PARITY must fail — a dropped repo
 *   prefix on every displayRef.
 *
 * The unplanted reference arm passes the same steps (`fences.test.tsx`), so
 * each failure below is the planted mistake, not the scenario.
 */

import { describe, expect, it } from 'vitest'
import { FIXTURE_SEED, startScenarioEngine } from '../../shared/src/scenarios'
import {
  assertCommits,
  assertIsolation,
  type CountResult,
  mountArmForCounts,
} from './count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from './fence-scenarios'
import { buildCorpus, FIXED_NOW } from './fixture/index'
import { expectedSnapshot } from './oracle/index'
import { type ReferencePlant, referenceArmFor } from './reference-arm/arm'

async function plantedStep(
  plant: ((targets: { visibleRootId: string }) => ReferencePlant) | null,
  methodology: string,
): Promise<{ result: CountResult; visibleRootId: string }> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const mounted = mountArmForCounts(
    referenceArmFor(ctx.engine, plant === null ? null : plant(ctx.targets)),
    feeds.rows.source,
    feeds.locals,
  )
  try {
    const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
    if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
    const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry)
    return { result, visibleRootId: ctx.targets.visibleRootId }
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

/** The oracle's 1x row count over the corpus the engine boots on (732 on
 *  the live-shaped fixture, POD-4635; 211 on the old one). */
const VISIBLE_1X = Object.keys(
  expectedSnapshot(buildCorpus(1, FIXTURE_SEED), { selectedIssueId: null, coarseNow: FIXED_NOW })
    .rowsById,
).length

describe('planted arms: the exact-commit fence catches what parity cannot', () => {
  it('unmemoised row slot: #1 over-commits every visible row', async () => {
    const { result } = await plantedStep(() => ({ kind: 'unmemoised' }), '#1')
    expect(result.parity, result.parityDiff ?? '').toBe(true)
    expect(result.oracleChangedRows).toEqual([])
    expect(result.visibleRows).toBe(VISIBLE_1X)
    expect(result.drawnRows).toHaveLength(result.visibleRows)
    expect(result.remountedRows).toEqual([])
    const n = VISIBLE_1X
    expect(() => assertCommits(result)).toThrow(
      new RegExp(
        `\\[commits\\] unrelatedHeartbeat \\(#1\\): drew ${n} rows, the oracle changed 0\\. over=\\[.*\\(${n}\\)\\] under=\\[\\]`,
      ),
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
    const n = VISIBLE_1X
    expect(() => assertCommits(result)).toThrow(
      new RegExp(
        `\\[commits\\] unrelatedHeartbeat \\(#1\\): drew ${n} rows, the oracle changed 0\\. over=\\[.*\\(${n}\\)\\] under=\\[\\] remounted=\\[.*\\(${n}\\)\\] rowsCommitted=0`,
      ),
    )
  }, 60_000)

  describe('deaf to the locals channel (POD-4608)', () => {
    it('#3: the click never selects the row; following the channel draws exactly it', async () => {
      const following = await plantedStep(null, '#3')
      expect(following.result.oracleChangedRows).toEqual([following.visibleRootId])
      expect(() => assertCommits(following.result)).not.toThrow()
      expect(following.result.locals?.keys.selectedIssueId).toBe(1)

      const { result, visibleRootId } = await plantedStep(() => ({ kind: 'deaf' }), '#3')
      expect(result.parity, result.parityDiff ?? '').toBe(true)
      expect(result.oracleChangedRows).toEqual([visibleRootId])
      expect(result.drawnRows).toEqual([])
      // The channel DID notify; the arm was not listening.
      expect(result.locals?.keys.selectedIssueId).toBe(1)
      expect(() => assertCommits(result)).toThrow(
        new RegExp(`selectionClick \\(#3\\): .* over=\\[\\] under=\\[${visibleRootId}\\]`),
      )
    }, 60_000)

    it('#8b: the grace-crossing tick never folds the grace rows; following the channel draws exactly them', async () => {
      // The plain #8 tick runs first on the same engine in the suite; standalone
      // here the crossing is the first tick, which moves the same rows.
      const following = await plantedStep(null, '#8b')
      const graceRows = following.result.oracleChangedRows ?? []
      expect(graceRows.length).toBeGreaterThan(0)
      expect(() => assertCommits(following.result)).not.toThrow()
      expect(following.result.locals?.keys).toEqual({
        selectedIssueId: 0,
        selectedIssueWasFolded: 0,
        coarseNow: 1,
      })

      const { result } = await plantedStep(() => ({ kind: 'deaf' }), '#8b')
      expect(result.oracleChangedRows).toEqual(graceRows)
      expect(result.drawnRows).toEqual([])
      expect(result.locals?.keys.coarseNow).toBe(1)
      expect(() => assertCommits(result)).toThrow(
        new RegExp(
          `clockGraceCrossing \\(#8b\\): .* over=\\[\\] under=\\[${graceRows.slice(0, 8).join(',')}`,
        ),
      )
    }, 60_000)
  })
})

describe('planted arm: parity catches a dropped repo prefix (POD-4624)', () => {
  it('bare ref: dropping the repo prefix fails parity on displayRef', async () => {
    // The oracle's refs carry the fixture's repo prefixes. While the scenario
    // seeder left the replica's repos kind empty they were bare too, and this
    // plant passed parity.
    const { result, visibleRootId } = await plantedStep(() => ({ kind: 'bareRef' }), '#1')
    expect(result.parity).toBe(false)
    expect(result.parityDiff).toMatch(/"displayRef":"#\d+".*\n.*"displayRef":"[^"#]+-\d+"/)
    const unplanted = await plantedStep(null, '#1')
    expect(unplanted.result.parity, unplanted.result.parityDiff ?? '').toBe(true)
    expect(unplanted.visibleRootId).toBe(visibleRootId)
  }, 60_000)
})
