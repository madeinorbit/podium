/**
 * `drivers/terminal` — the APP-INDEPENDENT half of the terminal driver
 * (POD-1761 W3).
 *
 * THE SPLIT, AND WHY IT IS WHERE IT IS. `packages/agent-runtime` may not import
 * daemon app code (nothing at L2 may import an app), and the terminal driver's
 * concrete implementation is composed almost entirely of daemon internals —
 * `control/session.ts`'s spawn path, `session-observers.ts`'s fan-out,
 * `binding-store.ts`, `handoff-package.ts`, composer-sync. So:
 *
 *   - HERE: the receipt state machine, the envelope assembly, the capability
 *     declaration, the exemption table — everything that is a fact about the
 *     FAMILY rather than about this daemon.
 *   - `apps/daemon/src/runtime/terminal-driver.ts`: the `RuntimeDriver` itself,
 *     composing the above with real daemon ports.
 *
 * The line is not bureaucratic: the pieces here are exactly the pieces a second
 * terminal host (a cloud runner, a test harness) would need unchanged, and the
 * pieces there are exactly the ones it would have to supply itself.
 */

export {
  RAW_FIRST_TURN_ATTACHMENT_REFUSAL,
  type TerminalCapabilityInput,
  terminalCapabilities,
} from './capabilities.js'
export {
  cursorSeq,
  driverLocalCursor,
  isDriverLocalCursor,
  type ObservationCheckpoint,
  stampRuntimeEvent,
} from './envelope.js'
export {
  createTerminalInjection,
  type DeliverOptions,
  ESC,
  type HookAcceptPort,
  type HookAcceptWatch,
  QUEUE_DRAIN_DEADLINE_MS,
  QUEUE_MESSAGE_SPACING_MS,
  type QueueDrainAbandonedReason,
  type QueuedTurn,
  READY_FLOOR_MS,
  READY_MAX_MS,
  READY_POLL_MS,
  READY_QUIET_MS,
  SUBMIT_CR_DELAY_MS,
  SUBMIT_MAX_RETRIES,
  SUBMIT_VERIFY_DELAY_MS,
  type TerminalInjectionMachine,
  type TerminalInjectionPorts,
  type TimerHandle,
  VERIFICATION_WINDOW_MS,
} from './injection.js'
export {
  TERMINAL_EXEMPTION_NAMES,
  TERMINAL_PERMITTED_FAILURES,
} from './permitted-failures.js'
