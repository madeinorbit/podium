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
 * - POD-4557: the same heartbeat READS the whole corpus — every session and
 *   every issue row, through the fenced store (`fenced-store.ts`) — and
 *   `assertReads` (budget 3) throws. The reads cell must equal the corpus,
 *   not merely exceed 3: a fence that counted one table would still exceed 3.
 *
 * NEVER weaken this test (no raised budget, no `skip`, no filtering the
 * heartbeat to a visible session). If it goes green without a control change,
 * the detector is blind — treat that as the emergency, not the relief. If it
 * goes red on the parity half, the control no longer renders what the app
 * shows — also an emergency.
 */

import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../../shared/src/row-source'
import type { SliceLocals } from '../../../shared/src/slice-types'
import {
  assertIsolation,
  assertReads,
  mountArmForCounts,
  phaseChangeReadBudget,
  READ_BUDGETS,
  runCountScenario,
  type CountResult,
} from '../count-harness'
import { snapshotFromStore } from '../oracle/index'
import {
  startScenarioEngine,
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
  type ScenarioEngine,
} from '../../../shared/src/scenarios'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { legacyControlArmFor } from './arm'

describe('legacy control (armed)', () => {
  it('FAILS isolation on unrelatedHeartbeat and passes parity exactly', async () => {
    const ctx = await startScenarioEngine(1)
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

      // POD-4557 — reads = whole corpus. Every session row and every issue
      // row the store holds (wire and projection twins count once).
      const store = ctx.engine.getSnapshot()
      const issueIds = new Set([
        ...store.issues.map((issue) => issue.id),
        ...store.issueProjections.map((issue) => issue.id),
      ])
      console.info(
        `[control] heartbeat read ${result.readsPerChange} rows ` +
          `(corpus: ${issueIds.size} issues, ${store.sessions.length} sessions); ` +
          `reads=${JSON.stringify(result.reads)}`,
      )
      expect(result.reads?.byEntity['session']).toBe(store.sessions.length)
      expect(result.reads?.byEntity['issue']).toBe(issueIds.size)
      expect(result.readsPerChange).toBeGreaterThanOrEqual(issueIds.size + store.sessions.length)
      // THE ARMED READS ASSERTION: the control FAILS the #1 reads budget.
      expect(() => assertReads(result, { readsPerChange: READ_BUDGETS.unrelatedHeartbeat })).toThrow(
        /unrelatedHeartbeat \(#1\): read \d+ rows, budget 3/,
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 30_000)

  /**
   * POD-4557 — the fence is instrumentation, not a behaviour change: the same
   * heartbeat with the fence on and off commits the same rows and moves the
   * same stats, and parity holds in both. With the fence off there is no
   * reads cell, and `assertReads` fails on the missing cell.
   */
  it('commits and stats are identical with the reads fence on and off', async () => {
    async function heartbeatWith(reads: ReadFence | undefined): Promise<CountResult> {
      const ctx = await startScenarioEngine(1)
      const source = createRowSource(ctx.engine, ctx.replica)
      const locals: SliceLocals = { selectedIssueId: null, coarseNow: ctx.engine.getSnapshot().coarseNow }
      const mounted = mountArmForCounts(
        legacyControlArmFor(ctx.engine),
        source.source,
        locals,
        reads === undefined ? {} : { reads },
      )
      try {
        return await runCountScenario(mounted, {
          scenario: 'unrelatedHeartbeat',
          methodology: '#1',
          apply: async () => {
            await writeHeartbeat(ctx)
            source.flush()
          },
          expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
        })
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
    }
    const on = await heartbeatWith(undefined)
    const off = await heartbeatWith(DISABLED_READ_FENCE)
    expect(on.readsPerChange).toBeGreaterThan(0)
    expect(off.readsPerChange).toBeNull()
    expect(on.rowsCommitted).toBeGreaterThan(0)
    expect(on.rowsCommitted).toBe(off.rowsCommitted)
    expect(on.commitsByRow).toEqual(off.commitsByRow)
    expect(on.stats).toEqual(off.stats)
    expect(on.parity && off.parity).toBe(true)
    expect(() => assertReads(off, { readsPerChange: 1_000_000 })).toThrow(/no reads cell/)
  }, 30_000)

  /**
   * POD-4557 — what the current store reads per change, scenarios #1–#5, for
   * the budget table in `docs/plans/pod-4441-harness.md`. One engine, the
   * scenarios in sequence, as the scenario writes intend. The legacy derive
   * is whole-world, so every scenario that publishes reads the corpus — the
   * click too, because it carries the eager mark-read row. The assertion is
   * that each one EXCEEDS its round-three budget (the fence can say NO on
   * every scenario, not only the heartbeat).
   */
  it('reads the whole corpus on every scenario #1–#5', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = { selectedIssueId: null, coarseNow: ctx.engine.getSnapshot().coarseNow }
    const mounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, locals)
    const run = (scenario: string, methodology: string, write: (ctx: ScenarioEngine) => Promise<unknown>) =>
      runCountScenario(mounted, {
        scenario,
        methodology,
        apply: async () => {
          await write(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
    try {
      const results = [
        await run('unrelatedHeartbeat', '#1', writeHeartbeat),
        await run('visibleSessionPhaseChange', '#2', writePhaseChange),
        await run('selectionClick', '#3', writeSelectionClick),
        await run('visibleTitleRename', '#4', writeTitleRename),
        await run('stageMoveAcrossGroups', '#5', writeStageMove),
      ]
      const store = ctx.engine.getSnapshot()
      const corpus = new Set(store.issueProjections.map((issue) => issue.id)).size + store.sessions.length
      for (const result of results) {
        console.info(
          `[control reads] ${result.methodology} ${result.scenario}: read ${result.readsPerChange} ` +
            `(corpus ${corpus}) committed ${result.rowsCommitted}/${result.visibleRows} ` +
            `byEntity=${JSON.stringify(result.reads?.byEntity)}`,
        )
      }
      const [heartbeat, phase, click, rename, stage] = results
      for (const [result, budget] of [
        [heartbeat!, READ_BUDGETS.unrelatedHeartbeat],
        // Generous on purpose: 8 levels is deeper than any chain in the corpus.
        [phase!, phaseChangeReadBudget(7)],
        [click!, READ_BUDGETS.selectionClick],
        [rename!, READ_BUDGETS.visibleTitleRename],
        [stage!, READ_BUDGETS.stageMoveNeighbourhood],
      ] as const) {
        expect(result.readsPerChange).toBeGreaterThanOrEqual(corpus)
        expect(() => assertReads(result, { readsPerChange: budget })).toThrow(/read \d+ rows, budget/)
      }
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
