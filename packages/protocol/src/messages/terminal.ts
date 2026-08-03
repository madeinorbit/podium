import {
  AgentKind,
  Attribution,
  DelegationScope,
  Geometry,
  IssueIdField,
  MachineIdField,
  ResumeRef,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import { z } from 'zod'
import { PresenceIdentity } from '../planes/presence-rooms'
import { FeedCursorField } from './feed'

const positiveInt = z.number().int().positive()

export const Viewport = z.object({
  cols: positiveInt,
  rows: positiveInt,
  dpr: z.number().positive(),
})
export type Viewport = z.infer<typeof Viewport>

/** Server confirms that an exact native resume binding is durably stored. */
export const SessionResumeRefAckMessage = z.object({
  type: z.literal('sessionResumeRefAck'),
  sessionId: SessionIdField,
  resume: ResumeRef,
  /** Binding owner resolved by the server; absent from older rolling peers. */
  ownerId: UserIdField.optional(),
})

/** Server verdict for an exact native-id collision. Both host observations
 * remain durable and pending; this frame records the visible conflict only. */
export const SessionResumeRefConflictMessage = z.object({
  type: z.literal('sessionResumeRefConflict'),
  sessionId: SessionIdField,
  resume: ResumeRef,
  conflictId: z.string().min(1),
  conflictingSessionIds: z.array(SessionIdField).min(1),
  observedAt: z.string().min(1),
})

// ---- Browser client -> server: terminal control frames ----
/** Client capability: the client consumes `metadataDelta` streams, so the server
 *  must stop sending it the full-list snapshot rebroadcasts (it still gets the
 *  attach-time bootstrap snapshots — those are its initial paint). */
export const CAP_METADATA_DELTA = 'metadataDelta'
/** Client capability: the client understands feed identity (ADR 2 D1/D5) — it
 *  holds the `(feedId, epoch, seq)` cursor TRIPLE rather than a bare seq, and
 *  it acts on the published `minAvailableSeq`. The server stamps those three
 *  fields onto this client's `metadataDelta` frames; a client without the cap
 *  gets today's frame byte-for-byte.
 *
 *  Only meaningful alongside {@link CAP_METADATA_DELTA} (there is no frame to
 *  stamp otherwise). Additive per ADR 2 D4 — new fields negotiate by
 *  capability, `WIRE_VERSION` stays 1 and moves only for breaking FRAMING
 *  changes.
 *
 *  Deliberately NOT the gate on `sync.changesSince`: that is a tRPC query with
 *  no hello and therefore no caps context, so its reply carries the fields
 *  unconditionally. That is safe in the same way the whole additive rule is —
 *  zod objects STRIP unknown keys, so an older client's parse drops them. */
export const CAP_SYNC_FEED_IDENTITY = 'syncFeedIdentity'
/** Client capability: the client consumes the NORMALIZED issue projection
 *  (`IssueProjection` from `@podium/model`) rather than `IssueWire` — issues
 *  carry no embedded `sessions: SessionMeta[]`, no cross-entity rollups, and no
 *  member ids at all; the client joins sessions locally by indexing them on
 *  `issueId` (ADR 4 D7.1/D7.3). [POD-796]
 *
 *  The cap tells a client to render the normalized collection. The server emits
 *  it unconditionally; a capless client receives the registered, session-free
 *  transitional IssueWire residue for attach paint and rolling compatibility.
 *
 *  Additive per ADR 2 D4 — negotiated by capability, `WIRE_VERSION` stays 1.
 *  Unlike {@link CAP_SYNC_FEED_IDENTITY}, this capability selects which of the
 *  two unconditionally emitted collections the client consumes.
 */
export const CAP_ISSUES_NORMALIZED = 'issuesNormalized'
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
  // Optional feature negotiation. Absent (older clients) = no capabilities: the
  // server keeps its legacy behavior for this client, so this field is additive.
  caps: z.array(z.string()).optional(),
  /**
   * The wire version this build speaks (POD-308). ABSENT MEANS 1, and that is
   * the only reading available: a pre-cutover client cannot be made to send a
   * field it was never built with, so the absence IS the advertisement. Every
   * newer build sends it, so absence stays unambiguous as the window moves.
   */
  wireVersion: z.number().int().positive().optional(),
  /**
   * Where this replica's cache stands, so the server can pick a rung of ADR 2
   * D7's ladder instead of re-sending everything (`feedCursor.seq` resumes;
   * absent, or a foreign `feedId`/`epoch`, re-bootstraps).
   *
   * The whole triple or nothing — ADR 2 D1: a bare seq is meaningless, and a seq
   * presented against a rolled epoch is worse than meaningless, because it is
   * resumable-looking.
   */
  feedCursor: FeedCursorField.optional(),
})
export const AttachMessage = z.object({
  type: z.literal('attach'),
  sessionId: SessionIdField,
  // Resume cursor: the last outputFrame seq this client already rendered. Sent on a
  // reconnect, where the terminal view survived the socket drop — the server then
  // replays only the frames after this point and marks the attach `resumed` so the
  // client appends instead of wiping. Omitted on a fresh mount (no screen to keep)
  // or when the client has rendered nothing yet → full replay + clear.
  sinceSeq: z.number().int().nonnegative().optional(),
})
export const DetachMessage = z.object({ type: z.literal('detach'), sessionId: SessionIdField })
export const InputMessage = z.object({
  type: z.literal('input'),
  sessionId: SessionIdField,
  data: z.string(),
  /** Intended causal source of a provider-confirmed prompt. Optional for mixed
   * deployments; the daemon never treats intent alone as a turn edge. */
  inputOrigin: z
    .enum([
      'human',
      'controller',
      'steward',
      'mail',
      'auto_continue',
      'system',
      'provider',
      'unknown',
    ])
    .optional(),
  /** Actor + on-behalf-of stamped by the authenticated transport. Payload
   * identity is inert; the server replaces it before forwarding client input. */
  attribution: Attribution.optional(),
})
// Client's requested terminal grid; controller-authoritative. Geometry shape + sessionId.
export const ResizeMessage = z.object({
  type: z.literal('resize'),
  sessionId: SessionIdField,
  ...Geometry.shape,
})
export const RequestControlMessage = z.object({
  type: z.literal('requestControl'),
  sessionId: SessionIdField,
})
export const RedrawRequestMessage = z.object({
  type: z.literal('redrawRequest'),
  sessionId: SessionIdField,
})
// Liveness probe. The browser pings periodically so a half-open connection (laptop
// sleep, dead proxy hop) is detected client-side, and idle-timeout proxies see
// traffic. The server answers with pong.
export const PingMessage = z.object({ type: z.literal('ping') })
// Reply to a client PingMessage; its arrival is the liveness signal.
export const PongMessage = z.object({ type: z.literal('pong') })
// User presence (page visibility) — the smart-notification router skips mobile
// push while some Podium window is visibly open.
export const PresenceMessage = z.object({ type: z.literal('presence'), visible: z.boolean() })
// Per-session view state: which sessions this client renders (`visible`) and which
// single one has input focus (`focused`). The server unions these across clients to
// prioritize PTY output relay (focused/visible relayed live; the rest coalesced).
export const ViewStateMessage = z.object({
  type: z.literal('viewState'),
  visible: z.array(SessionIdField),
  focused: SessionIdField.nullable(),
  // Optional sessionId→rendered-mode map for the visible sessions (native terminal
  // vs chat). Wired through so the rendered mode is AVAILABLE server-side; it is NOT
  // (yet) used to schedule/coalesce output — users bounce back to native, so the
  // terminal stays warm regardless. Optional ⇒ backward compatible (old clients omit
  // it and the server reads `{}`).
  modes: z.record(z.string(), z.enum(['native', 'chat'])).optional(),
})

// The in-progress composer / native-prompt text for a session. The controlling
// client publishes its scraped native prompt, and a chat composer edit publishes
// its draft, so every view/device converges. Server-persisted (debounced) so the
// draft survives a full reload / server restart and replays on (re)connect
// (issue #34) — real user work is never lost.
export const SetSessionDraftMessage = z.object({
  type: z.literal('setSessionDraft'),
  sessionId: SessionIdField,
  text: z.string(),
})
export type SetSessionDraftMessage = z.infer<typeof SetSessionDraftMessage>

// Draft Sync v2 (POD-859): the versioned-draft client→server edit. Unlike the
// legacy `setSessionDraft` (unconditional last-writer-wins), a `draftEdit` names
// the `baseRev` it was typed against so the server can arbitrate concurrent edits
// (LWW by server-assigned rev + a soft edit lease). Additive — old clients keep
// sending `setSessionDraft`; the server treats that as an unconditional edit.
export const DraftEditMessage = z.object({
  type: z.literal('draftEdit'),
  sessionId: SessionIdField,
  /** The rev the sender believed it was editing from (0 = from-empty). */
  baseRev: z.number().int().nonnegative(),
  text: z.string(),
})
export type DraftEditMessage = z.infer<typeof DraftEditMessage>

// server -> daemon: drive this text into the session's native composer (Draft Sync
// v2). The server sends it once a chat edit's soft lease has settled (and on
// catchup), so the daemon's injection state machine mirrors chat → native.
export const DraftTargetMessage = z.object({
  type: z.literal('draftTarget'),
  sessionId: SessionIdField,
  text: z.string(),
})
export type DraftTargetMessage = z.infer<typeof DraftTargetMessage>

// ---- Server -> browser client: terminal control frames ----
export const WelcomeMessage = z.object({ type: z.literal('welcome'), clientId: z.string() })
export const AttachedMessage = z.object({
  type: z.literal('attached'),
  sessionId: SessionIdField,
  controllerId: z.string().nullable(),
  controllerIdentity: PresenceIdentity.nullable().optional(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  // True when the following frames are an incremental catch-up from the client's
  // `sinceSeq` cursor: the client keeps its screen and appends. Absent/false = a
  // full replay, so the client clears first. Optional for back-compat (an older
  // server omits it; the client treats that as a full replay and clears).
  resumed: z.boolean().optional(),
})
export const TerminalOutcomeMessage = z.object({
  type: z.literal('terminalOutcome'),
  sessionId: SessionIdField,
  outcome: z.enum(['unauthorized', 'unreachable']),
})
export type TerminalOutcomeMessage = z.infer<typeof TerminalOutcomeMessage>

export const OutputFrameMessage = z.object({
  type: z.literal('outputFrame'),
  sessionId: SessionIdField,
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  data: z.string(),
})
export const ControllerChangedMessage = z.object({
  type: z.literal('controllerChanged'),
  sessionId: SessionIdField,
  controllerId: z.string().nullable(),
  controllerIdentity: PresenceIdentity.nullable().optional(),
  geometry: Geometry,
})
// Server's authoritative PTY size, per session — lets spectators letterbox.
export const GeometryMessage = z.object({
  type: z.literal('geometry'),
  sessionId: SessionIdField,
  ...Geometry.shape,
})
// Shared in both directions: daemon -> server AND server -> client (identical shape).
export const AgentExitMessage = z.object({
  type: z.literal('agentExit'),
  sessionId: SessionIdField,
  code: z.number().int(),
})

// ---- Daemon <-> server: spawn/reattach/kill + PTY relay ----
// server -> daemon
/** One machine-authored instruction contribution. Sources stay separate on the
 * wire so independent server modules can contribute without re-parsing or
 * impersonating the user's first message; the harness bridge composes them. */
export const AgentInstruction = z.object({
  source: z.string().min(1).max(128),
  content: z.string().min(1),
})
export type AgentInstruction = z.infer<typeof AgentInstruction>
/** Server-authored identity input for SPAWN. It is derived from the
 * authenticated transport principal; no command payload has this shape. */
export const SessionBindingSpawnPrincipal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdField }),
  z.object({ kind: z.literal('agent'), parentBindingId: SessionIdField }),
  /** `job` NAMES the in-process job (steward, automation, boot reconcile), the
   *  way ADR 9 D1's system arm does. Optional so a peer that predates it still
   *  parses, and because the arm was carried here without one: absent means the
   *  producer recorded no job name, never that a job name was suppressed. */
  z.object({ kind: z.literal('system'), job: z.string().optional() }),
])
export type SessionBindingSpawnPrincipal = z.infer<typeof SessionBindingSpawnPrincipal>

export const BindingMachineAccess = z.enum(['allowed', 'denied', 'unreachable'])
export type BindingMachineAccess = z.infer<typeof BindingMachineAccess>

export const SessionBindingSpawnInstruction = z.object({
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  principal: SessionBindingSpawnPrincipal,
  issueId: IssueIdField.optional(),
  requestedScope: DelegationScope.optional(),
  scopeOverrideConfirmed: z.boolean().optional(),
})
export type SessionBindingSpawnInstruction = z.infer<typeof SessionBindingSpawnInstruction>

export const SessionBindingReattachInstruction = z.object({
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  /** Already policy-collapsed: invisible and nonexistent are both not-found. */
  sessionAccess: z.enum(['allowed', 'not-found']),
  /** Server-authored from the authenticated transport, never client payload. */
  principal: SessionBindingSpawnPrincipal,
})
export type SessionBindingReattachInstruction = z.infer<typeof SessionBindingReattachInstruction>

/** Launch proof for a binding that the handoff import already adopted. It
 * resets only the host-local attempt; delegation is read from the binding. */
export const SessionBindingAdoptLaunchInstruction = z.object({
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  transferId: z.string().min(1),
  role: z.enum(['source', 'target']),
  fromMachineId: MachineIdField,
  toMachineId: MachineIdField,
})
export type SessionBindingAdoptLaunchInstruction = z.infer<
  typeof SessionBindingAdoptLaunchInstruction
>

export const SpawnMessage = z.object({
  type: z.literal('spawn'),
  sessionId: SessionIdField,
  durableLabel: z.string().optional(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  geometry: Geometry,
  /** Server-authored from the authenticated transport principal. */
  binding: SessionBindingSpawnInstruction.optional(),
  /** Mutually exclusive with `binding`: the binding already exists because a
   * handoff imported it before this process launch (born-pin). */
  adoptedBinding: SessionBindingAdoptLaunchInstruction.optional(),
  // Settings-driven model defaults. Absent = the harness decides (no flag/env).
  model: z.string().optional(),
  subagentModel: z.string().optional(),
  // Reasoning-effort flag. Absent = the harness decides (no flag). Mapped to each
  // agent CLI's effort option in agentLaunchCommand.
  effort: z.string().optional(),
  // A first prompt handed to the agent at launch as a positional argv token
  // (race-free; e.g. an issue's description). Only set for argv-capable agents.
  initialPrompt: z.string().optional(),
  // Machine-authored behavioral/context instructions. These are deliberately
  // distinct from initialPrompt: adapters deliver them through their native
  // system/developer/rules/config channel, never as a user-authored turn.
  instructions: z.array(AgentInstruction).optional(),
  // Managed-credential + environment vars resolved SERVER-side and merged into the
  // daemon's spawn env overlay (SP-6454, #216). Generic on purpose — an LLM
  // credential, a GitHub token (#214) and machine-level pins (#234) all ride here.
  // Additive + optional: an older daemon ignores it, an older server omits it.
  env: z.record(z.string(), z.string()).optional(),
  // Seed the CLI's theme with per-session official flags so it follows the
  // terminal's issue-tinted colours (roles.coding.seedCliTheme, [spec:SP-a04d]).
  // Absent = the setting's default (on) — older servers simply get the default.
  seedCliTheme: z.boolean().optional(),
  // Draft Sync v2 (POD-859): the server's `draftSync` flag for this session — the
  // daemon runs its composer scrape/inject engine (and disables codex kitty
  // keyboard enhancement) only when true. Additive; older servers omit it (off).
  draftSync: z.boolean().optional(),
  /** Durable server-issued observer lease fence [spec:SP-cdb2]. */
  observationGeneration: z.number().int().positive().optional(),
  /** Version of the exact provider binding carried by this lease. */
  observationBindingVersion: z.number().int().positive().optional(),
  /** Exact provider identity owned by the observation lease. Explicit null is
   * a fresh unbound lease; omission is reserved for older servers.
   * UNBRANDED BY DECISION: this is the PROVIDER's session id, not Podium's —
   * harness-native, and `ids/brands.ts` records that such an id has no brand
   * because it is evidence rather than identity. */
  observationProviderSessionId: z.string().min(1).nullable().optional(),
  /** Last durably accepted causal checkpoint. Optional for mixed-version
   * control messages; the daemon validates it with the canonical v1 schema. */
  observationCheckpoint: z.unknown().optional(),
})
export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  sessionId: SessionIdField,
  durableLabel: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  geometry: Geometry,
  /** Live machine-use verdict and retry identity for this reattach. */
  binding: SessionBindingReattachInstruction.optional(),
  // Lets the daemon classify the live transcript when seeding a survivor's state
  // on reattach, so a session parked on a question keeps its 'needs answer' signal.
  resume: ResumeRef.optional(),
  // Recorded segment evidence — same contract as transcriptRead.pathHint: the
  // reattach tail re-binds to this file without deriving from the (mutable) cwd.
  pathHint: z.string().optional(),
  // The session's original spawn time (epoch ms). Observer-based harnesses (codex)
  // need it as the cwd-discovery floor on reattach: codex creates its rollout file
  // lazily (often at the first prompt), so the file can first appear only after a
  // daemon restart — without a floor the reattached observer could never bind it
  // and the session would stay status-blind forever.
  createdAtMs: z.number().optional(),
  // Draft Sync v2 (POD-859): as SpawnMessage.draftSync — the daemon runs its
  // composer engine for this reattached session only when true.
  draftSync: z.boolean().optional(),
  /** Durable server-issued observer lease fence [spec:SP-cdb2]. */
  observationGeneration: z.number().int().positive().optional(),
  /** Version of the exact provider binding carried by this lease. */
  observationBindingVersion: z.number().int().positive().optional(),
  /** Exact provider identity owned by the observation lease. Explicit null is
   * a fresh unbound lease; omission is reserved for older servers.
   * UNBRANDED BY DECISION: this is the PROVIDER's session id, not Podium's —
   * harness-native, and `ids/brands.ts` records that such an id has no brand
   * because it is evidence rather than identity. */
  observationProviderSessionId: z.string().min(1).nullable().optional(),
  /** Last durably accepted causal checkpoint. Optional for mixed-version
   * control messages; the daemon validates it with the canonical v1 schema. */
  observationCheckpoint: z.unknown().optional(),
})
export const KillMessage = z.object({
  type: z.literal('kill'),
  sessionId: SessionIdField,
  durableLabel: z.string().optional(),
})
/** Terminal Session deletion. Unlike `kill`, this ends the binding delegation
 * after the server has durably tombstoned the Session row. */
export const SessionBindingRetireMessage = z.object({
  type: z.literal('sessionBindingRetire'),
  sessionId: SessionIdField,
  transitionId: z.string().min(1),
  retiredAt: z.string().min(1),
  durableLabel: z.string().optional(),
})
// Server→daemon: relay priority for one session (0=focused,1=visible,2=attached,
// 3=unwatched). Drives the daemon's output scheduler.
export const SessionPriorityMessage = z.object({
  type: z.literal('sessionPriority'),
  sessionId: SessionIdField,
  priority: z.number().int().min(0).max(3),
})
export const RedrawMessage = z.object({ type: z.literal('redraw'), sessionId: SessionIdField })

// daemon -> server
export const BindMessage = z.object({
  type: z.literal('bind'),
  sessionId: SessionIdField,
  cmd: z.string(),
  cwd: z.string(),
  agentKind: AgentKind,
  geometry: Geometry,
  // Draft Sync v2 (POD-859): true when the daemon runs its composer scrape/inject
  // engine for this session. Surfaced in SessionMeta so a client retires its own
  // sampler/flush. Additive; older daemons omit it (no engine).
  draftSyncEngine: z.boolean().optional(),
})
export const AgentFrameMessage = z.object({
  type: z.literal('agentFrame'),
  sessionId: SessionIdField,
  seq: z.number().int().nonnegative(),
  data: z.string(),
})
export const AgentFrameBatchMessage = z.object({
  type: z.literal('agentFrameBatch'),
  sessionId: SessionIdField,
  // Coalesced PTY frames (base64 data only — the server assigns its own seq).
  frames: z.array(z.string()),
})
export const SpawnErrorMessage = z.object({
  type: z.literal('spawnError'),
  sessionId: SessionIdField,
  message: z.string(),
})
export const ReattachFailedMessage = z.object({
  type: z.literal('reattachFailed'),
  sessionId: SessionIdField,
  reason: z.string(),
})
// Live terminal title sniffed from the agent's PTY (OSC 0/1/2). The daemon
// detects it in the byte stream and forwards it so the server can label the panel.
export const TitleMessage = z.object({
  type: z.literal('title'),
  sessionId: SessionIdField,
  title: z.string(),
})
// Daemon → server: the agent's `/color` accent, parsed from the transcript tail.
export const AgentColorMessage = z.object({
  type: z.literal('agentColor'),
  sessionId: SessionIdField,
  color: z.string(),
})
// Daemon → server: the model observed producing assistant turns (`message.model`
// in the transcript). Resolves a spawn-time `auto` to the concrete id and tracks
// mid-session `/model` switches; rides the same transcript tail as agentColor.
export const AgentModelMessage = z.object({
  type: z.literal('agentModel'),
  sessionId: SessionIdField,
  model: z.string(),
  /** The observed reasoning-effort tier (assistant records' top-level `effort`),
   *  when the transcript reports one. Optional for wire-compat with older daemons. */
  effort: z.string().optional(),
})
// Daemon → server: exact context-window usage observed in the harness's native
// transcript. Harnesses without a reliable numerator + window do not emit it.
export const AgentContextMessage = z.object({
  type: z.literal('agentContext'),
  // Branded like every sibling frame in this file. main added this frame
  // (POD-1262) with a bare z.string(); the rewrite's ids are branded, and the
  // deletion ratchet flags exactly this shape — a key naming an entity id whose
  // schema is an unbranded string.
  sessionId: SessionIdField,
  percent: z.number().finite().min(0).max(100),
})
