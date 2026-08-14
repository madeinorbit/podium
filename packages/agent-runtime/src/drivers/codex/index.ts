/**
 * `drivers/codex` — THE SECOND SERVER-FAMILY DRIVER (POD-1761 W6).
 *
 * THE SPLIT MIRRORS `../opencode` FILE FOR FILE, because the plan asks it to and
 * because the shape fits: protocol shapes, a client, a pure mapping layer, a
 * version gate, a capability declaration, and a runtime that composes them. The
 * one thing a package may not do — spawn `codex app-server` and write its
 * binding journal — lives in `apps/daemon/src/runtime/codex-app-server.ts` and
 * is reached only through {@link CodexRuntimeHost}.
 *
 * WHERE IT DIVERGES FROM W5, IT DIVERGES FOR A MEASURED REASON, and each one is
 * argued at the place a reader meets its consequence:
 *
 *   - The transport is the CHILD'S STDIO, not a socket. `--listen unix://` exists
 *     on the pinned binary and creates a 0600 socket, but that socket is a
 *     daemon CONTROL plane: it closes the connection on a JSON-RPC `initialize`,
 *     and so does the first-party `app-server proxy` bridge. See ./client.ts.
 *   - `adopt()` RESUMES rather than rebinds, because `codex app-server` exits on
 *     stdin EOF and therefore cannot outlive the daemon. See ./runtime.ts.
 *   - The transcript mapper is NEW rather than reused, because the app-server's
 *     `ThreadItem` vocabulary is not the rollout-JSONL vocabulary that
 *     `packages/transcript`'s codex mapper parses. See ./map.ts.
 *   - Interactions are ANSWERED BY RESPONDING TO A BLOCKED REQUEST, not by a
 *     side-channel reply, so there is no server reconciliation to do: the asks
 *     this driver holds are the open requests on a pipe it owns.
 */

export { codexAppServerCapabilities } from './capabilities.js'
export {
  type CodexClient,
  type CodexClientConfig,
  type CodexServerRequest,
  type CodexTransport,
  createCodexClient,
} from './client.js'
/**
 * THREE OF THESE ARE RENAMED ON THE WAY OUT, and the rename is not cosmetic.
 *
 * `answerAction`, `statusToStateEvent` and `idleToStateEvent` are the natural
 * names for what they do, and the opencode driver has functions with exactly the
 * same names doing the same job for a different protocol. The package root
 * re-exports both drivers with `export *`, so the unprefixed names would collide
 * there — and TypeScript's resolution for that is to drop BOTH, which turns a
 * naming clash into two silently missing exports. Prefixing here keeps the
 * file-local names honest (inside ./map.ts there is only one protocol) while
 * making the package surface unambiguous.
 */
export {
  answerAction as codexAnswerAction,
  askIdOf,
  type CodexAnswerAction,
  commandApprovalAsk,
  describeTurnError,
  elicitationAsk,
  fileChangeApprovalAsk,
  idleToStateEvent as codexIdleToStateEvent,
  permissionsApprovalAsk,
  statusToStateEvent as codexStatusToStateEvent,
  threadItemToItems,
  turnStatusToVerdict,
} from './map.js'
export {
  CHATGPT_AUTH_METHOD,
  CODEX_METHODS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUESTS,
  type CodexApprovalDecision,
  type CodexAuthStatus,
  type CodexFrame,
  type CodexInitializeParams,
  type CodexNotification,
  CodexProtocolError,
  CodexRpcError,
  type CodexThread,
  type CodexThreadId,
  type CodexThreadItem,
  type CodexThreadStatus,
  type CodexTurn,
  type CodexTurnId,
  type CodexTurnStatus,
  DELTA_NOTIFICATIONS,
  offersDecision,
  parseCodexNotification,
  WAITING_ON_APPROVAL_FLAG,
} from './protocol.js'
export {
  CODEX_APP_SERVER_DRIVER_ID,
  CODEX_EVENT_LOG_LIMIT,
  type CodexJournal,
  type CodexJournalEntry,
  type CodexRuntime,
  type CodexRuntimeHost,
  type CodexServerEndpoint,
  createCodexRuntime,
} from './runtime.js'
export {
  type CodexVersion,
  type CodexVersionDiagnostic,
  gateCodexVersion,
  parseCodexVersion,
  supportsCodexAppServerDriver,
  SUPPORTED_CODEX,
} from './version.js'
export {
  CODEX_SERVER_EXEMPTION_NAMES,
  CODEX_SERVER_EXHIBITED_FAILURES,
  CODEX_SERVER_PERMITTED_FAILURES,
} from './permitted-failures.js'
