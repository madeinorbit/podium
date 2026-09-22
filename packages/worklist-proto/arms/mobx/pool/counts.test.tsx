// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the fence steps that need no relation, on the live
 * engine: #1 (an unrelated heartbeat) and #4 (a visible title rename), with
 * the reads budget, the copy sweep and the commit cell. Parity is not
 * asserted: the Ma1 snapshot has no order and stubs the roll-ups (the roster
 * entry, with every scenario and parity, is Ma4's).
 *
 * THE COMMIT CELL AT Ma1. The exact-commit fence (`assertCommits`) compares
 * against the oracle's VISIBLE rows, and the Ma1 list draws every issue (the
 * visible set is Mb1), so a change to a hidden row's view is drawn and the
 * fence calls it an over-commit (#4 renames an origin; its hidden spin-off's
 * ⤷ tick changes). The cell asserted here is the Ma1 truth: no row the
 * oracle changed is missed, and every other drawn row is one the oracle does
 * not show and whose pool view really changed. `assertCommits` itself is
 * Mb1's gate.
 */

import { describe, expect, it, vi } from 'vitest'
import { assertReads, mountArmForCounts } from '../../../harness/src/count-harness'
import { engineLocals, FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { RowView } from '../../../shared/src/row-view'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'

function poolViews(handle: MobxPoolHandle): Map<string, RowView | undefined> {
  return tracked(() => new Map(handle.pool.issueIds.map((id) => [id, handle.pool.issue(id)?.view])))
}

installMobxWarnTrap()

describe('fence steps #1 and #4', () => {
  it('draws exactly the changed rows within the reads budget, holding no copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(mobxPoolArm, feeds.rows.source, feeds.locals)
    try {
      const cells = []
      for (const methodology of ['#1', '#4']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)!
        const handle = mounted.handle as MobxPoolHandle
        const before = poolViews(handle)
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
        const after = poolViews(handle)
        const oracleChanged = result.oracleChangedRows!
        const drawn = result.drawnRows!
        expect(oracleChanged.filter((id) => !drawn.includes(id)), `${methodology} under-drew`).toEqual([])
        const extra = drawn.filter((id) => !oracleChanged.includes(id))
        const poolChanged = [...after.keys()].filter((id) => before.get(id) !== after.get(id))
        expect(extra.filter((id) => !poolChanged.includes(id)), `${methodology} drew an unchanged view`).toEqual([])
        expect(drawn.sort(), `${methodology} drew exactly the changed pool views`).toEqual(poolChanged.sort())
        const visible = new Set(Object.keys(rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))))
        expect(extra.filter((id) => visible.has(id)), `${methodology} over-drew a visible row`).toEqual([])
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
          drawnHidden: extra,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsByEntity: result.reads?.byEntity,
          readsBudget,
          stats: result.stats,
        })
      }
      writeResult('mobx-pool-counts-1x', { scale: 1, cells })
      expect(cells[0]!.drawn).toEqual([])
      expect(cells[1]!.oracleChanged!.length).toBeGreaterThan(0)
      expect(cells[1]!.drawn).toEqual(expect.arrayContaining(cells[1]!.oracleChanged!))
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
      vi.useRealTimers()
    }
  }, 120_000)
})
