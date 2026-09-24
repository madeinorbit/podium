/**
 * POD-4584 (Hb3) — the correctness gate (L4b, `shared/src/gen/check.ts`)
 * with the ORACLE on, every step. The pool's gate (`../gate.test.ts`) runs
 * rebuild-only (`oracleEvery: 0`) because order and roll-ups were the
 * worklist phase's; with Hb1-Hb3 in, the whole `SliceSnapshot` (rows with
 * their roll-ups, the grouped order) is held to the legacy derivation after
 * every generated change, and to the pool's own rebuild.
 *
 * ONE NAMED EXCEPTION (POD-4671, `known-gaps.ts`): the unscanned-worktree
 * orphan has no seat in the shared schema's R3 relation. The gated arm takes
 * that one row's seat-fed fields from the oracle only when the pool has not
 * seated the orphan and the row differs in those fields alone, and counts
 * each time it did; the exception throws once the seat exists.
 *
 * THE NO: an arm whose child filings never settle (pitfall i/ii: maintained
 * state that is not kept) keeps composing every aggregate from its own part
 * alone after any nesting or re-parent. It must fail every seed.
 */

import { describe, expect, it } from 'vitest'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { countKinds, gen } from '../../../../shared/src/gen/changes'
import { type CheckedArm, checkArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import { type HandPoolHandle, handPoolArm } from '../arm'
import { acceptUnscannedGap } from './known-gaps'

const SEEDS = Array.from(
  { length: Number(process.env['POD_ROLLUP_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_ROLLUP_GATE_STEPS'] ?? 200)
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 3_000)

/** The planted mistake: the child filings never settle, so every composition reads no children. */
const staleFilings: CheckableArm = {
  create(source, locals, reads) {
    const handle = handPoolArm.create(source, locals, reads) as HandPoolHandle
    handle.pool.rollup.settleFilings = () => {}
    return handle
  },
}

/**
 * `base` with POD-4671's one row taken from the oracle, counted.
 */
function gapped(base: CheckableArm, tally: { applied: number }): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const handle = base.create(source, locals, reads) as HandPoolHandle
      const patch = (snapshot: SliceSnapshot): SliceSnapshot => {
        const oracle = oracleSnapshot(ctx.engine.getSnapshot())
        const { rows } = acceptUnscannedGap(ctx.corpus, handle.pool, oracle, snapshot)
        if (rows.length === 0) return snapshot
        tally.applied += rows.length
        const rowsById = { ...snapshot.rowsById }
        for (const id of rows) rowsById[id] = oracle.rowsById[id]!
        return { ...snapshot, rowsById }
      }
      return {
        ...handle,
        snapshot: () => patch(handle.snapshot()),
        rebuildFromScratch: () => patch(handle.rebuildFromScratch()),
        dispose() {
          handle.dispose()
        },
      }
    },
  })
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
        const result = await checkArm(gapped(handPoolArm, tally), sequence, { oracleEvery: 1 })
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
