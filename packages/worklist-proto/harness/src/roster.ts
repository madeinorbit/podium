/**
 * POD-4563 (L6a) — the round-three arms every fence runs on.
 *
 * One entry per candidate arm. `fences.test.tsx` runs each through every
 * scenario in `fence-scenarios.ts` with the exact-commit fence, parity and
 * the copy sweep, and `work-per-change.test.tsx` through the scale check
 * (POD-4746); the lint fence (`harness/lint/`) covers the same folders. The two lists cannot drift: an `arms/<folder>/fence.json`
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

import { harnessMobxPoolArm, harnessWritableMobxPoolArm } from './adapters/mobx-pool'
import type { ArmHandle, CheckableArm } from '../../shared/src/arm'
import type { RowSourceMode } from '../../shared/src/row-source'
import type { ScenarioEngine } from '../../shared/src/scenarios'
import type { SliceSnapshot } from '../../shared/src/slice-types'
import type { WriteTransport } from '../../shared/src/write-contract'
import type { CountResult } from './count-harness'
import type { FixtureCorpus } from './fixture/index'
import type { RowViews } from './oracle/index'
import type { WorkAllowance } from './scale-check'

/**
 * One arm's named exceptions. Every member names the issue that removes it
 * (`issue`, e.g. `POD-4678`).
 */
export interface RosterAllowances {
  /**
   * POD-4746 — known violations of the work-per-change check
   * (`work-per-change.test.tsx`): per issue that fixes them, the scenarios
   * and counts that grow with the data, each SIZED (POD-4825,
   * `scale-check.ts`): the derivations whose walks may grow
   * (`{ methodology, kind: 'elements', parts }`, the `elementsBy` keys), or
   * the most the count may exceed its bound by (`{ methodology, kind,
   * excess }`). A new walk in any other derivation, or a larger excess, still
   * fails. The check still reports them; an allowed count that passes fails
   * the suite.
   */
  readonly work?: readonly WorkAllowance[]
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
  /**
   * POD-4825 — the same arm with its write layer, sending through
   * `transport`: the arm that owns optimism. The work check and the census
   * run it too, idle and with pending edits (`writable-arm.ts`), on the same
   * feed as `armFor`.
   */
  writable?(transport: WriteTransport): CheckableArm
  /** Named exceptions, each removed by the issue it names (above). */
  allowances?: RosterAllowances
}

export const ROUND_THREE_ARMS: readonly RosterArm[] = [
  {
    // POD-4572 (Mb4): the round-three MobX pool with its worklist (Mb1-Mb3).
    // POD-4671 fixed: no parity allowance. POD-4792 fixed: no work allowance.
    name: 'MobX pool',
    folder: 'mobx',
    mode: 'overlaid',
    armFor: () => harnessMobxPoolArm,
    writable: (transport) => harnessWritableMobxPoolArm(transport),
  },
]
