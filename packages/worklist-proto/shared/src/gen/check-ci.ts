/**
 * POD-4556 (L4b) — the CI-sized correctness run: 20 seeds × 300 steps at 1x
 * on the legacy control, split into four shard files (`check-ci-<n>.test.ts`,
 * five seeds each) that vitest runs in parallel. The control must pass every
 * seed, and every shard must finish in under 5 minutes (the shards start
 * together, so the command's wall is the slowest shard plus boot).
 *
 * CHECKPOINTS EVERY 10 STEPS for both comparisons. The control's snapshot
 * and its rebuild are each a whole legacy derivation (~0.14 s and ~0.15 s at
 * 1x under load ~8), so comparing every step would cost ~0.3 s a step, ~30
 * minutes for 6,000 steps. A failure is re-run densely over its prefix
 * (`checkArm`), so the step it names is exact.
 *
 * Opt-in (it runs for minutes): `POD_CHECK_CI=1`. The command is in
 * `docs/plans/pod-4441-harness.md`, "The correctness gate". Per-seed counts
 * and times land in `harness/browser/results/check-ci-<n>.json`.
 */

import { expect } from 'vitest'
import { referenceArmFor } from '../../../harness/src/reference-arm/arm'
import { writeResult } from '../../../harness/src/results'
import { gen } from './changes'
import { type CheckResult, checkArm, describeSequence } from './check'

export const CI_ENABLED = process.env['POD_CHECK_CI'] === '1'
export const CI_SHARDS = 4
export const CI_SEEDS = 20
export const CI_STEPS = 300
export const CI_BUDGET_MS = 5 * 60_000
/** Vitest's own timeout for a shard: far above the budget, so a slow shard
 *  fails on the budget assertion with its numbers written, not on a kill. */
export const CI_TEST_TIMEOUT_MS = 15 * 60_000

/** Seeds `shard`, `shard + CI_SHARDS`, … (1-based), checked in order. */
export async function runCiShard(shard: number): Promise<void> {
  const started = performance.now()
  const perSeed: Array<{ seed: number; ms: number; result: CheckResult }> = []
  for (let seed = shard; seed <= CI_SEEDS; seed += CI_SHARDS) {
    const t = performance.now()
    const result = await checkArm(referenceArmFor, gen(seed, CI_STEPS), {
      rebuildEvery: 10,
      oracleEvery: 10,
    })
    perSeed.push({ seed, ms: Math.round(performance.now() - t), result })
    if (!result.ok) {
      writeResult(`check-ci-${shard}`, { failedSeed: seed, perSeed })
      throw new Error(
        `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
          `shrunk:\n${describeSequence(result.shrunk)}`,
      )
    }
  }
  const elapsedMs = Math.round(performance.now() - started)
  writeResult(`check-ci-${shard}`, { shard, steps: CI_STEPS, elapsedMs, perSeed })
  expect(elapsedMs).toBeLessThan(CI_BUDGET_MS)
}
