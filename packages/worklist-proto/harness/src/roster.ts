/**
 * POD-4563 (L6a) — the round-three arms every fence runs on.
 *
 * One entry per candidate arm. `fences.test.tsx` runs each through every
 * scenario in `fence-scenarios.ts` with the exact-commit fence, the reads
 * budgets, parity and the copy sweep; the lint fence (`harness/lint/`) covers
 * the same folders. The two lists cannot drift: an `arms/<folder>/fence.json`
 * with no entry here, or an entry here with no manifest, fails the suite.
 *
 * Adding an arm (Ma1/Ha1): create `arms/<folder>/fence.json` (see
 * `harness/lint/README.md`), name its enumeration module in the arm's README,
 * and add `{ name, folder, mode, armFor }` below. The arm is created by the harness
 * through `Arm.create(source, locals, reads)`; `armFor` only closes over what
 * the arm's constructor needs from the scenario engine (usually nothing).
 *
 * NAMED ALLOWANCES (POD-4572). An arm may carry an exception to one fence only
 * as an `allowances` entry naming the issue that removes it, applied by
 * `fences.test.tsx` and nowhere else. Each is narrow by construction (it
 * accepts one field, one row or one counted term, and throws on anything
 * else), each application is recorded in the step's results cell, and the
 * suite fails when an allowance is never applied on any step: a fixed gap
 * must take its allowance with it.
 */

import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { MOBX_POOL_ALLOWANCES } from '../../arms/mobx/pool/worklist/known-gaps'
import type { ArmHandle, CheckableArm } from '../../shared/src/arm'
import type { RowSourceMode } from '../../shared/src/row-source'
import type { ScenarioEngine } from '../../shared/src/scenarios'
import type { SliceSnapshot } from '../../shared/src/slice-types'
import type { CountResult } from './count-harness'
import type { FixtureCorpus } from './fixture/index'
import type { RowViews } from './oracle/index'

/** The step an allowance is asked about. */
export interface AllowanceStep {
  readonly scenario: string
  readonly methodology: string
}

/**
 * One arm's named exceptions. Every member names the issue that removes it
 * (`issue`, e.g. `POD-4678`).
 */
export interface RosterAllowances {
  /**
   * Extra reads a step may take beyond its budget, computed from the arm
   * BEFORE the step's write (never from what the step read).
   */
  readonly reads?: {
    readonly issue: string
    before(ctx: ScenarioEngine, handle: ArmHandle, step: AllowanceStep): number
  }
  /**
   * Rows the oracle changed that may stay undrawn. Called only when the
   * exact-commit fence failed; returns the rows it accepts and THROWS when
   * any miss (or any over-draw) is not its own.
   */
  readonly undrawn?: {
    readonly issue: string
    accept(result: CountResult, before: RowViews, after: RowViews): string[]
  }
  /**
   * The parity snapshot patched for one known gap: the oracle's snapshot with
   * the arm's row taken where the gap (and only the gap) applies. `applied`
   * names that row, or is null when the snapshot needed no patch.
   */
  readonly parity?: {
    readonly issue: string
    /** `corpus` is the one whose rows the engine holds (a rescope's grown corpus at its grown state). */
    accept(
      corpus: FixtureCorpus,
      handle: ArmHandle,
      expected: SliceSnapshot,
      actual: SliceSnapshot,
    ): { snapshot: SliceSnapshot; applied: string | null }
  }
}

export interface RosterArm {
  /** Display name in test titles. */
  name: string
  /** The folder under `arms/` holding the arm and its `fence.json`. */
  folder: string
  /** The feed the arm consumes (`row-source.ts`): `overlaid` for phase a/b pools, `truth` once it owns optimism. */
  mode: RowSourceMode
  /** The arm must be checkable: `shared/src/gen/check.ts` runs every roster arm (POD-4556). */
  armFor(ctx: ScenarioEngine): CheckableArm
  /** Named exceptions, each removed by the issue it names (above). */
  allowances?: RosterAllowances
}

export const ROUND_THREE_ARMS: readonly RosterArm[] = [
  {
    // POD-4572 (Mb4): the round-three MobX pool with its worklist (Mb1-Mb3).
    name: 'MobX pool',
    folder: 'mobx',
    mode: 'overlaid',
    armFor: () => mobxPoolArm,
    allowances: MOBX_POOL_ALLOWANCES,
  },
]
