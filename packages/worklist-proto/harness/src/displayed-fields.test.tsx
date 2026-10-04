import { upsertIssue } from '../../shared/src/scenarios'

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
 *
 * A MEASURED roster arm (`RosterArm.measuredOnly`, POD-4934) runs both steps
 * with parity asserted, but REPORTS each commit verdict (pass, or the
 * over/under rows with their counts) instead of failing: the first
 * measurement of an arm before its rework. With the flag removed the hand
 * arm goes red on the placement step (`over=[i214]`), which proves the fence
 * sees it.
 */

import {
  displayChanged,
  ROW_DISPLAYED_FIELDS,
  ROW_VIEW_FIELDS,
} from '@podium/client-graph/shared/row-view'
import { describe, expect, it } from 'vitest'
import { type ScenarioEngine, startScenarioEngine } from '../../shared/src/scenarios'
import { assertCommits, type CountResult, mountArmForCounts } from './count-harness'
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
      const wire = ctx.cache.read('issueProjection', target)?.value as
        | Record<string, unknown>
        | undefined
      if (wire === undefined) throw new Error(`issue ${target} missing from the server cache`)
      const projection = (ctx.cache.read('issueProjection', target)?.value ?? {}) as Record<
        string,
        unknown
      >
      const sortKey = `${String(wire['sortKey'] ?? '')}0pod-4825`
      ctx.replica.batch(() => {
        upsertIssue(ctx, target, { ...wire, sortKey })
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
      // POD-4934: a measured arm reports each commit verdict instead of failing on it.
      const measuredOnly = entry.measuredOnly === true
      const checkCommits = (result: CountResult, at: string): void => {
        if (!measuredOnly) {
          assertCommits(result)
          return
        }
        try {
          assertCommits(result)
        } catch (error) {
          console.info(`[drawn-fields] ${entry.name} ${at}: REPORTS ${(error as Error).message}`)
          return
        }
        console.info(
          `[drawn-fields] ${entry.name} ${at}: pass ` +
            `(changed ${result.oracleChangedRows?.length ?? 0}, drew ${result.drawnRows?.length ?? 0})`,
        )
      }
      try {
        const id = ctx.targets.visibleRootId
        const views = () => rowViewsFromStore(ctx.engine.access, engineLocals(ctx))
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
        checkCommits(placed.result, 'sortKeyOnly (P1)')

        const rename = FENCE_SCENARIOS.find((scenario) => scenario.methodology === '#4')!
        const renamed = await runFenceStep(mounted, ctx, feeds.flush, rename)
        expect(renamed.result.parity, renamed.result.parityDiff ?? '').toBe(true)
        expect(renamed.result.oracleChangedRows).toEqual([id])
        checkCommits(renamed.result, 'visibleTitleRename (#4)')
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 300_000)
  }
})
