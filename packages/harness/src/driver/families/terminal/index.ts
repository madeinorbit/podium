/**
 * `drivers/terminal` — the terminal family's RuntimeDriver (POD-1761 W3,
 * moved into the harness package in POD-4785).
 *
 * THE WHOLE DRIVER LIVES HERE. The receipt state machine, envelope assembly,
 * capability declaration, exemption table, injection machine, instrumentation,
 * mail boundary — and the RuntimeDriver itself (`./runtime.js`), composed
 * with daemon capabilities through `TerminalHostPorts` (`./host-ports.js`).
 * The daemon keeps only wiring (`apps/daemon/src/runtime/host.ts`).
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
  type AcceptPort,
  type AcceptSeen,
  type AcceptWatch,
  type Disproof,
  createTerminalInjection,
  DEFAULT_TERMINAL_INTERRUPT,
  type DeliverOptions,
  type EchoAcceptPort,
  ESC,
  type HookAcceptPort,
  type HookAcceptWatch,
  LATE_PROOF_WAIT_MS,
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
  type TerminalWriteRole,
  type TerminalInterruptConfig,
  type TimerHandle,
  VERIFICATION_WINDOW_MS,
} from './injection.js'
export {
  closesPasteEnvelope,
  type InjectionPayload,
  injectionPayload,
  PASTE_ENVELOPE,
  sanitizeForInjection,
} from './paste.js'
export {
  TERMINAL_EXEMPTION_NAMES,
  TERMINAL_PERMITTED_FAILURES,
} from './permitted-failures.js'
export {
  type TerminalHostPorts,
  type TerminalDriverReport,
  type TerminalForeignWrites,
  type TerminalReattachControl,
  type TerminalSpawnControl,
  type TerminalTransport,
  type TerminalMailBoundaryContext,
} from './host-ports.js'
export {
  type MailBoundaryContext,
  MAIL_BOUNDARY_OPTIONS,
  createMailContinuation,
  respondToMailBoundary,
} from './mail-boundary.js'
export {
  EVENT_LOG_LIMIT,
  type TerminalHarnessProfile,
  type TerminalRuntime,
  type TerminalRuntimeControl,
  type TerminalSessionRegistration,
  type TerminalStateObservation,
  TerminalRecoveryRefusal,
  createTerminalRuntime,
  stateEventForObservation,
  turnEventForObservation,
} from './runtime.js'
