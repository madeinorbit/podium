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

import type {
  DriverFamily,
  InteractionKind,
  ProcessEvent,
  RuntimeDriver,
  SessionId,
  SessionSpec,
} from './contract-imports.js'

/** The out-of-band nudges the corpus needs. Structurally satisfied by the
 *  fake's `control`; real drivers implement it against their own harness. */
export interface ConformanceControl {
  askInteraction(sessionId: SessionId, kind: InteractionKind, payload?: unknown): string
  reaskInteraction(sessionId: SessionId, id: string): string
  completeTurn(sessionId: SessionId): void
  processEvent(sessionId: SessionId, ev: ProcessEvent): void
  failNextVerification(sessionId: SessionId): void
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
