/**
 * POD-4571 (Mb3) — the correctness gate (L4b, `shared/src/gen/check.ts`)
 * with the ORACLE on, every step. The pool's gate (`../gate.test.ts`) runs
 * rebuild-only (`oracleEvery: 0`) because order and roll-ups were the
 * worklist phase's; with Mb1-Mb3 in, the whole `SliceSnapshot` (rows with
 * their roll-ups, the grouped order) is held to the legacy derivation after
 * every generated change, and to the pool's own rebuild.
 *
 * NO NAMED EXCEPTION (POD-4671 fixed): the union roots seat the orphan, so
 * the gate holds the pool directly to the oracle.
 *
 * OBSERVED: each gated arm is kept alive by one reaction over every visible
 * row's view and the layout, as the mounted list keeps it; otherwise every
 * computed re-runs on each snapshot and a stale cache cannot show (the first
 * run of this gate caught the plant on 0 of 3 seeds for exactly that reason).
 *
 * THE NO: an arm whose attention aggregate reads its nest children's SET
 * untracked (pitfall j: untracked state inside a derivation) keeps serving a
 * cached aggregate after a row nests or un-nests under it. It must fail
 * every seed.
 */

import { reaction, untracked } from 'mobx'
import { describe, expect, it } from 'vitest'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { countKinds, gen } from '../../../../shared/src/gen/changes'
import { type CheckedArm, checkArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import { harnessMobxPoolArm, visibleOrderOf, type HarnessMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import { rowViewOf } from '../models'

installMobxWarnTrap()

const SEEDS = Array.from(
  { length: Number(process.env['POD_ROLLUP_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_ROLLUP_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 3_000)

/** The planted mistake: the nest children's set is read untracked. */
const untrackedNest: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessMobxPoolArm.create(source, locals, reads)
    const inputs = handle.pool.visibleInputs as { nested: (id: string) => Iterable<string> }
    const nested = inputs.nested
    inputs.nested = (id) => untracked(() => [...nested(id)])
    return handle
  },
}

/**
 * `base` OBSERVED as a mounted list observes it (every visible row's view and
 * the grouped layout kept alive by one reaction). Without the observer every
 * computed would re-run on each snapshot read, and no caching mistake could
 * ever show. POD-4671 fixed: no patch, the tally stays 0.
 */
function gapped(base: CheckableArm, tally: { applied: number }): CheckedArm {
  void tally
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const handle = base.create(source, locals, reads) as HarnessMobxPoolHandle
      const { pool } = handle
      const stop = reaction(
        () => [visibleOrderOf(pool).map((id) => rowViewOf(pool.issue(id))), pool.groups.layout],
        () => {},
        { name: 'gate.observer' },
      )
      void ctx
      return {
        ...handle,
        dispose() {
          stop()
          handle.dispose()
        },
      }
    },
  })
}

describe('correctness gate (L4b) with the oracle every step (Mb3)', () => {
  it(
    'passes every seed against the oracle and the rebuild; the untracked-nest plant fails every seed',
    async () => {
      const cells = []
      let plantFailures = 0
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const tally = { applied: 0 }
        const result = await checkArm(gapped(harnessMobxPoolArm, tally), sequence, { oracleEvery: 1 })
        const plantTally = { applied: 0 }
        const plant = await checkArm(gapped(untrackedNest, plantTally), sequence, {
          oracleEvery: 1,
          shrink: false,
        })
        if (!plant.ok) plantFailures += 1
        cells.push({
          seed,
          steps: STEPS,
          kinds: countKinds(sequence),
          ok: result.ok,
          counts: result.counts,
          timingMs: result.timing,
          gapApplied: tally.applied,
          divergence: result.ok
            ? null
            : {
                step: result.step,
                against: result.against,
                change: result.change,
                diff: result.diff,
                shrunk: result.shrunk,
                shrunkDivergence: result.shrunkDivergence,
              },
          plant: plant.ok
            ? { caught: false }
            : {
                caught: true,
                step: plant.step,
                against: plant.against,
                diff: plant.diff.split('\n').slice(0, 3).join(' | '),
              },
        })
        expect(
          result.ok,
          result.ok ? '' : `seed ${seed}: ${result.against} at ${result.step}\n${result.diff}`,
        ).toBe(true)
      }
      writeResult(`mobx-rollups-gate-1x-${SEEDS.length}x${STEPS}`, {
        seeds: SEEDS,
        steps: STEPS,
        cells,
      })
      expect(plantFailures).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )
})
