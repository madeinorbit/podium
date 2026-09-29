// @vitest-environment happy-dom
/**
 * POD-4825 (item 5) — the exact-commit oracle expects a row to redraw only
 * when a field it DRAWS changes (`ROW_DISPLAYED_FIELDS`,
 * `shared/src/row-view.ts`), so no row has to read a field it does not draw
 * just to be redrawn.
 *
 * On every roster arm: a change to a placement field alone (the row's
 * `sortKey`: it moves in its lane, nothing it draws changes) redraws no row,
 * and a change to a drawn field (#4, the title) still redraws exactly its row.
 * Both through the shared fence step (`runFenceStep`: loads, parity, pending
 * writes), both held by `assertCommits`.
 *
 * PLANT (proven red, restored with cp): the MobX web row reading `row.sortKey`
 * again (a `data-sort-key` attribute, as it did for the old oracle) redraws
 * the moved row: `over=[<id>]` on the placement step.
 */

import { describe, expect, it } from 'vitest'
import { displayChanged, ROW_DISPLAYED_FIELDS, ROW_VIEW_FIELDS } from '../../shared/src/row-view'
import { type ScenarioEngine, startScenarioEngine, upsert } from '../../shared/src/scenarios'
import { assertCommits, mountArmForCounts } from './count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  type FenceScenario,
  openFenceFeeds,
  runFenceStep,
} from './fence-scenarios'
import { rowViewsFromStore } from './oracle/index'
import { ROUND_THREE_ARMS } from './roster'

/** A new `sortKey` on the target row (wire and projection), settled like a fence write. */
function sortKeyOnly(id: (ctx: ScenarioEngine) => string): FenceScenario {
  return {
    scenario: 'sortKeyOnly',
    methodology: 'P1',
    async write(ctx) {
      const target = id(ctx)
      const wire = ctx.cache.read('issue', target)?.value as Record<string, unknown> | undefined
      if (wire === undefined) throw new Error(`issue ${target} missing from the server cache`)
      const projection = (ctx.cache.read('issueProjection', target)?.value ?? {}) as Record<
        string,
        unknown
      >
      const sortKey = `${String(wire['sortKey'] ?? '')}0pod-4825`
      ctx.replica.batch(() => {
        upsert(ctx, 'issue', target, { ...wire, sortKey })
        upsert(ctx, 'issueProjection', target, { ...projection, sortKey })
      })
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
    },
    readsBudget: () => 0,
  }
}

describe('the rows an arm must redraw are the rows whose DRAWN fields changed (POD-4825)', () => {
  it('splits every RowView field into drawn and placement, once', () => {
    expect(ROW_DISPLAYED_FIELDS).not.toContain('sortKey')
    expect(ROW_DISPLAYED_FIELDS).not.toContain('repoKey')
    expect(ROW_DISPLAYED_FIELDS).not.toContain('foldAt')
    expect(ROW_DISPLAYED_FIELDS.every((field) => ROW_VIEW_FIELDS.includes(field))).toBe(true)
  })

  for (const entry of ROUND_THREE_ARMS) {
    it(`${entry.name}: a sortKey change redraws nothing; a title change redraws exactly its row`, async () => {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, entry.mode)
      const mounted = mountArmForCounts(entry.armFor(ctx), feeds.rows.source, feeds.locals)
      try {
        const id = ctx.targets.visibleRootId
        const views = () => rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
        const before = views()[id]
        const placed = await runFenceStep(
          mounted,
          ctx,
          feeds.flush,
          sortKeyOnly(() => id),
        )
        const after = views()[id]
        // The step is what it says: the row's sortKey moved, nothing it draws did.
        expect(before?.sortKey).not.toBe(after?.sortKey)
        expect(before !== undefined && after !== undefined && displayChanged(before, after)).toBe(
          false,
        )
        expect(placed.result.parity, placed.result.parityDiff ?? '').toBe(true)
        expect(placed.result.oracleChangedRows).toEqual([])
        assertCommits(placed.result)

        const rename = FENCE_SCENARIOS.find((scenario) => scenario.methodology === '#4')!
        const renamed = await runFenceStep(mounted, ctx, feeds.flush, rename)
        expect(renamed.result.parity, renamed.result.parityDiff ?? '').toBe(true)
        expect(renamed.result.oracleChangedRows).toEqual([id])
        assertCommits(renamed.result)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 300_000)
  }
})
