import {
  AgentKind,
  Attribution,
  DelegationScope,
  Geometry,
  HarnessAgent,
  IssueIdField,
  MachineIdField,
  ResumeRef,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import { z } from 'zod'
import { PresenceIdentity } from '../planes/presence-rooms'
import { FeedCursorField } from './feed'
import { ClientLogOrigin } from './logs'

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
  /**
   * HOW THIS CLIENT DESCRIBES ITSELF, so an operator can address it (POD-1920).
   *
   * The same role/version/machine tuple the client stamps on the records it
   * forwards, which is what the server files them under — so "the mobile client
   * on machine X" names one thing whether you are reading its log file or
   * raising its level. Absent from an older build, and absent is a legal answer:
   * such a connection simply cannot be targeted individually, and a raise
   * addressed at everything still reaches it.
   *
   * SELF-DESCRIPTION, NEVER AUTHORIZATION. It labels a connection for an
   * operator's benefit; who may call the command that reads it is settled by
   * that command's own policy, from the transport principal, before any of this
   * is consulted.
   */
  origin: ClientLogOrigin.optional(),
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
  /**
   * The viewport measured at the instant control is claimed. Keeping the
   * geometry on the claim makes controller transfer + PTY sizing one ordered
   * server mutation instead of a resize/request race. Optional for rolling
   * compatibility with clients that still report their viewport separately.
   */
  geometry: Geometry.optional(),
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
  // Has this PTY ever produced output since it was spawned? Counted durably
  // (`output_count`), so it survives a server restart that emptied the replay
  // window — which is what separates "attached, but the child has printed
  // NOTHING yet" (a CLI still booting, e.g. one that self-updates on launch)
  // from "old session whose buffer we simply don't have" [POD-385]. Optional
  // for back-compat: an older server omits it and the client assumes output
  // has been seen, i.e. shows no waiting affordance.
  outputSeen: z.boolean().optional(),
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
  /** RELAUNCH, not a birth. A resurrect respawns a session whose binding may
   *  already exist (it was born under the binding store) or may not (it predates
   *  it). Absent, an existing binding is a duplicate-spawn attempt and the daemon
   *  rejects `binding-exists`; set, the daemon mints the record when it is
   *  missing and records a receipt over a live same-claimant one instead. */
  relaunch: z.boolean().optional(),
})
export type SessionBindingSpawnInstruction = z.infer<typeof SessionBindingSpawnInstruction>

export const SessionBindingReattachInstruction = z.object({
  transitionId: z.string().min(1),
  machineAccess: BindingMachineAccess,
  /** Already policy-collapsed: invisible and nonexistent are both not-found. */
  sessionAccess: z.enum(['allowed', 'not-found']),
  /** Server-authored from the authenticated transport, never client payload. */
  principal: SessionBindingSpawnPrincipal,
  /** ADOPTION IDENTITY for a session with no binding record yet.
   *
   * A binding is minted at spawn, so every session that predates the binding
   * store has none — and a reattach that merely refused those left a whole
   * pre-upgrade fleet alive but unreachable (POD-1647). The daemon cannot mint
   * one on its own: it has the durable label and the cwd, but not WHO the
   * session belongs to. The server does, on the session row, so it authors that
   * identity here and the daemon adopts the survivor under it.
   *
   * Deliberately NOT derived from `principal` above: that is the reattach
   * CALLER (a system probe on daemon connect), not the session's owner, and
   * minting from it would replace a real human delegation with a placeholder. */
  adopt: z
    .object({
      ownerUserId: UserIdField,
      issueId: IssueIdField.optional(),
    })
    .optional(),
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

/**
 * HOW A SPAWN ASKS TO BE DRIVEN THROUGH THE CONTRACT (POD-1761 W3, widened by W5).
 *
 * `true` — drive this session through the contract with whatever driver the
 * harness manifest's `select()` policy picks, which today means the terminal
 * one for every harness. This is W3's meaning, unchanged.
 *
 * A DRIVER ID — drive it through the contract with THAT driver specifically.
 * This is the operator's explicit per-spawn override (spec §9 phase 3): it is
 * how one session runs on `opencode-server` while every other session on the
 * same daemon stays terminal, and it is why the default needs no change at all.
 *
 * WIDENED RATHER THAN JOINED BY A SECOND FIELD, deliberately. The two would
 * always have to be read together — "contract on, and also this driver" — and a
 * pair of independently-optional fields has a fourth state ("a driver, but the
 * contract off") that means nothing and that every reader would have to decide
 * about separately.
 *
 * TYPED AS A BARE STRING HERE, and validated at the daemon. `DriverId` is
 * defined in `@podium/harness`, which sits ABOVE this package — the same
 * direction that keeps the driver taxonomy out of the `runtime` message family.
 * An unknown id is refused where the driver registry is, which is the only place
 * that can tell a typo from a driver this build does not ship.
 */
export const RuntimeContractRequest = z.union([z.boolean(), z.string().min(1)])
export type RuntimeContractRequest = z.infer<typeof RuntimeContractRequest>

export const SpawnMessage = z.object({
  type: z.literal('spawn'),
  sessionId: SessionIdField,
  durableLabel: z.string().optional(),
  agentKind: AgentKind,
  /** Server-authorized native-login purpose. The daemon resolves the command
   * from this harness's manifest instead of accepting arbitrary argv. */
  loginHarness: HarnessAgent.optional(),
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
  /**
   * AGENT RUNTIME CONTRACT, per session (POD-1761 W3). When true this session is
   * ALSO driven through `@podium/agent-runtime`'s `RuntimeDriver` — the daemon
   * builds a driver handle beside the existing bridge and answers `runtime*`
   * frames for it. Absent/false = the legacy path only, byte for byte.
   *
   * PER-SPAWN as well as per-daemon (`PODIUM_RUNTIME_CONTRACT=1`) so a single
   * session can be flagged without flipping a machine: the daemon takes the OR
   * of the two, which is what lets the e2e lane prove the flag-on path while
   * every other session on the same daemon stays on the legacy one.
   */
  runtimeContract: RuntimeContractRequest.optional(),
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
  /** Prior daemon-reported server preference (manifest or machine) that
   * degraded for this live session. Echoed on reattach so reconnect preserves it. */
  requestedDriverId: z.string().min(1).optional(),
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
  /**
   * AGENT RUNTIME CONTRACT, per session (POD-1761 W3). When true this session is
   * ALSO driven through `@podium/agent-runtime`'s `RuntimeDriver` — the daemon
   * builds a driver handle beside the existing bridge and answers `runtime*`
   * frames for it. Absent/false = the legacy path only, byte for byte.
   *
   * PER-SESSION as well as per-daemon (`PODIUM_RUNTIME_CONTRACT=1`) so a single
   * session can be flagged without flipping a machine: the daemon takes the OR
   * of the two, which is what lets the e2e lane prove the flag-on path while
   * every other session on the same daemon stays on the legacy one.
   */
  runtimeContract: RuntimeContractRequest.optional(),
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
// 3=unwatched), plus whether any visible client is rendering its native surface.
// The latter activates an on-demand harness TUI for server-family sessions.
export const SessionPriorityMessage = z.object({
  type: z.literal('sessionPriority'),
  sessionId: SessionIdField,
  priority: z.number().int().min(0).max(3),
  nativeView: z.boolean().optional(),
})
export const RedrawMessage = z.object({ type: z.literal('redraw'), sessionId: SessionIdField })

// daemon -> server
/**
 * THE DRIVER THIS DAEMON HAS DECIDED TO USE, SENT BEFORE IT LAUNCHES ANYTHING
 * (POD-2290).
 *
 * `bind` already reports the driver — but `bind` is the frame that marks a
 * session LIVE, so it cannot arrive until the harness is up. Measured on the
 * POD-2290 drive instance: an `opencode` session sat `starting` with no driver
 * fact for TWELVE SECONDS while `opencode serve` booted. Twelve seconds is not
 * a paint glitch; it is long enough for the operator to open the session, read
 * the wrong pane, and watch it change under them.
 *
 * That window is not information the clients lack — it is information nobody
 * SENT. The daemon knows which driver it will use the moment
 * `resolveRuntimeDriver` answers, which is before the probe's subject is even
 * started. This frame carries that decision at that moment.
 *
 * A DECISION, NOT A PREDICTION. It is emitted after the policy has run against
 * this machine's real probe and login state, so it is what the daemon WILL do,
 * not what the manifest would prefer. `bind` still reports the bound driver
 * afterwards and still wins: a launch that fails and falls back must not be
 * described by the plan it abandoned.
 */
export const DriverSelectedMessage = z.object({
  type: z.literal('driverSelected'),
  sessionId: SessionIdField,
  driverId: z.string().min(1),
})
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
  /**
   * AGENT RUNTIME CONTRACT, REPORTED BY THE PARTY THAT DECIDED IT (POD-1761 W4).
   *
   * True when the daemon actually built a driver handle for this session — i.e.
   * `bindRuntimeContract` registered it. The server cannot compute this itself:
   * the daemon takes the OR of a machine-wide env var it owns and the per-spawn
   * field, and it declines the flag for profileless harnesses (a shell has no
   * turns to be honest about). A server that inferred the answer from the field
   * it sent would be wrong in both directions — flagged-by-env sessions it never
   * asked for, and asked-for sessions the daemon refused.
   *
   * This is what W4's migrated senders branch on: a receipt only exists for a
   * session with a driver behind it, so the branch has to key on the driver, not
   * on an intent. Additive; older daemons omit it (legacy path only).
   */
  runtimeContract: z.boolean().optional(),
  /**
   * The runtime driver this daemon actually bound, reported from the live
   * handle's binding rather than inferred from the spawn request. Absent means
   * either an older daemon or a legacy session with no runtime handle.
   */
  driverId: z.string().min(1).optional(),
  /** Manifest-default or machine-wide server preference that degraded to
   * `driverId`. Per-spawn server preferences refuse instead. */
  requestedDriverId: z.string().min(1).optional(),
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
/**
 * Daemon → server: what a `kill` frame ACTUALLY did to the durable host.
 *
 * A park (hibernate / stop / archive) flips the row before the kill is even on
 * the wire, so without this the row's `hibernated` is a claim about a kill that
 * was merely REQUESTED. When the reap silently fails — a wedged listing, a
 * refused scope stop — the row says parked while the agent runs on for days, and
 * the next Resume spawns into its own live label (POD-1945 / POD-1952).
 *
 * `killed` is measured, not assumed: the daemon re-reads the durable host's
 * liveness after reaping and reports what it found.
 */
export const SessionKillResultMessage = z.object({
  type: z.literal('sessionKillResult'),
  sessionId: SessionIdField,
  durableLabel: z.string(),
  killed: z.boolean(),
  /** Present when `killed` is false: what is still holding the label. */
  reason: z.string().optional(),
})
/**
 * Daemon → server: every durable label this machine is actually still running,
 * pushed on connect.
 *
 * The reap receipt above covers a kill this server saw through; this covers the
 * ones it did not — a kill sent into a socket that had already died, or issued
 * by a server process that has since restarted. The daemon reads its own socket
 * index (no `abduco` fork, no per-label probe), so the whole census is one
 * directory scan however many sessions the machine holds.
 */
export const DurableSessionCensusMessage = z.object({
  type: z.literal('durableSessionCensus'),
  labels: z.array(z.string()),
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
  // schema is an unbranded string. POD-1593 reached the same fix independently.
  sessionId: SessionIdField,
  percent: z.number().finite().min(0).max(100),
})
