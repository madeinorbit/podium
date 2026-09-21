/**
 * THE SERVER FAMILY'S DECLARED EXEMPTIONS, AS THIS DRIVER CARRIES THEM
 * (POD-1761 W6).
 *
 * DERIVED, NEVER HAND-COPIED — the same discipline as `../opencode/
 * permitted-failures.ts` and for the same reason: a hand-copied list is a second
 * source of truth that agrees until somebody edits the first one, and the drift
 * is always in the direction of a driver quietly widening its own exemptions
 * while staying green.
 *
 * ---------------------------------------------------------------------------
 * THE INTERESTING PART: THIS DRIVER CLAIMS A WEAKNESS IT DOES NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * The server row is `['no-native-steer']`, and `ConformanceOptions.exemptions`
 * "must equal the family's row in PERMITTED_FAILURES exactly" — so this driver
 * passes the same row opencode does. But Codex HAS `turn/steer`, exercised live
 * against 0.147.0, and this driver declares `steer` in `send.native`.
 *
 * That looks like a contradiction and is not, because of the reshaping W5's
 * review already did to the property. The table's own note says it: once all
 * three families permit `no-native-steer`, the corpus stopped leaning on
 * `permits()` and instead asserts that `deliveredAs` is a delivery the driver
 * DECLARED native, in both directions — "a driver listing `steer` must deliver
 * as `steer`, and one that does not must report the delivery it actually used".
 * The family row is therefore a CEILING on what a family may fail, and the
 * capability declaration is the per-driver truth the suite actually enforces.
 * This driver is the first case that distinguishes the two, which is precisely
 * the case that reshaping was written for.
 *
 * The alternative — splitting the table per DRIVER so codex's row could be empty
 * — was rejected in W5 on the argument that it would rewrite W1's corpus
 * contract mid-epic to encode a fact the capability declaration already carries.
 * Nothing here changes that argument; if anything this driver confirms it, since
 * `send.native` says exactly which deliveries are real and the suite reads it.
 *
 * The two exemptions that MATTER — `unverified-send` and
 * `at-least-once-interactions` — stay off the server row permanently, this
 * driver claims neither, and the corpus refuses both a driver that claims a
 * weakness its family does not permit and one that exhibits a weakness it did
 * not claim.
 */

import { PERMITTED_FAILURES, type PermittedFailure } from '../../permitted-failures.js'

export const CODEX_SERVER_PERMITTED_FAILURES: readonly PermittedFailure[] =
  PERMITTED_FAILURES.server

/**
 * The one name, written out ONCE so a test can assert the derivation above still
 * yields exactly it — and so a future widening of the server row is a visible,
 * argued edit rather than a green suite nobody re-read.
 */
export const CODEX_SERVER_EXEMPTION_NAMES = [
  'no-native-steer',
] as const satisfies readonly PermittedFailure[]

/**
 * What this driver actually EXHIBITS, as opposed to what its family permits.
 *
 * EMPTY, and asserted by `./permitted-failures.test.ts` against the capability
 * declaration rather than restated by hand. This constant exists so the gap
 * between "the family may fail this" and "this driver does fail this" is a value
 * a test can read, instead of a paragraph a reviewer has to trust.
 */
export const CODEX_SERVER_EXHIBITED_FAILURES: readonly PermittedFailure[] = []
