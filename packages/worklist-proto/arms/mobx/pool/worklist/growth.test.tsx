// @vitest-environment happy-dom
/**
 * POD-4576 (Mc4) — the MobX pool's reads per change stay flat as the corpus
 * grows: fence scenarios #1–#5 (heartbeat, phase change, click, rename, stage
 * move) at 1x, 2x and 4x through the shared fence (`runFenceStep`), each step
 * holding parity (with the pool's one named POD-4671 allowance), the
 * exact-commit fence, its reads budget and the copy sweep.
 *
 * Flatness: every step's `readsPerChange` and `rowsCommitted` are identical
 * at 1x, 2x and 4x (the budgets are scale-free constants, except #2's, which
 * is `phaseChangePerLevel × chain levels` — the changed session's own chain,
 * never the corpus; the recorded budget shows which). A whole-corpus walk per
 * change reads thousands of rows and fails the same `assertReads` — the
 * legacy control is that plant, kept red in
 * `harness/src/legacy-control/control.test.tsx` (its heartbeat reads every
 * session and issue row against a budget of 3).
 */

import { describe, expect, it } from 'vitest'
import { assertCommits, assertReads, mountArmForCounts } from '../../../../harness/src/count-harness'
import {
  FENCE_SCENARIOS,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from '../../../../harness/src/fence-scenarios'
import { snapshotFromStore } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import { startScenarioEngine, type FixtureScale } from '../../../../shared/src/scenarios'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { mobxPoolArm } from '../arm'
import { MOBX_POOL_ALLOWANCES } from './known-gaps'

const SCALES = [1, 2, 4] as const satisfies readonly FixtureScale[]
/** The Mc4 growth scenarios: heartbeat, phase change, click, rename, stage move. */
const METHODOLOGIES = ['#1', '#2', '#3', '#4', '#5'] as const

interface GrowthCell {
  scale: string
  methodology: string
  scenario: string
  readsPerChange: number | null
  readsBudget: number
  rowsCommitted: number
  rowsDerived: number
  rollupsDerived: number
  parityAllowance: string | null
}

describe('growth: reads per change are flat at 1x, 2x and 4x (POD-4576)', () => {
  it('holds parity, commits and the reads fence at every scale, identically', async () => {
    const byScenario = new Map<string, GrowthCell[]>()
    for (const scale of SCALES) {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const mounted = mountArmForCounts(mobxPoolArm, feeds.rows.source, feeds.locals)
      try {
        for (const methodology of METHODOLOGIES) {
          const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
          if (entry === undefined) throw new Error(`no fence scenario ${methodology}`)
          const step = await runFenceStep(mounted, ctx, feeds.flush, entry)
          const { result, readsBudget } = step
          const at = `${methodology} ${result.scenario} at ${scale}x`
          let allowance: string | null = null
          if (!result.parity) {
            const actual = mounted.handle.snapshot()
            const oracle = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
            const patched = MOBX_POOL_ALLOWANCES.parity!.accept(
              ctx.corpus,
              mounted.handle,
              oracle,
              actual,
            )
            expect(
              diffSnapshots(actual, patched.snapshot),
              `${at}: beyond POD-4671's parity allowance (${result.parityDiff ?? ''})`,
            ).toBeNull()
            allowance = patched.applied
          }
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
            readsPerChange: result.readsPerChange,
            readsBudget,
            rowsCommitted: result.rowsCommitted,
            rowsDerived: result.stats.rowsDerived,
            rollupsDerived: result.stats.rollupsDerived,
            parityAllowance: allowance,
          }
          const list = byScenario.get(methodology) ?? []
          list.push(cell)
          byScenario.set(methodology, list)
        }
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
    writeResult('mobx-growth-mc4', {
      issue: 'POD-4576',
      cells: [...byScenario.values()].flat(),
    })
    // Flatness: the same change reads and commits the same rows at every
    // scale. #2's budget is chain-depth-relative, so its recorded budget is
    // the scale-free claim there (O(chain), never O(corpus)).
    for (const methodology of METHODOLOGIES) {
      const cells = byScenario.get(methodology) ?? []
      expect(cells.length, `${methodology} ran at every scale`).toBe(SCALES.length)
      const [at1, at2, at4] = cells
      expect(at2?.readsPerChange, `${methodology} reads 2x == 1x`).toBe(at1?.readsPerChange)
      expect(at4?.readsPerChange, `${methodology} reads 4x == 1x`).toBe(at1?.readsPerChange)
      expect(at2?.rowsCommitted, `${methodology} commits 2x == 1x`).toBe(at1?.rowsCommitted)
      expect(at4?.rowsCommitted, `${methodology} commits 4x == 1x`).toBe(at1?.rowsCommitted)
      expect(at2?.rowsDerived, `${methodology} derivations 2x == 1x`).toBe(at1?.rowsDerived)
      expect(at4?.rowsDerived, `${methodology} derivations 4x == 1x`).toBe(at1?.rowsDerived)
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
