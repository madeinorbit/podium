// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the fence steps that need no relation, on the live
 * engine: #1 (an unrelated heartbeat) and #4 (a visible title rename), with
 * the exact-commit fence, the reads budget and the copy sweep. Parity is not
 * asserted: the Ma1 snapshot has no order and stubs the roll-ups (the roster
 * entry, with every scenario and parity, is Ma4's).
 */

import { describe, expect, it, vi } from 'vitest'
import { assertCommits, assertReads, mountArmForCounts } from '../../../harness/src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../../../harness/src/fence-scenarios'
import { writeResult } from '../../../harness/src/results'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'

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
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
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
      expect(cells[1]!.drawn).toEqual(cells[1]!.oracleChanged)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
      vi.useRealTimers()
    }
  }, 120_000)
})
