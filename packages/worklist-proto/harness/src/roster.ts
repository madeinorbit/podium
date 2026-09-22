/**
 * POD-4563 (L6a) — the round-three arms every fence runs on.
 *
 * One entry per candidate arm. `fences.test.tsx` runs each through every
 * scenario in `fence-scenarios.ts` with the exact-commit fence, the L5a reads
 * budgets, parity and the copy sweep; the lint fence (`harness/lint/`) covers
 * the same folders. The two lists cannot drift: an `arms/<folder>/fence.json`
 * with no entry here, or an entry here with no manifest, fails the suite.
 *
 * Adding an arm (Ma1/Ha1): create `arms/<folder>/fence.json` (see
 * `harness/lint/README.md`), name its enumeration module in the arm's README,
 * and add `{ name, folder, mode, armFor }` below. The arm is created by the harness
 * through `Arm.create(source, locals, reads)`; `armFor` only closes over what
 * the arm's constructor needs from the scenario engine (usually nothing).
 */

import type { Arm } from '../../shared/src/arm'
import type { RowSourceMode } from '../../shared/src/row-source'
import type { ScenarioEngine } from '../../shared/src/scenarios'

export interface RosterArm {
  /** Display name in test titles. */
  name: string
  /** The folder under `arms/` holding the arm and its `fence.json`. */
  folder: string
  /** The feed the arm consumes (`row-source.ts`): `overlaid` for phase a/b pools, `truth` once it owns optimism. */
  mode: RowSourceMode
  armFor(ctx: ScenarioEngine): Arm
}

export const ROUND_THREE_ARMS: readonly RosterArm[] = []
