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
 * weakness must not exhibit it. OpenCode v1 has a measured driver-specific
 * exception: its 204 precedes storage and cannot prove the program took it.
 *
 * ADDING A PERMISSION HERE IS A DECISION with a high bar: it says a guarantee
 * the rest of Podium is written against does not hold for a whole family, and
 * every consumer must branch on it. Measured exceptions stay pinned per driver.
 */

import { canonicalDriverId } from '../manifest.js'
import type { AcceptedDriverId, DriverFamily, DriverId } from './families.js'

/** One named weakness a family may exhibit. */
export type PermittedFailure =
  /**
   * A send may resolve `unverified`: keystrokes delivered, acceptance
   * unprovable inside the verification window. Terminal family, plus the
   * measured OpenCode v1 exception in permitsUnverifiedSend.
   */
  | 'unverified-send'
  /**
   * Interaction asked→answered is AT-LEAST-ONCE with best-effort identity: a
   * re-rendered menu can mint a duplicate ask, and a keystroke answer cannot
   * prove it acted on the exact menu. TERMINAL ONLY: classifier-sourced asks
   * require this exemption; hook-sourced asks may claim it when the driver has
   * observation identity rather than stable provider request identity. Hook
   * provenance alone does not establish exactly-once delivery (POD-3979).
   */
  | 'at-least-once-interactions'
  /**
   * `steer` is not native and degrades to `queue`. Permitted everywhere EXCEPT
   * where the harness protocol has a steer verb; the receipt must still report
   * the downgrade via `deliveredAs`, which is not optional for anyone.
   *
   * THE ONE ENTRY THAT IS A PER-HARNESS FACT WEARING A FAMILY'S CLOTHES, and
   * W5 is where that showed. Steering is a PROTOCOL VERB: Codex has
   * `turn/steer`, opencode has nothing like it. Measured against opencode
   * 1.18.16 — a prompt POSTed while a turn is open produces a SECOND user
   * message and a SECOND assistant turn that runs after the first completes;
   * the words never enter the open turn. So the server family contains one
   * driver that can steer and one that cannot, and no value in a per-family
   * table is true of both. See {@link PERMITTED_FAILURES}.
   */
  | 'no-native-steer'
  /**
   * No interactive terminal at all: no PTY, and no stock client that can open
   * the conversation beside the engine, so chat is the answer. SERVER FAMILY,
   * PINNED PER DRIVER in {@link NO_ATTACH_DRIVERS} — the same shape as
   * `no-native-steer`, and for the same reason. Having a client terminal is a
   * fact about a harness's CLI, not about the server shape: codex, opencode and
   * grok ship a TUI that reopens the session, and the Claude stream engine
   * (POD-4612, formerly its own `embedded` family) has none.
   */
  | 'no-attach'

export const PERMITTED_FAILURES: Readonly<Record<DriverFamily, readonly PermittedFailure[]>> = {
  /**
   * THE PROTOCOL FAMILY HAS NO EXCUSES ABOUT FIDELITY — and exactly one about
   * a verb its harnesses do not all have.
   *
   * `unverified-send` and `at-least-once-interactions` are the two that matter
   * and they stay off this row permanently: a server driver has a protocol ack
   * and a real request id, so a send it cannot prove and an ask it cannot
   * identify are bugs, not family-wide weaknesses. OpenCode v1's measured
   * storage gap is pinned separately by permitsUnverifiedSend.
   *
   * `no-native-steer` was added by W5 (POD-2023) after measuring opencode
   * 1.18.16, and the addition is argued rather than convenient. Steering is a
   * PROTOCOL VERB, not a family property: Codex's app-server has `turn/steer`
   * and opencode has no equivalent — a prompt POSTed into an open turn there
   * becomes a separate turn that runs afterwards. A per-family table cannot be
   * true of both drivers at once, and the two ways out were both worse than
   * this one. Declaring opencode's queue-behind-the-turn as `steer` would make
   * `deliveredAs` a lie in the one field that exists to prevent silent
   * substitution. Splitting the table per DRIVER would rewrite W1's corpus
   * contract mid-epic to encode a fact the capability declaration already
   * carries — `send.native` says, per driver, exactly which deliveries are real.
   *
   * WHAT KEEPS THE PROPERTY FROM GOING VACUOUS now that all three families
   * permit it, in two parts. First, the corpus no longer leans on `permits()`
   * alone: it asserts that `deliveredAs` is a delivery the driver DECLARED
   * native, in both directions — a driver listing `steer` must deliver as
   * `steer`, and one that does not must report the delivery it actually used and
   * never invent a third. Second, and added by POD-2085 after this row's cost
   * was counted: the ENTITLEMENT is pinned per driver in
   * {@link NO_NATIVE_STEER_DRIVERS}, so declining `steer` is an edit somebody
   * makes on purpose rather than a default a new driver inherits. Both bite on
   * every family, which the family permission never did.
   */
  server: ['no-native-steer', 'no-attach'],
  terminal: ['unverified-send', 'at-least-once-interactions', 'no-native-steer'],
}

export const permits = (family: DriverFamily, failure: PermittedFailure): boolean =>
  PERMITTED_FAILURES[family].includes(failure)

/** OpenCode 1.18.33 v1 can lose a prompt after its 204 (POD-4834 S6.C).
 * Its stored text part proves receipt; a bounded wait without it is unverified.
 * v2 admissions and other server protocols do not inherit this exception. */
export const permitsUnverifiedSend = (
  family: DriverFamily,
  driverId?: AcceptedDriverId,
): boolean =>
  permits(family, 'unverified-send') ||
  (family === 'server' && driverId !== undefined && canonicalDriverId(driverId) === 'opencode-server')

/**
 * WHICH DRIVERS MAY ACTUALLY TAKE `no-native-steer` (POD-2085).
 *
 * The row is now on all three families, so `permits(family, 'no-native-steer')`
 * is true for everyone and answers nothing. That is not merely a weak check, it
 * is a REGRESSION with a date on it: under `server: []` the corpus's
 * steer-downgrade property asserted the permission on its non-native branch, so
 * a server driver without a steer verb failed outright and had to come here and
 * argue — which is exactly how W5 (POD-2023) came to record the opencode
 * measurement above. The moment the row went on, that gate opened for the whole
 * family: a codex-server, whose app-server DOES have `turn/steer`, could simply
 * not declare `steer` and inherit the pass in silence.
 *
 * So the entitlement is pinned per DRIVER, the way `manifest-axis.test.ts` pins
 * a version range per driver and for the same reason: a claim about what this
 * build was measured against is worth something only where the measurement
 * exists. Steering is a per-HARNESS protocol verb; this list is the set of
 * harnesses somebody actually looked at and found no verb in.
 *
 *   `generic-pty`     — a TUI that does not queue mid-turn input has no way to
 *                       append into an open turn. The terminal driver's own
 *                       capability declaration says so (`send.native` is
 *                       `['when-ready','queue','interrupt']`, pinned in
 *                       `drivers/terminal/terminal.test.ts`). The entitlement
 *                       is per HARNESS on this one driver id (POD-5855): a
 *                       profile declaring `queuesBusyInput` adds `steer` and
 *                       must type it, so the corpus's steer properties, not
 *                       this list, judge that profile.
 *   `opencode-server` — measured at 1.18.16: a prompt POSTed into an open turn
 *                       becomes a SECOND turn that runs afterwards. See the
 *                       `no-native-steer` doc comment above.
 *
 * MEASURED HERE: `claude-sdk` exposes `interrupt()` and resumable turns, but no
 * in-flight steer verb; its conformance target therefore reports a visible queue
 * downgrade. ABSENT ON PURPOSE: `codex-app-server` has `turn/steer` and must
 * declare it. POD-3741 measured claude-pty declining native steer: the hooked
 * terminal still has no in-flight append verb, just like generic-pty.
 */
export const NO_NATIVE_STEER_DRIVERS = [
  'generic-pty',
  // The Agent SDK exposes interrupt-and-resend/queueing, not an in-flight steer verb.
  'claude-sdk',
  'opencode-server',
  // ACP exposes prompt queueing and cancel, but no in-flight steer method.
  'grok-acp',
] as const satisfies readonly DriverId[]

/**
 * THE TUIS `generic-pty` MAY DECLINE STEER FOR (POD-5855). Every terminal
 * harness shares that one driver id, and whether a TUI takes a prompt entered
 * mid-turn into its own queue is a per-harness measurement
 * (`runtime.terminal.queuesBusyInput`). These are the ones nobody has measured
 * doing so: Cursor cannot run past the submit against a fake model, and Pi was
 * not installed for the POD-4834 runs. `fake-harness` is the corpus's own
 * synthetic TUI, which models no mid-turn queue.
 */
export const NO_NATIVE_STEER_TERMINAL_HARNESSES = ['cursor', 'pi', 'fake-harness'] as const

/** `harness` narrows the `generic-pty` entitlement to the TUIs above; a caller
 *  that names none asks about the driver id alone. */
export const permitsNoNativeSteer = (driverId: AcceptedDriverId, harness?: string): boolean => {
  const id = canonicalDriverId(driverId)
  if (!(NO_NATIVE_STEER_DRIVERS as readonly DriverId[]).includes(id)) return false
  return id !== 'generic-pty' || harness === undefined ||
    (NO_NATIVE_STEER_TERMINAL_HARNESSES as readonly string[]).includes(harness)
}

/**
 * WHICH DRIVERS MAY ACTUALLY TAKE `no-attach` (POD-4612).
 *
 * The server row carries `no-attach` since the Claude stream engine joined the
 * family, so `permits('server', 'no-attach')` stopped answering anything about
 * codex, opencode or grok — each of which has a stock TUI and must keep
 * declaring it. The entitlement is pinned per driver for the reason
 * {@link NO_NATIVE_STEER_DRIVERS} gives: declining attach becomes an edit
 * somebody makes on purpose, never a default a new server driver inherits.
 *
 *   `claude-sdk` — the stream-json engine is a pipe pair under podium-host; the
 *                  `claude` TUI cannot join a conversation a second process is
 *                  driving, so there is no client terminal to produce.
 */
export const NO_ATTACH_DRIVERS = ['claude-sdk'] as const satisfies readonly DriverId[]

export const permitsNoAttach = (driverId: AcceptedDriverId): boolean =>
  (NO_ATTACH_DRIVERS as readonly DriverId[]).includes(canonicalDriverId(driverId))
