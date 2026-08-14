/**
 * THE SERVER FAMILY'S DECLARED EXEMPTIONS (POD-1761 W5).
 *
 * The sibling of `../terminal/permitted-failures.ts`, and derived the same way
 * and for the same reason: a hand-copied list is a second source of truth that
 * agrees until somebody edits the first one, and the drift is always in the
 * direction of a driver quietly widening its own exemptions while staying green.
 *
 * ONE NAME, AND IT IS NOT ONE OF THE TWO THAT MATTER. `unverified-send` and
 * `at-least-once-interactions` are the terminal family's, they stay off this
 * row, and the corpus asserts the converse — a server driver that claimed
 * either, or that exhibited either without claiming it, fails. What the server
 * family does carry is `no-native-steer`, which W5 established is a per-harness
 * PROTOCOL VERB rather than a family property: Codex has `turn/steer`, opencode
 * has nothing like it. The argument is in `../../permitted-failures.ts`, where
 * the table lives.
 */

import { PERMITTED_FAILURES, type PermittedFailure } from '../../permitted-failures.js'

export const SERVER_PERMITTED_FAILURES: readonly PermittedFailure[] = PERMITTED_FAILURES.server

/**
 * The one name, written out ONCE so a test can assert the derivation above still
 * yields exactly it — and so a future widening of the server row is a visible,
 * argued edit rather than a green suite nobody re-read.
 */
export const SERVER_EXEMPTION_NAMES = ['no-native-steer'] as const satisfies readonly PermittedFailure[]
