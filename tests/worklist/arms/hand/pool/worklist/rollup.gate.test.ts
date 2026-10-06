/**
 * POD-4584 (Hb3) — the correctness gate (L4b, `shared/src/gen/check.ts`)
 * with the ORACLE on, every step. The pool's gate (`../gate.test.ts`) runs
 * rebuild-only (`oracleEvery: 0`) because order and roll-ups were the
 * worklist phase's; with Hb1-Hb3 in, the whole `SliceSnapshot` (rows with
 * their roll-ups, the grouped order) is held to the legacy derivation after
 * every generated change, and to the pool's own rebuild.
 *
 * NO NAMED EXCEPTION (POD-4671 fixed): the union roots seat the orphan.
 *
 * THE NO: an arm whose child filings never settle (pitfall i/ii: maintained
 * state that is not kept) keeps composing every aggregate from its own part
 * alone after any nesting or re-parent. It must fail every seed.
 */

import { describe, expect, it } from 'vitest'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { countKinds, gen } from '../../../../shared/src/gen/changes'
import { type CheckedArm, checkArm } from '../../../../shared/src/gen/check'
import { harnessHandPoolArm, type HarnessHandPoolHandle } from '../../../../harness/src/adapters/hand-pool'

const SEEDS = Array.from(
  { length: Number(process.env['POD_ROLLUP_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_ROLLUP_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 3_000)

/** The planted mistake: the child filings never settle, so every composition reads no children. */
const staleFilings: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads) as HarnessHandPoolHandle
    handle.pool.rollup.settleFilings = () => {}
    return handle
  },
}

/**
 * `base` directly (POD-4671 fixed: no patch, the tally stays 0).
 */
function gapped(base: CheckableArm, tally: { applied: number }): CheckedArm {
  void tally
  return base
}

describe('correctness gate (L4b) with the oracle every step (Hb3)', () => {
  it(
    'passes every seed against the oracle and the rebuild; the stale-filings plant fails every seed',
    async () => {
      const cells = []
      let plantFailures = 0
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const tally = { applied: 0 }
        const result = await checkArm(gapped(harnessHandPoolArm, tally), sequence, { oracleEvery: 1 })
        const plantTally = { applied: 0 }
        const plant = await checkArm(gapped(staleFilings, plantTally), sequence, {
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
      expect(plantFailures, 'the stale-filings plant fails every seed').toBe(SEEDS.length)
      writeResult(`hand-rollups-gate-1x-${SEEDS.length}x${STEPS}`, {
        seeds: SEEDS,
        steps: STEPS,
        cells,
      })
    },
    GATE_TIMEOUT_MS,
  )
})
