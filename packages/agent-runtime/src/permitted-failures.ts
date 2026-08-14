/**
 * WHAT EACH DRIVER FAMILY IS PERMITTED TO FAIL OR DECLINE (spec §3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TABLE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The spec's sentence is the whole argument: "A suite without that list proves
 * nothing about the hardest driver." A conformance corpus that demands protocol
 * fidelity from every family would be red on the terminal driver forever, and a
 * permanently-red suite is a suite people stop reading. A corpus that quietly
 * skips the hard cases proves nothing instead.
 *
 * So the weaknesses are ENUMERATED, per family, as data. The corpus reads this
 * table to decide whether an outcome is a permitted failure or a bug — and,
 * crucially, it also asserts the CONVERSE: a family that is NOT permitted a
 * weakness must not exhibit it. `unverified` from a server driver is a failure,
 * not a shrug, and that is only checkable because the permission is explicit.
 *
 * ADDING A PERMISSION HERE IS A DECISION with a high bar: it says a guarantee
 * the rest of Podium is written against does not hold for a whole family, and
 * every consumer must branch on it. The spec permits exactly two, both terminal.
 */

import type { DriverFamily } from './families.js'

/** One named weakness a family may exhibit. */
export type PermittedFailure =
  /**
   * A send may resolve `unverified`: keystrokes delivered, acceptance
   * unprovable inside the verification window. TERMINAL ONLY — the spec is
   * explicit, and the server family "must not need" any exemption.
   */
  | 'unverified-send'
  /**
   * Interaction asked→answered is AT-LEAST-ONCE with best-effort identity: a
   * re-rendered menu can mint a duplicate ask, and a keystroke answer cannot
   * prove it acted on the exact menu it classified. TERMINAL ONLY, and only for
   * classifier-sourced asks — a terminal driver reading a real hook channel has
   * better identity than this and should not claim the exemption.
   */
  | 'at-least-once-interactions'
  /**
   * `steer` is not native and degrades to `queue`. Permitted everywhere EXCEPT
   * where the harness protocol has a steer verb; the receipt must still report
   * the downgrade via `deliveredAs`, which is not optional for anyone.
   */
  | 'no-native-steer'
  /**
   * No interactive terminal at all. EMBEDDED ONLY: the runtime hosts the loop in
   * a worker child, so there is nothing to attach to and chat is the answer.
   */
  | 'no-attach'

export const PERMITTED_FAILURES: Readonly<Record<DriverFamily, readonly PermittedFailure[]>> = {
  // The protocol families have no excuses. When codex-server lands it passes the
  // same suite with this empty list, the selection policy flips, and no server
  // module, view-model or feature changes — because none of them ever knew more
  // than the surface.
  server: [],
  embedded: ['no-native-steer', 'no-attach'],
  terminal: ['unverified-send', 'at-least-once-interactions', 'no-native-steer'],
}

export const permits = (family: DriverFamily, failure: PermittedFailure): boolean =>
  PERMITTED_FAILURES[family].includes(failure)
