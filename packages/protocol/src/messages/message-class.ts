import type { ClientMessage } from './client'
import type { ControlMessage } from './control'
import type { DaemonMessage } from './daemon'
import type { ServerMessage } from './server'

/**
 * The offline-sync entity taxonomy (docs/offline-sync-architecture.md §5),
 * encoded in the TYPE system so a message's sync class is explicit and can't
 * drift as new message types are added. Every `..._MESSAGE_CLASS` table below
 * is a `satisfies Record<Union['type'], MessageSyncClass>` — TOTAL over its
 * union, so adding a message type without classifying it here is a compile
 * error. This is the ONE canonical home for the classification: both
 * apps/server (funnel/fan-out gating) and clients (offline-capability UI)
 * import from here rather than keeping their own copies.
 *
 * - `durable` — carries entity truth a reconnecting client must be able to
 *   recover (session/issue/conversation snapshots+deltas, and the small
 *   durable-synced fields like drafts/snoozes/pins). Durable ServerMessages
 *   may ONLY be produced by the write funnel's publish tail (modules/funnel —
 *   oplog append before fan-out) so `sync.changesSince` never has a hole.
 * - `live` — a genuinely ephemeral stream or connection-scoped frame
 *   (terminal output, spinner-rate title/state updates, host metrics,
 *   machine liveness, attention toasts, keepalives). Loss on disconnect is
 *   fine — the durable truth either doesn't exist or arrives via a later
 *   durable snapshot/delta.
 * - `command` — a plain request/reply RPC that requires a live path to the
 *   daemon (spawn/kill/attach, resize, file ops, harness exec). Nothing to
 *   recover; the UI simply disables the affected action while offline.
 * - `bulk` — the transcript/blob channel: large, paged, lazily synced on its
 *   own channel — never fanned out or oplog-replayed like the other classes.
 */
export const MESSAGE_SYNC_CLASSES = ['durable', 'live', 'command', 'bulk'] as const
export type MessageSyncClass = (typeof MESSAGE_SYNC_CLASSES)[number]

/**
 * Server→client message classification (issue #190; generalized #194).
 * Durable messages may ONLY be produced by the write funnel; a raw fan-out of
 * one of these is a bug. Live messages are fanned out raw via
 * {@link LiveServerMessage}-typed sends.
 */
export const SERVER_MESSAGE_CLASS = {
  // Durable entity snapshots/deltas — funnel-only.
  sessionsChanged: 'durable',
  issuesChanged: 'durable',
  issueUpdated: 'durable',
  conversationsChanged: 'durable',
  automationsChanged: 'durable',
  automationRunsChanged: 'durable',
  metadataDelta: 'durable',

  // Connection-scoped handshake/keepalive frames (single client, not fan-out).
  welcome: 'live',
  attached: 'live',
  pong: 'live',

  // Ephemeral per-session streams: the durable truth lands in the next
  // sessionsChanged / transcript lake read; these only keep open views hot.
  outputFrame: 'live',
  transcriptDelta: 'live',
  controllerChanged: 'live',
  geometry: 'live',
  agentExit: 'live',
  sessionTitleChanged: 'live',
  sessionAgentStateChanged: 'live',
  sessionDraftChanged: 'live',
  headlessActivity: 'live',

  // Advisory broadcasts re-served in full on attach — not (yet) oplog entities.
  // machinesChanged is a candidate for a durable entity kind; that is a
  // deliberate follow-up, not a silent reclassification here.
  machinesChanged: 'live',
  hostMetricsChanged: 'live',
  attentionEvent: 'live',
  // One-shot invalidation (POD-665): unlike the advisory broadcasts above, this is
  // NOT re-served on attach — the client already fetches repos at boot, so a missed
  // push is caught by that, not by a reconnect replay.
  worktreesChanged: 'live',
  // Approval-broker snapshot (small pending list) — re-broadcast on change and
  // on attach; not an oplog entity.
  approvalsChanged: 'live',
  sessionOpenUrl: 'live',
  sessionOpenUrlResult: 'live',
} as const satisfies Record<ServerMessage['type'], 'durable' | 'live'>

/** The message types a raw (non-funnel) send may carry. */
export type LiveMessageType = {
  [K in keyof typeof SERVER_MESSAGE_CLASS]: (typeof SERVER_MESSAGE_CLASS)[K] extends 'live'
    ? K
    : never
}[keyof typeof SERVER_MESSAGE_CLASS]

/** A ServerMessage that is classified live-only — the ONLY shape accepted by
 *  the raw client fan-out helpers. Durable messages fail this type. */
export type LiveServerMessage = Extract<ServerMessage, { type: LiveMessageType }>

/** Browser→server classification. Command frames need a live server (and, for
 *  attach/input/resize, a live daemon); `setSessionDraft` is the one durable-
 *  synced write on this union (drafts are a durable+synced entity per the
 *  offline-sync doc); the rest are connection-scoped or bulk-channel frames. */
export const CLIENT_MESSAGE_CLASS = {
  hello: 'command',
  attach: 'command',
  detach: 'command',
  input: 'command',
  resize: 'command',
  requestControl: 'command',
  redrawRequest: 'command',
  ping: 'live',
  presence: 'live',
  viewState: 'live',
  transcriptSubscribe: 'bulk',
  transcriptUnsubscribe: 'bulk',
  setSessionDraft: 'durable',
  sessionOpenUrlCallback: 'command',
  sessionOpenUrlDismiss: 'command',
} as const satisfies Record<ClientMessage['type'], MessageSyncClass>

/** Server→daemon classification. Almost everything here is a command RPC
 *  (spawn/kill/attach, resize, file ops, harness exec — docs/offline-sync-
 *  architecture.md §5's "Command RPCs" row); the transcript reads are the
 *  bulk channel. */
export const CONTROL_MESSAGE_CLASS = {
  repoOpRequest: 'command',
  handoffExportRequest: 'command',
  handoffChunkReadRequest: 'command',
  handoffImportChunk: 'command',
  handoffImportRequest: 'command',
  workspaceExportRequest: 'command',
  workspaceImportRequest: 'command',
  workspaceCleanRequest: 'command',
  agentRelayResult: 'command',
  harnessExecRequest: 'command',
  headlessTurnRequest: 'command',
  headlessInterrupt: 'command',
  headlessTurnAck: 'command',
  headlessBind: 'command',
  usageRequest: 'command',
  agentQuotaRequest: 'command',
  imageUploadRequest: 'command',
  spawn: 'command',
  reattach: 'command',
  kill: 'command',
  sessionResumeRefAck: 'command',
  transcriptMirrorRead: 'bulk',
  sessionPriority: 'command',
  scanRequest: 'command',
  scanReposRequest: 'command',
  browseDirsRequest: 'command',
  input: 'command',
  resize: 'command',
  redraw: 'command',
  memoryBreakdownRequest: 'command',
  inventoryRequest: 'command',
  transcriptRead: 'bulk',
  fileReadRequest: 'command',
  fileAssetRequest: 'command',
  fileWriteRequest: 'command',
  dirListRequest: 'command',
  approvalExecRequest: 'command',
  sessionOpenUrlCallback: 'command',
  sessionOpenUrlDismiss: 'command',
} as const satisfies Record<ControlMessage['type'], MessageSyncClass>

/** Daemon→server classification. PTY/agent-runtime streams are `live` (mirrors
 *  the ServerMessage classification for the same shared types — agentExit,
 *  transcriptDelta); RPC replies are `command`; transcript paging/mirroring is
 *  `bulk`; conversationsChanged is `durable` (shared with ServerMessage — the
 *  daemon's discovery push feeds the same durable conversation registry). */
export const DAEMON_MESSAGE_CLASS = {
  repoOpResult: 'command',
  handoffExportResult: 'command',
  handoffChunkReadResult: 'command',
  handoffImportChunkResult: 'command',
  handoffImportResult: 'command',
  workspaceExportResult: 'command',
  workspaceImportResult: 'command',
  workspaceCleanResult: 'command',
  agentRelayRequest: 'command',
  harnessExecResult: 'command',
  headlessTurnEvent: 'command',
  headlessTurnResult: 'command',
  headlessBindResult: 'command',
  usageResult: 'command',
  agentQuotaResult: 'command',
  imageUploadResult: 'command',
  sessionResumeRef: 'command',
  sessionCwd: 'command',
  inventoryReport: 'command',
  bind: 'live',
  agentFrame: 'live',
  agentFrameBatch: 'live',
  agentExit: 'live',
  spawnError: 'command',
  reattachFailed: 'command',
  title: 'live',
  agentState: 'live',
  agentColor: 'live',
  scanResult: 'command',
  conversationsChanged: 'durable',
  scanReposResult: 'command',
  browseDirsResult: 'command',
  transcriptMirrorResult: 'bulk',
  hostMetrics: 'live',
  memoryBreakdownResult: 'command',
  transcriptDelta: 'live',
  transcriptReadResult: 'bulk',
  fileReadResult: 'command',
  fileAssetResult: 'command',
  fileWriteResult: 'command',
  dirListResult: 'command',
  approvalExecResult: 'command',
  sessionOpenUrl: 'live',
  sessionOpenUrlResult: 'live',
} as const satisfies Record<DaemonMessage['type'], MessageSyncClass>
