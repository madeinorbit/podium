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
  InteractionAskSpec,
  InteractionKind,
  PermittedFailure,
  ProcessEvent,
  RuntimeDriver,
  SessionSpec,
} from '../../index.js'

/** The out-of-band nudges the corpus needs. Structurally satisfied by the
 *  fake's `control`; real drivers implement it against their own harness. */
export interface ConformanceControl {
  /** A bare kind takes the minimal valid payload for it ({@link defaultAskFor});
   *  a full spec pins the payload the case actually cares about. `payload?:
   *  unknown` was the pre-POD-2020 shape and is gone deliberately — a corpus
   *  that could pass an arbitrary bag would not exercise the typed vocabulary
   *  it is supposed to be proving. */
  askInteraction(sessionId: SessionId, spec: InteractionKind | InteractionAskSpec): string
  reaskInteraction(sessionId: SessionId, id: string): string
  completeTurn(sessionId: SessionId): void
  processEvent(sessionId: SessionId, ev: ProcessEvent): void
  failNextVerification(sessionId: SessionId): void
  /**
   * HOW MANY TIMES THE CALLER'S TEXT HAS REACHED THE AGENT.
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
   * ---------------------------------------------------------------------------
   * WHAT COUNTS, AND WHY THIS IS A NAMED CONTRACT RATHER THAN A COUNTER
   * ---------------------------------------------------------------------------
   *
   * It was `deliveryAttempts`, and three separate targets read three different
   * questions into that name — which is how a corpus ends up with an instrument
   * whose readings cannot be compared (POD-2085 review, findings 1 and 3):
   *
   *   - the fake counted at `send()` ENTRY, so a QUEUED send counted before the
   *     words had gone anywhere. Every assertion about a drain was therefore
   *     already true before the drain, and the property that meant to watch a
   *     queue could not fail;
   *   - POD-2024's codex fixture counted accepted `turn/start`s, so a NATIVE
   *     STEER — which by definition starts no turn — counted zero. Measured, not
   *     predicted: their run read 1 against an expected 1+1.
   *
   * The name is now the question, and the question is about the AGENT, not about
   * turns. Four rules, and each exists because a target got it wrong:
   *
   *   1. A turn-opening send counts ONCE, when the words go out. `unverified`
   *      counts too: the keystrokes really were delivered, which is the whole
   *      distinction between `unverified` and `refused`.
   *   2. A NATIVE STEER COUNTS. It opens no turn on purpose, so any counter
   *      built on turn starts is blind to exactly the delivery the corpus most
   *      needs to see.
   *   3. A QUEUED send counts AT THE DRAIN, never at the send. Until the drain
   *      the words are sitting in a queue and the agent has not seen them —
   *      which is precisely what `queued` promises the caller.
   *   4. A REFUSAL, a retry, a nudge, a second CR at the same composer: none of
   *      them add a count. One handover of the caller's turn is one delivery,
   *      however many bytes it took; a SECOND count means a second copy of the
   *      user's words reached the agent.
   *
   * DO NOT WIDEN AN EXISTING COUNTER TO GO GREEN. POD-2024 tried
   * `turnStarts + steers` against the old name, then reverted it themselves with
   * the right reason: "widening the counter to go green is answering a broken
   * measurement by changing what is measured". If your harness cannot observe
   * one of the four cases above, that gap is a finding — say so rather than
   * report a number that means something else.
   */
  textDeliveries(sessionId: SessionId): number
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
