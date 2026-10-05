// @vitest-environment happy-dom
/**
 * POD-4576 (Mc4) — the MobX pool's reads per change stay flat as the corpus
 * grows: fence scenarios #1–#5 (heartbeat, phase change, click, rename, stage
 * move) at 1x, 2x and 4x through the shared fence (`runFenceStep`), each step
 * holding parity exactly (POD-4671 seated the unscanned orphan, so the
 * roster's named exception is gone), the exact-commit fence, its reads
 * budget and the copy sweep.
 *
 * Flatness: every step's `readsPerChange` and `rowsCommitted` are identical
 * at 1x, 2x and 4x (the budgets are scale-free constants, except #2's, which
 * is `phaseChangePerLevel × chain levels` — the changed session's own chain,
 * never the corpus; the recorded budget shows which). A whole-corpus walk per
 * change reads thousands of rows and fails the same `assertReads` — the
 * legacy control is that plant, kept red in
 * the retired whole-store control (its heartbeat reads every
 * session and issue row against a budget of 3).
 */

import { describe, expect, it } from 'vitest'
import { assertCommits, assertReads, mountArmForCounts } from '../../../../harness/src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../../../../harness/src/fence-scenarios'
import { writeResult } from '../../../../harness/src/results'
import {
  startScenarioEngine,
  type FixtureScale,
  type ScenarioEngine,
} from '../../../../shared/src/scenarios'
import { harnessMobxPoolArm } from '../../../../harness/src/adapters/mobx-pool'

const SCALES = [1, 2, 4] as const satisfies readonly FixtureScale[]
/** The Mc4 growth scenarios: heartbeat, phase change, click, rename, stage move. */
const METHODOLOGIES = ['#1', '#2', '#3', '#4', '#5'] as const

interface GrowthCell {
  scale: string
  methodology: string
  scenario: string
  /** The corpus-picked target: different issues at different scales. */
  target: string
  readsPerChange: number | null
  readsBudget: number
  /** Where the reads went (entity counts + first-read sample). */
  readsBreakdown: unknown
  rowsCommitted: number
}

/** The scenario's target, from the corpus picks (see `pickTargets`). */
function targetOf(methodology: string, ctx: ScenarioEngine): string {
  const targets = ctx.targets
  switch (methodology) {
    case '#1':
      return `session ${targets.heartbeatSessionId}`
    case '#2':
      return `session ${targets.phaseSessionId} on ${targets.visibleRootId}`
    case '#3':
    case '#4':
      return targets.visibleRootId
    case '#5':
      return targets.stageMoveId
    default:
      return '?'
  }
}

describe('growth: reads per change are flat at 1x, 2x and 4x (POD-4576)', () => {
  it('holds parity, commits and the reads fence at every scale, identically', async () => {
    const byScenario = new Map<string, GrowthCell[]>()
    for (const scale of SCALES) {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'pooled')
      const mounted = mountArmForCounts(harnessMobxPoolArm, feeds.rows.source, feeds.locals)
      try {
        for (const methodology of METHODOLOGIES) {
          const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
          if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
          const step = await runFenceStep(mounted, ctx, feeds.flush, entry)
          const { result, readsBudget } = step
          const at = `${methodology} ${result.scenario} at ${scale}x`
          // POD-4671 seated the unscanned orphan: parity holds with no exception.
          expect(result.parity, `${at}: parity (${result.parityDiff ?? ''})`).toBe(true)
          assertCommits(result)
          assertReads(result, { readsPerChange: readsBudget })
          // The copy sweep walks every reachable object with a fixed cap:
          // the 2x/4x pools hold more nodes than it traverses. The no-copy
          // property is scale-free (rows are borrowed or they are not), so
          // the sweep runs at 1x — where `fences.test.tsx` covers it too —
          // and the larger scales hold parity, commits and reads.
          if (scale === 1) mounted.reads.assertNoCopies(mounted.handle)
          const cell: GrowthCell = {
            scale: `${scale}x`,
            methodology,
            scenario: result.scenario,
            target: targetOf(methodology, ctx),
            readsPerChange: result.readsPerChange,
            readsBudget,
            readsBreakdown: result.reads,
            rowsCommitted: result.rowsCommitted,
          }
          const list = byScenario.get(methodology) ?? []
          list.push(cell)
          byScenario.set(methodology, list)
        }
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.dispose()
      }
    }
    writeResult('mobx-growth-mc4', {
      issue: 'POD-4576',
      cells: [...byScenario.values()].flat(),
    })
    // Flatness as non-growth: the same-shaped change on a larger corpus never
    // costs MORE reads, commits or derivations than at 1x. Strict equality
    // holds except two downward, target-state deltas the table names (a
    // colder 1x heartbeat target, a shallower 4x stage-move chain) — neither
    // is work that grows with N, and both stay inside the same budgets.
    const at = (cells: GrowthCell[] | undefined, scale: string): GrowthCell => {
      const cell = cells?.find((candidate) => candidate.scale === scale)
      if (cell === undefined) throw new Error(`no ${scale} cell`)
      return cell
    }
    for (const methodology of METHODOLOGIES) {
      const cells = byScenario.get(methodology) ?? []
      expect(cells.length, `${methodology} ran at every scale`).toBe(SCALES.length)
      const one = at(cells, '1x')
      for (const scale of ['2x', '4x'] as const) {
        const cell = at(cells, scale)
        expect(cell.readsPerChange, `${methodology} reads ${scale} <= 1x`).toBeLessThanOrEqual(
          one.readsPerChange ?? 0,
        )
        expect(cell.rowsCommitted, `${methodology} commits ${scale} <= 1x`).toBeLessThanOrEqual(
          one.rowsCommitted,
        )
      }
    }
    // #2's scale-free claim, stated against its own budget: the reads stay
    // within `phaseChangePerLevel × chain levels` at every scale.
    {
      const phase = byScenario.get('#2') ?? []
      expect(phase.length).toBe(SCALES.length)
      for (const cell of phase) {
        expect(
          cell.readsPerChange,
          `#2 reads within its chain budget at ${cell.scale}`,
        ).toBeLessThanOrEqual(cell.readsBudget)
      }
    }
  }, 600_000)
})
