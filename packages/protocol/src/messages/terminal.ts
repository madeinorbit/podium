import { AgentKind, Geometry, ResumeRef, SessionIdField } from '@podium/model'
import { z } from 'zod'

const positiveInt = z.number().int().positive()

export const Viewport = z.object({
  cols: positiveInt,
  rows: positiveInt,
  dpr: z.number().positive(),
})
export type Viewport = z.infer<typeof Viewport>

/**
 * Per-kind capability flags (#158) — the ONE declarative table of what each
 * harness CLI supports. Pure data (protocol is a leaf), consumed by:
 *   - @podium/agent-bridge's HarnessAdapter registry (each adapter embeds its row);
 *   - apps/server gating (argv prompt vs composer seed, effort flag, cloud);
 *   - apps/daemon spawn/observer wiring (OSC titles, hook install strategy).
 * Adding a harness = adding its row here + an adapter file (the registry's
 * exhaustive Record makes a missing row/adapter a type error).
 */
export interface AgentCapabilities {
  /** Accepts the first prompt as a trailing positional argv token (race-free);
   *  false ⇒ the server seeds the composer draft instead. */
  argvPrompt: boolean
  /** How a reasoning-effort override reaches the CLI. 'none' ⇒ silently dropped. */
  effortFlag: 'effort' | 'codex-config' | 'variant' | 'none'
  /** Has a native extra-system-prompt flag (claude `--append-system-prompt`);
   *  false ⇒ orchestrator prompts are prepended to the user prompt. */
  systemPromptFlag: boolean
  /** The daemon can read local quota/rate-limit state for this harness. */
  quota: boolean
  /** Sessions of this kind can be moved to a cloud runtime. */
  cloud: boolean
  /** The web controller can scrape the native TUI composer for draft sync. */
  composerScrape: boolean
  /** The harness's OSC terminal title is meaningful and forwarded (codex sets
   *  a churning cwd-basename title, which the daemon suppresses). */
  oscTitle: boolean
  /** Reads CLAUDE_CODE_SUBAGENT_MODEL-style env for subagent model selection. */
  subagentModelEnv: boolean
  /** The native TUI honours shift+tab mode cycling and `?` shortcut help, so the
   *  prompt-chrome hint row is worth showing. Only hints a CLI really honours may
   *  be advertised — a hint the harness ignores is worse than none. */
  promptModeHints: boolean
  /** A session of this kind can be packaged and moved to another machine
   *  (handoff). False ⇒ the UI states 'harness' as the blocker rather than
   *  offering a move that cannot complete. */
  handoff: boolean
  /** How Podium's state hooks reach the harness: per-spawn settings/args
   *  ('settings-args'), a global hook install activated per-session via env
   *  ('global-env'), or none (observer-only harnesses). */
  hookInstall: 'settings-args' | 'global-env' | 'none'
}

export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  'claude-code': {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: true,
    quota: true,
    cloud: true,
    composerScrape: true,
    oscTitle: true,
    subagentModelEnv: true,
    promptModeHints: true,
    handoff: true,
    hookInstall: 'settings-args',
  },
  codex: {
    argvPrompt: true,
    effortFlag: 'codex-config',
    systemPromptFlag: false,
    quota: true,
    cloud: true,
    composerScrape: true,
    oscTitle: false,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: true,
    hookInstall: 'global-env',
  },
  grok: {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    hookInstall: 'global-env',
  },
  opencode: {
    argvPrompt: false,
    effortFlag: 'variant',
    systemPromptFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    hookInstall: 'none',
  },
  cursor: {
    argvPrompt: false,
    effortFlag: 'none',
    systemPromptFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    hookInstall: 'none',
  },
  shell: {
    argvPrompt: false,
    effortFlag: 'none',
    systemPromptFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    hookInstall: 'none',
  },
}

/** Accepts the first prompt as a trailing positional argv token
 *  (`claude "<prompt>"` / `codex "<prompt>"` / `grok "<prompt>"`) — the race-free
 *  way to hand a fresh session its first prompt. Others must seed the composer draft. */
export function agentSupportsInitialPrompt(kind: AgentKind): boolean {
  return AGENT_CAPABILITIES[kind].argvPrompt
}

/** Has a reasoning-effort flag at all; cursor + shell drop effort silently. */
export function agentSupportsEffort(kind: AgentKind): boolean {
  return AGENT_CAPABILITIES[kind].effortFlag !== 'none'
}

/** Kinds whose sessions can be moved to a cloud runtime (claude-code, codex). */
export function agentSupportsCloud(kind: AgentKind): boolean {
  return AGENT_CAPABILITIES[kind].cloud
}

/**
 * Capability row for a harness, or `undefined` when this build has never heard of
 * it (POD-1105 review, blocker 1).
 *
 * `AgentKind` is the closed set of harnesses THIS BUILD knows; the wire is NOT
 * closed, because a newer machine in the fleet can name a harness added after
 * this client shipped. So capability questions asked at a consumer boundary take
 * the open id and answer totally: indexing the closed table by an unknown id
 * throws, where the comparison it replaced simply returned false. This is the
 * incremental-completeness seam — an unknown harness must degrade to "no special
 * affordance", never crash the view.
 *
 * VOCABULARY, deliberately not invented here. POD-397 lands the real identity
 * model next door in ./harness — `HarnessId` (open, branded), the closed
 * `BuiltinHarnessKind`, and `manifestFor(kind): AgentManifest | undefined`, whose
 * contract is exactly this function's: unknown ⇒ undefined, caller branches. The
 * parameter is spelled inline rather than as a new exported alias ON PURPOSE:
 * this file and ./harness are both re-exported by the package barrel, so
 * exporting a second `HarnessId` from here would be a duplicate export the
 * moment POD-397 merges. When it does, POD-398 replaces this signature with
 * their `HarnessId` — a rename, not a reconciliation of two vocabularies.
 */
export function agentCapabilitiesFor(
  kind: AgentKind | (string & {}),
): AgentCapabilities | undefined {
  return AGENT_CAPABILITIES[kind as AgentKind]
}

/** Worth drawing the native prompt-chrome hint row for this harness (POD-1105 —
 *  the view asks the capability table instead of naming a harness). Total: an
 *  unknown harness advertises NO hints, since a hint it does not honour is worse
 *  than none — and that matches the `=== 'claude-code'` this replaced. */
export function agentShowsPromptModeHints(kind: AgentKind | (string & {})): boolean {
  return agentCapabilitiesFor(kind)?.promptModeHints ?? false
}

/** Sessions of this kind can be handed off to another machine (claude-code,
 *  codex today). The eligibility question every handoff surface asks, answered
 *  once here rather than re-listing the pair per call site (POD-1105). Total: an
 *  unknown harness is NOT handoff-eligible, which is both the safe answer and
 *  what the pair of equality checks this replaced returned. */
export function agentSupportsHandoff(kind: AgentKind | (string & {})): boolean {
  return agentCapabilitiesFor(kind)?.handoff ?? false
}

/** Server confirms that an exact native resume binding is durably stored. */
export const SessionResumeRefAckMessage = z.object({
  type: z.literal('sessionResumeRefAck'),
  sessionId: SessionIdField,
  resume: ResumeRef,
})

// ---- Browser client -> server: terminal control frames ----
/** Client capability: the client consumes `metadataDelta` streams, so the server
 *  must stop sending it the full-list snapshot rebroadcasts (it still gets the
 *  attach-time bootstrap snapshots — those are its initial paint). */
export const CAP_METADATA_DELTA = 'metadataDelta'
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
  // Optional feature negotiation. Absent (older clients) = no capabilities: the
  // server keeps its legacy behavior for this client, so this field is additive.
  caps: z.array(z.string()).optional(),
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
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  // True when the following frames are an incremental catch-up from the client's
  // `sinceSeq` cursor: the client keeps its screen and appends. Absent/false = a
  // full replay, so the client clears first. Optional for back-compat (an older
  // server omits it; the client treats that as a full replay and clears).
  resumed: z.boolean().optional(),
})
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

export const SpawnMessage = z.object({
  type: z.literal('spawn'),
  sessionId: SessionIdField,
  durableLabel: z.string().optional(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  geometry: Geometry,
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
   * a fresh unbound lease; omission is reserved for older servers. */
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
   * a fresh unbound lease; omission is reserved for older servers. */
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
