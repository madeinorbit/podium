/**
 * THE TERMINAL DRIVER'S DECLARED EXEMPTIONS (POD-1761 W3).
 *
 * The corpus reads the FAMILY table in `../../permitted-failures.ts`; this
 * module is the driver's own restatement of the row it runs under, so that
 * "which weaknesses does the thing I am wiring up claim?" is answerable at the
 * wiring site instead of two packages away.
 *
 * IT IS DERIVED, NOT RETYPED. A hand-copied list is a second source of truth
 * that agrees until somebody edits the first one — and the direction of that
 * drift is always the same, because a driver that quietly widened its own
 * exemptions would still be green. Deriving it means a widening has to be made
 * in the file whose header calls it a high-bar decision, and
 * `TERMINAL_EXEMPTION_NAMES` below is what a test pins so the widening is also
 * visible.
 */

import { PERMITTED_FAILURES, type PermittedFailure } from '../../permitted-failures.js'

/**
 * What the terminal family may fail, per the spec: unverified sends,
 * at-least-once classifier interactions, and no native steer. Nothing else —
 * and in particular NOT `no-attach`, which is the embedded family's exemption:
 * the engine terminal is exactly what a terminal session has.
 */
export const TERMINAL_PERMITTED_FAILURES: readonly PermittedFailure[] = PERMITTED_FAILURES.terminal

/**
 * The three names, written out ONCE so a test can assert the derivation above
 * still yields exactly them.
 *
 * WHY NOT A `satisfies` INSTEAD. The family table is typed
 * `Record<DriverFamily, readonly PermittedFailure[]>`, so its rows are widened
 * to the full vocabulary and a compile-time proof about one row's CONTENTS is
 * not available from it. A test is the honest form of this check, and it fails
 * loudly for the same edit a `satisfies` would have caught.
 */
export const TERMINAL_EXEMPTION_NAMES = [
  'unverified-send',
  'at-least-once-interactions',
  'no-native-steer',
] as const satisfies readonly PermittedFailure[]
