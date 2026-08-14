/**
 * `drivers/opencode` — THE SERVER-FAMILY DRIVER (POD-1761 W5, the epic's goal).
 *
 * THE SPLIT MIRRORS `../terminal`, and lands on the opposite side of it. The
 * terminal driver's concrete half had to live in the daemon because it is
 * composed of daemon internals; this driver's concrete half lives HERE, because
 * it is composed of HTTP and SSE and nothing else. What stayed in the daemon is
 * the one thing a package may not do: spawn `opencode serve` under a systemd
 * transient scope, allocate its port, and write its binding journal — reached
 * only through {@link OpencodeRuntimeHost}.
 *
 * That is why this is the epic's first fully headless, deterministic driver:
 * everything a conformance property touches runs in-process against a fake
 * opencode server built from RECORDED frames, with no PTY, no timing ladder and
 * no live model.
 */

export { opencodeServerCapabilities } from './capabilities.js'
export {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
  OpencodeHttpError,
} from './client.js'
export {
  answerAction,
  deltaItemIdOf,
  idleToStateEvent,
  type OpencodeAnswerAction,
  partToItems,
  permissionAsk,
  questionAsk,
  statusToStateEvent,
} from './map.js'
export {
  eventSessionId,
  eventTimeMs,
  OPENCODE_EVENT_ARMS,
  type OpencodeEvent,
  type OpencodeEventType,
  type OpencodeMessageInfo,
  type OpencodeMessageWithParts,
  type OpencodePart,
  type OpencodePermissionReply,
  type OpencodePermissionRule,
  type OpencodePromptBody,
  type OpencodeQuestionAnswers,
  type OpencodeQuestionInfo,
  OpencodeProtocolError,
  OpencodeSession,
  type OpencodeSessionId,
  type OpencodeSessionStatus,
  parseOpencodeEvent,
} from './protocol.js'
export {
  createOpencodeRuntime,
  OPENCODE_EVENT_LOG_LIMIT,
  OPENCODE_SERVER_DRIVER_ID,
  type OpencodeJournal,
  type OpencodeJournalEntry,
  type OpencodeRuntime,
  type OpencodeRuntimeHost,
  type OpencodeServerEndpoint,
} from './runtime.js'
export {
  gateOpencodeVersion,
  type OpencodeVersion,
  type OpencodeVersionDiagnostic,
  parseOpencodeVersion,
  SUPPORTED_OPENCODE,
  supportsOpencodeServerDriver,
} from './version.js'
export {
  SERVER_EXEMPTION_NAMES,
  SERVER_PERMITTED_FAILURES,
} from './permitted-failures.js'
