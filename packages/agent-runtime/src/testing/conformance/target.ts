/**
 * WHAT A DRIVER MUST SUPPLY TO BE PUT UNDER THE CONFORMANCE CORPUS.
 *
 * The corpus is driver-PARAMETERIZED: one body of properties, run against every
 * driver, in the style of the repo's characterization gates. That only works if
 * the parameterization names the small set of things the contract itself cannot
 * reach.
 *
 * WHY A CONTROL SURFACE IS NEEDED AT ALL. Some states have no contract verb that
 * produces them, because producing them is the PROVIDER's job, not a caller's: a
 * turn cannot be made to fail from the outside, a menu cannot be made to
 * re-render, a process cannot be made to OOM, and a supervisor cannot be made to
 * restart by asking a session nicely. A corpus that could not reach those states
 * would test only the happy path — which is the half that was never in doubt.
 *
 * So each driver brings a {@link ConformanceControl}: the fake implements it in
 * memory, W3's terminal driver implements it by driving a real Claude session in
 * the e2e harness, and W5's opencode driver implements it by posting real
 * protocol events. The PROPERTIES stay identical; only the way the world is
 * nudged differs.
 */

import type { SessionId } from '@podium/model'
import type {
  DriverFamily,
  InteractionKind,
  PermittedFailure,
  ProcessEvent,
  RuntimeDriver,
  SessionSpec,
} from '../../index.js'

/** The out-of-band nudges the corpus needs. Structurally satisfied by the
 *  fake's `control`; real drivers implement it against their own harness. */
export interface ConformanceControl {
  askInteraction(sessionId: SessionId, kind: InteractionKind, payload?: unknown): string
  reaskInteraction(sessionId: SessionId, id: string): string
  completeTurn(sessionId: SessionId): void
  processEvent(sessionId: SessionId, ev: ProcessEvent): void
  failNextVerification(sessionId: SessionId): void
  /**
   * How many times the driver has DELIVERED this session's prompt text.
   *
   * WHY THE CORPUS NEEDS A COUNTER AND NOT AN INFERENCE. "`unverified` is never
   * retried into a lie" was proven indirectly — the turn epoch stays 0, so no
   * turn was opened — and that inference only holds for a driver that opens a
   * turn when it retries. W3's terminal driver is the first that can genuinely
   * re-type a prompt without any epoch moving, which is exactly the old
   * behaviour this outcome replaced: `scheduleSubmitVerify` re-submitted an
   * unprovable send up to twice and reported success. An indirect proof is no
   * proof against the one driver it was written about.
   *
   * COUNT DELIVERIES OF THE TEXT, not keystrokes. A driver whose submit needs a
   * separate CR, or a bounded nudge at the same composer, has made ONE delivery:
   * the caller's turn was handed over once. A SECOND delivery is a second copy
   * of the user's words reaching the agent, which is the thing that must never
   * happen behind an `unverified` receipt.
   */
  deliveryAttempts(sessionId: SessionId): number
  restartSupervisor(): void
  connectWithoutSecret(sessionId: SessionId): { refused: boolean }
}

export interface ConformanceTarget {
  /** Appears in the test names, so make it the driver id where there is one. */
  name: string
  family: DriverFamily
  /** A fresh driver per property. Sharing one across properties is how a suite
   *  starts passing because of state a previous property left behind. */
  createDriver(): { driver: RuntimeDriver; control: ConformanceControl }
  /** Reset any cross-instance state (the survivor registry, a temp dir) between
   *  properties. */
  reset(): void
  /** A spec the driver can actually start. */
  spec(): SessionSpec
}

/**
 * What a caller may say about a driver beyond how to build it.
 *
 * `exemptions` is deliberately a CLAIM the suite CHECKS, not a set of skips it
 * obeys. It must equal the family's row in `PERMITTED_FAILURES` exactly: a
 * driver claiming a weakness its family does not permit fails, and so does one
 * that quietly exhibits a weakness it did not claim. A suite whose exemption
 * list only ever silences things proves nothing about the hardest driver.
 */
export interface ConformanceOptions {
  exemptions?: readonly PermittedFailure[]
}
