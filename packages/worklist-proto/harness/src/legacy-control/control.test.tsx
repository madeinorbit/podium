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
 *   every issue row, through the fenced store (`fenced-store.ts`). The reads
 *   cell must equal the corpus: a fence that counted one table would miss it.
 *   (POD-4746: that the reads grow with the corpus is the scale check's NO,
 *   `work-per-change.test.tsx`; the per-scenario budgets are retired.)
 * - POD-4563: the same heartbeat changes no row view (the row-view oracle), so
 *   the exact-commit fence's changed set is empty and every row the control
 *   redraws is an over-commit: `assertCommits` throws.
 *
 * - POD-4609: every #6–#10 step reads the whole corpus too, both clock ticks
 *   included.
 *
 * NEVER weaken this test (no `skip`, no filtering the
 * heartbeat to a visible session). If it goes green without a control change,
 * the detector is blind — treat that as the emergency, not the relief. If it
 * goes red on the parity half, the control no longer renders what the app
 * shows — also an emergency.
 */

import { describe, expect, it } from 'vitest'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import {
  type ScenarioEngine,
  startScenarioEngine,
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../../shared/src/scenarios'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import {
  assertCommits,
  assertIsolation,
  assertReads,
  type CountResult,
  mountArmForCounts,
  runCountScenario,
} from '../count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../fence-scenarios'
import { rowViewsFromStore, snapshotFromStore } from '../oracle/index'
import { legacyControlArmFor } from './arm'

describe('legacy control (armed)', () => {
  it('FAILS isolation on unrelatedHeartbeat and passes parity exactly', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(
      legacyControlArmFor(ctx.engine),
      source.source,
      fixedLocals(locals),
    )
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
        views: () => rowViewsFromStore(ctx.engine.getSnapshot(), locals),
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

      // POD-4563 — THE ARMED COMMIT ASSERTION: the heartbeat changes no row
      // view, so the exact set is empty, and every row the control redrew is
      // an over-commit.
      expect(result.oracleChangedRows).toEqual([])
      expect(result.drawnRows?.length).toBeGreaterThan(0)
      expect(() => assertCommits(result)).toThrow(
        /\[commits\] unrelatedHeartbeat \(#1\): drew \d+ rows, the oracle changed 0\. over=\[/,
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
      // POD-4746: they are reads of the rows' data (the rows cell of the scale
      // check), not only of their ids.
      expect(result.reads?.data).toBeGreaterThanOrEqual(issueIds.size + store.sessions.length)
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
      const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
      const locals: SliceLocals = {
        selectedIssueId: null,
        coarseNow: ctx.engine.getSnapshot().coarseNow,
      }
      const mounted = mountArmForCounts(
        legacyControlArmFor(ctx.engine),
        source.source,
        fixedLocals(locals),
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
   * the old budget table in `docs/plans/pod-4441-harness.md`. One engine,
   * the scenarios in sequence, as the scenario writes intend. The legacy
   * derive is whole-world, so every scenario that publishes reads the corpus
   * — the click too, because it carries the eager mark-read row (the fence
   * sees the whole world on every scenario, not only the heartbeat).
   */
  it('reads the whole corpus on every scenario #1–#5', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(
      legacyControlArmFor(ctx.engine),
      source.source,
      fixedLocals(locals),
    )
    const run = (
      scenario: string,
      methodology: string,
      write: (ctx: ScenarioEngine) => Promise<unknown>,
    ) =>
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
      const corpus =
        new Set(store.issueProjections.map((issue) => issue.id)).size + store.sessions.length
      for (const result of results) {
        console.info(
          `[control reads] ${result.methodology} ${result.scenario}: read ${result.readsPerChange} ` +
            `(corpus ${corpus}) committed ${result.rowsCommitted}/${result.visibleRows} ` +
            `byEntity=${JSON.stringify(result.reads?.byEntity)}`,
        )
      }
      for (const result of results) expect(result.readsPerChange).toBeGreaterThanOrEqual(corpus)
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)

  /**
   * POD-4609 — every fence scenario in order (`fence-scenarios.ts`, the list
   * every arm runs): the control reads the whole corpus on each of #6–#10,
   * both clock ticks included, which publish the store although the row feed
   * emits nothing.
   */
  it('reads the whole corpus on every scenario #6–#10', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(
      legacyControlArmFor(ctx.engine),
      feeds.rows.source,
      feeds.locals,
    )
    try {
      const steps = []
      for (const entry of FENCE_SCENARIOS)
        steps.push(await runFenceStep(mounted, ctx, feeds.flush, entry))
      const store = ctx.engine.getSnapshot()
      const corpus =
        new Set(store.issueProjections.map((issue) => issue.id)).size + store.sessions.length
      const mine = steps.filter(({ result }) => /^#(6|7|8|9|10)/.test(result.methodology))
      expect(mine.map(({ result }) => result.methodology)).toEqual([
        '#6a',
        '#6b',
        '#6c',
        '#6d',
        '#7',
        '#8',
        '#8b',
        '#9a',
        '#9b',
        '#9c',
        '#10',
      ])
      for (const { result } of mine) {
        console.info(
          `[control reads] ${result.methodology} ${result.scenario}: read ${result.readsPerChange} ` +
            `(corpus ${corpus}) byEntity=${JSON.stringify(result.reads?.byEntity)}`,
        )
        expect(result.readsPerChange).toBeGreaterThanOrEqual(corpus)
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
