/**
 * POD-4571 (Mb3) — the correctness gate (L4b, `shared/src/gen/check.ts`)
 * with the ORACLE on, every step. The pool's gate (`../gate.test.ts`) runs
 * rebuild-only (`oracleEvery: 0`) because order and roll-ups were the
 * worklist phase's; with Mb1-Mb3 in, the whole `SliceSnapshot` (rows with
 * their roll-ups, the grouped order) is held to the legacy derivation after
 * every generated change, and to the pool's own rebuild.
 *
 * ONE NAMED EXCEPTION (POD-4671, `known-gaps.ts`): the unscanned-worktree
 * orphan has no seat in the shared schema's R3 relation. The gated arm takes
 * that one row's seat-fed fields from the oracle only when the pool has not
 * seated the orphan and the row differs in those fields alone, and counts
 * each time it did; the exception throws once the seat exists.
 *
 * THE NO: an arm whose attention aggregate reads its nest children's SET
 * untracked (pitfall j: untracked state inside a derivation) keeps serving a
 * cached aggregate after a row nests or un-nests under it. It must fail
 * every seed.
 */

import { untracked } from 'mobx'
import { describe, expect, it } from 'vitest'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { countKinds, gen } from '../../../../shared/src/gen/changes'
import { checkArm, type CheckedArm } from '../../../../shared/src/gen/check'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'
import { acceptUnscannedGap } from './known-gaps'

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
    const handle = mobxPoolArm.create(source, locals, reads)
    const inputs = handle.pool.visibleInputs as { nested: (id: string) => Iterable<string> }
    const nested = inputs.nested
    inputs.nested = (id) => untracked(() => [...nested(id)])
    return handle
  },
}

/** `base` with POD-4671's one row taken from the oracle, counted. */
function gapped(base: CheckableArm, tally: { applied: number }): CheckedArm {
  return (ctx: ScenarioEngine) => ({
    create(source, locals, reads) {
      const handle = base.create(source, locals, reads) as MobxPoolHandle
      const patch = (snapshot: SliceSnapshot): SliceSnapshot => {
        const oracle = oracleSnapshot(ctx.engine.getSnapshot())
        const { applied } = acceptUnscannedGap(ctx.corpus, handle.pool, oracle, snapshot)
        if (applied === null) return snapshot
        tally.applied += 1
        return {
          ...snapshot,
          rowsById: { ...snapshot.rowsById, [applied]: oracle.rowsById[applied]! },
        }
      }
      return {
        ...handle,
        snapshot: () => patch(handle.snapshot()),
        rebuildFromScratch: () => patch(handle.rebuildFromScratch()),
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
        const result = await checkArm(gapped(mobxPoolArm, tally), sequence, { oracleEvery: 1 })
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
        expect(result.ok, result.ok ? '' : `seed ${seed}: ${result.against} at ${result.step}\n${result.diff}`).toBe(true)
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
