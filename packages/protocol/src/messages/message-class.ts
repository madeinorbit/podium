import { type PlaneClass, SYNC_CLASS_OF_PLANE_CLASS, type SyncClassOf } from '../planes/plane'
import type { ClientMessage } from './client'
import type { ControlMessage } from './control'
import type { DaemonMessage } from './daemon'
import type { ServerMessage } from './server'

/**
 * THE defining classification source for the wire — now in ADR 7's plane·class
 * vocabulary (`docs/adr/0007-plane-inventory.md` D1, D6; Amendment 1 D16).
 *
 * Every `*_PLANE_CLASS` table below is a `satisfies Record<Union['type'],
 * PlaneClass>` — TOTAL over its union, so adding a message type without
 * classifying it is a compile error. Each message type maps to EXACTLY ONE
 * plane·class; a semantic field may still appear on frames of two different
 * classes (ADR 7 D3/D4/D5's dual delivery), which is a property of fields, not
 * of message types.
 *
 * The three planes:
 *
 * - `control.entity` — entity truth a reconnecting replica must recover
 *   (session/issue/conversation snapshots + deltas, drafts). Funnel-only (oplog
 *   append before fan-out) so `sync.changesSince` never has a hole; routed
 *   per principal under the scoped feed (ADR 2 Amendment 1 D12, ADR 7
 *   Amendment 1 D15).
 * - `control.command` — directed request/reply with a correlated requestId,
 *   requiring a live path unless the command is offline-class (ADR 3 D4).
 *   COMMAND IS A CLASS ON THE CONTROL PORT, NOT A FOURTH PLANE (D1).
 * - `control.handshake` — pre-auth, once per connection (ADR 5); the frames
 *   live in `daemon-handshake.ts` and are classified in `planes/inventory.ts`,
 *   outside the four post-auth unions.
 * - `stream.live` — genuinely ephemeral / connection-scoped / hot frames.
 *   Loss on disconnect is fine: the durable truth either does not exist or
 *   arrives via a later entity snapshot/delta. Never healed, blank offline.
 * - `bulk.bulk` — the transcript/blob channel: large, paged, lazily synced on
 *   its own channel; never fanned out or oplog-replayed as entity rows.
 *
 * The legacy four-label `MessageSyncClass` vocabulary is DERIVED from these
 * tables through ADR 7 D1's bridge (`durable`→`control.entity`,
 * `command`→`control.command`, `live`→`stream.live`, `bulk`→`bulk.bulk`) for the
 * one migration window ADR 7's "Costs" section allows. Do not add a classifi-
 * cation to a legacy table: it is a projection, not a source.
 */
export const MESSAGE_SYNC_CLASSES = ['durable', 'live', 'command', 'bulk'] as const
export type MessageSyncClass = (typeof MESSAGE_SYNC_CLASSES)[number]

/** Server→client. Entity frames may ONLY be produced by the write funnel. */
export const SERVER_PLANE_CLASS = {
  // WIRE v1 full-list entity snapshots. Their CLASS is unchanged — they are
  // still entity truth a replica recovers — but their PRODUCER is not: after
  // POD-308 no module builds them. The legacy v1 edge adapter synthesises them
  // from feed frames at the connection boundary, so they are a translation of
  // the one pipeline rather than a second pipeline beside it, and they are
  // deleted when that adapter expires.
  sessionsChanged: 'control.entity',
  issuesChanged: 'control.entity',
  issueUpdated: 'control.entity',
  conversationsChanged: 'control.entity',
  automationsChanged: 'control.entity',
  automationRunsChanged: 'control.entity',
  // WIRE v1 (pre-cutover) oplog batch. Still classified because the frame still
  // EXISTS — but after POD-308 nothing in the server produces it except the
  // legacy v1 edge adapter, and it leaves with that adapter. Its covered range
  // (`fromExclusive`) is OPTIONAL, which is why it could not become the scoped
  // feed's frame: see `./feed.ts`.
  metadataDelta: 'control.entity',

  // WIRE v2 (POD-308) — the scoped feed on the wire. All four are control.entity
  // and none may ever be stream: a lost rescope or a lost watermark is a
  // permanent invisible gap, which is the failure ADR 2 D2 documents and ADR 7
  // Amendment 1 D16.3 classifies against.
  feedDelta: 'control.entity',
  feedBootstrap: 'control.entity',
  feedRescope: 'control.entity',
  feedResyncRequired: 'control.entity',

  // Connection-scoped handshake/keepalive frames (single client, not fan-out).
  welcome: 'stream.live',
  attached: 'stream.live',
  pong: 'stream.live',
  // Authority-only view removal; ordered on one client publication sequencer.
  sessionViewDelta: 'stream.live',

  // Ephemeral per-session streams: the durable truth lands in the next
  // sessionsChanged / transcript lake read; these only keep open views hot.
  outputFrame: 'stream.live',
  transcriptDelta: 'stream.live',
  controllerChanged: 'stream.live',
  geometry: 'stream.live',
  agentExit: 'stream.live',
  // ADR 7 D3: the OSC/terminal title fires at spinner rates, so the MESSAGE is
  // stream; the same semantic field on SessionMeta is control.entity.
  sessionTitleChanged: 'stream.live',
  // ADR 7 D4: dual delivery, same argument — hook events are frequent, and a
  // full sessionsChanged rebroadcast is O(sessions × clients).
  sessionAgentStateChanged: 'stream.live',
  // ADR 7 D5: keystroke volume; durable recovery via the entity path.
  sessionDraftChanged: 'stream.live',
  headlessActivity: 'stream.live',

  // Advisory broadcasts re-served in full on attach — not (yet) oplog entities.
  // machinesChanged is a candidate for a durable entity kind; promoting it is an
  // ADR 7 D6 amendment, not a silent reclassification here.
  machinesChanged: 'stream.live',
  hostMetricsChanged: 'stream.live',
  attentionEvent: 'stream.live',
  // One-shot invalidation (POD-665): NOT re-served on attach — the client
  // already fetches repos at boot, so a missed push is caught by that.
  worktreesChanged: 'stream.live',
  // Approval-broker snapshot (small pending list) — re-broadcast on change and
  // on attach; not an oplog entity.
  approvalsChanged: 'stream.live',
  // Browser-open family (ADR 7 D8, [spec:SP-a43e]).
  sessionOpenUrl: 'stream.live',
  sessionOpenUrlResult: 'stream.live',
  // ADR 7 Amendment 1 D16.2. A room dies with the connection; snapshots,
  // deltas and the deliberately non-distinguishing close frame are all live.
  presenceRoomState: 'stream.live',
  presenceRoomDelta: 'stream.live',
  presenceRoomClosed: 'stream.live',
} as const satisfies Record<ServerMessage['type'], 'control.entity' | 'stream.live'>

/**
 * Browser→server. Command frames need a live server (and, for attach/input/
 * resize, a live daemon); the draft writes are the durable-synced entity writes
 * on this union (ADR 7 D5); the rest are connection-scoped or bulk-channel.
 */
export const CLIENT_PLANE_CLASS = {
  hello: 'control.command',
  attach: 'control.command',
  detach: 'control.command',
  input: 'control.command',
  resize: 'control.command',
  requestControl: 'control.command',
  redrawRequest: 'control.command',
  ping: 'stream.live',
  // Today's anonymous page-visibility bit. ADR 7 Amendment 1 D9.5: it maps
  // FORWARD as a reserved field on the identity-carrying presence record and is
  // retained as a compatibility alias through the POD-308 window, then deleted.
  // It must not survive as a parallel frame beside room presence.
  presence: 'stream.live',
  viewState: 'stream.live',
  transcriptSubscribe: 'bulk.bulk',
  transcriptUnsubscribe: 'bulk.bulk',
  setSessionDraft: 'control.entity',
  // Draft Sync v2 (POD-859): the versioned sibling of setSessionDraft — same
  // durable+synced draft entity, just with optimistic-concurrency baseRev.
  draftEdit: 'control.entity',
  sessionOpenUrlCallback: 'control.command',
  sessionOpenUrlDismiss: 'control.command',
  // ADR 7 Amendment 1 D16.1. Rooms are subscriptions inside stream, not a
  // fourth plane and not command RPCs even when a subscribe carries a token.
  presenceSubscribe: 'stream.live',
  presenceUnsubscribe: 'stream.live',
  presenceUpdate: 'stream.live',
} as const satisfies Record<ClientMessage['type'], PlaneClass>

/**
 * Server→daemon. Almost everything is a command RPC (spawn/kill/attach, resize,
 * file ops, harness exec); the transcript reads are the bulk channel. The
 * structured file RPCs stay command class: they are correlated request/reply, not
 * a standing paged channel (ADR 7 D6.3).
 */
export const CONTROL_PLANE_CLASS = {
  credentialExportRequest: 'control.command',
  credentialInstallRequest: 'control.command',
  repoOpRequest: 'control.command',
  // Handoff family (ADR 7 D7): bulk MECHANICS on the chunk frames, command
  // CLASS throughout — one correlated export/import state machine.
  handoffExportRequest: 'control.command',
  handoffChunkReadRequest: 'control.command',
  handoffImportChunk: 'control.command',
  handoffImportRequest: 'control.command',
  handoffBindingFinalizeRequest: 'control.command',
  workspaceExportRequest: 'control.command',
  workspaceImportRequest: 'control.command',
  workspaceCleanRequest: 'control.command',
  // AGENT RELAY ONLY (ADR 7 D2 / port-rule.ts).
  agentRelayResult: 'control.command',
  harnessExecRequest: 'control.command',
  headlessTurnRequest: 'control.command',
  headlessInterrupt: 'control.command',
  headlessTurnAck: 'control.command',
  headlessBind: 'control.command',
  usageRequest: 'control.command',
  agentQuotaRequest: 'control.command',
  imageUploadRequest: 'control.command',
  spawn: 'control.command',
  reattach: 'control.command',
  agentObservationAck: 'control.command',
  agentObservationRebindAck: 'control.command',
  kill: 'control.command',
  // Draft Sync v2 (POD-859): server→daemon "inject this chat draft into native".
  draftTarget: 'control.command',
  // Host channel, NOT the agent relay ([spec:SP-fccf], ADR 7 D2).
  sessionResumeRefAck: 'control.command',
  transcriptMirrorRead: 'bulk.bulk',
  sessionPriority: 'control.command',
  scanRequest: 'control.command',
  scanReposRequest: 'control.command',
  browseDirsRequest: 'control.command',
  input: 'control.command',
  resize: 'control.command',
  redraw: 'control.command',
  memoryBreakdownRequest: 'control.command',
  inventoryRequest: 'control.command',
  transcriptRead: 'bulk.bulk',
  fileReadRequest: 'control.command',
  fileAssetRequest: 'control.command',
  fileWriteRequest: 'control.command',
  dirListRequest: 'control.command',
  approvalExecRequest: 'control.command',
  sessionOpenUrlCallback: 'control.command',
  sessionOpenUrlDismiss: 'control.command',
} as const satisfies Record<ControlMessage['type'], PlaneClass>

/**
 * Daemon→server. PTY/agent-runtime streams are stream·live (mirroring the
 * ServerMessage classification for the same shared types — agentExit,
 * transcriptDelta); RPC replies are control·command; transcript paging/mirroring
 * is bulk; conversationsChanged is control·entity (the daemon's discovery push
 * feeds the same durable conversation registry).
 */
export const DAEMON_PLANE_CLASS = {
  credentialExportResult: 'control.command',
  credentialInstallResult: 'control.command',
  repoOpResult: 'control.command',
  handoffExportResult: 'control.command',
  handoffChunkReadResult: 'control.command',
  handoffImportChunkResult: 'control.command',
  handoffImportResult: 'control.command',
  handoffBindingFinalizeResult: 'control.command',
  workspaceExportResult: 'control.command',
  workspaceImportResult: 'control.command',
  workspaceCleanResult: 'control.command',
  // AGENT RELAY ONLY (ADR 7 D2 / port-rule.ts).
  agentRelayRequest: 'control.command',
  harnessExecResult: 'control.command',
  headlessTurnEvent: 'control.command',
  headlessTurnResult: 'control.command',
  headlessBindResult: 'control.command',
  usageResult: 'control.command',
  agentQuotaResult: 'control.command',
  imageUploadResult: 'control.command',
  // Pairs with sessionResumeRefAck — host channel (ADR 7 D2).
  sessionResumeRef: 'control.command',
  sessionCwd: 'control.command',
  sessionGitActivity: 'control.command',
  // Draft Sync v2 (POD-859): the daemon's scraped native composer — a live
  // runtime stream the server sequences into a durable draft edit.
  nativeDraft: 'stream.live',
  inventoryReport: 'control.command',
  bind: 'stream.live',
  agentFrame: 'stream.live',
  agentFrameBatch: 'stream.live',
  agentExit: 'stream.live',
  spawnError: 'control.command',
  reattachFailed: 'control.command',
  title: 'stream.live',
  agentState: 'stream.live',
  agentObservation: 'stream.live',
  agentObserverLiveConfirmation: 'stream.live',
  agentObservationRebind: 'control.command',
  agentColor: 'stream.live',
  agentModel: 'stream.live',
  scanResult: 'control.command',
  conversationsChanged: 'control.entity',
  scanReposResult: 'control.command',
  browseDirsResult: 'control.command',
  transcriptMirrorResult: 'bulk.bulk',
  hostMetrics: 'stream.live',
  memoryBreakdownResult: 'control.command',
  transcriptDelta: 'stream.live',
  transcriptReadResult: 'bulk.bulk',
  fileReadResult: 'control.command',
  fileAssetResult: 'control.command',
  fileWriteResult: 'control.command',
  dirListResult: 'control.command',
  approvalExecResult: 'control.command',
  sessionOpenUrl: 'stream.live',
  sessionOpenUrlResult: 'stream.live',
} as const satisfies Record<DaemonMessage['type'], PlaneClass>

// ---- Derived legacy vocabulary (ADR 7 D1 bridge; one migration window) ------

type SyncClassTable<T extends Record<string, PlaneClass>> = {
  [K in keyof T]: SyncClassOf<T[K]>
}

const toSyncClasses = <T extends Record<string, PlaneClass>>(table: T): SyncClassTable<T> =>
  Object.fromEntries(
    Object.entries(table).map(([type, planeClass]) => [
      type,
      SYNC_CLASS_OF_PLANE_CLASS[planeClass],
    ]),
  ) as SyncClassTable<T>

/** @deprecated Derived from {@link SERVER_PLANE_CLASS}; classify there. */
export const SERVER_MESSAGE_CLASS = toSyncClasses(SERVER_PLANE_CLASS) satisfies Record<
  ServerMessage['type'],
  'durable' | 'live'
>

/** @deprecated Derived from {@link CLIENT_PLANE_CLASS}; classify there. */
export const CLIENT_MESSAGE_CLASS = toSyncClasses(CLIENT_PLANE_CLASS) satisfies Record<
  ClientMessage['type'],
  MessageSyncClass
>

/** @deprecated Derived from {@link CONTROL_PLANE_CLASS}; classify there. */
export const CONTROL_MESSAGE_CLASS = toSyncClasses(CONTROL_PLANE_CLASS) satisfies Record<
  ControlMessage['type'],
  MessageSyncClass
>

/** @deprecated Derived from {@link DAEMON_PLANE_CLASS}; classify there. */
export const DAEMON_MESSAGE_CLASS = toSyncClasses(DAEMON_PLANE_CLASS) satisfies Record<
  DaemonMessage['type'],
  MessageSyncClass
>

/**
 * The message types a raw (non-funnel) send may carry: exactly the stream-plane
 * ones. Under ADR 7 Amendment 1 D15 the recipient set is a NAMED ROUTING SET,
 * so "raw" here means "not funnelled", never "to every connected client".
 */
export type LiveMessageType = {
  [K in keyof typeof SERVER_PLANE_CLASS]: (typeof SERVER_PLANE_CLASS)[K] extends 'stream.live'
    ? K
    : never
}[keyof typeof SERVER_PLANE_CLASS]

/** A ServerMessage on the stream plane — the ONLY shape the raw client fan-out
 *  helpers accept. Control-plane messages fail this type. */
export type LiveServerMessage = Extract<ServerMessage, { type: LiveMessageType }>
