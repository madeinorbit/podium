import { stat } from 'node:fs/promises'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type {
  AgentInstruction,
  AgentObservation,
  AgentObservationAckMessage,
  AgentObservationRebindAckMessage,
  BuiltinHarnessKind,
  ObservationProvider,
  ProviderCursor,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import {
  fileChainSource,
  fileIdFor,
  type StatTick,
  type TranscriptRecordMapper,
  type TranscriptRuntimeReader,
  type TranscriptSource,
} from '@podium/transcript'
import type {
  AgentStateEventSource,
  AgentStateProvider,
  ProviderAgentStateEvent,
} from './agent-state/types.js'
import type { ConversationProvider } from './discovery/types.js'

/** The harness kinds — every AgentKind except 'shell' (a shell is spawned by the
 *  daemon directly; it has no CLI conventions, transcript, or observers).
 *  @deprecated Prefer `BuiltinHarnessKind` (@podium/protocol) — same type, and
 *  the name says WHY it is closed: registry totality. Retained so POD-398/399
 *  can retire the last call sites without a wide rename in this leaf. */
export type HarnessKind = BuiltinHarnessKind

// ---------------------------------------------------------------------------
// Incremental completeness (POD-303).
// ---------------------------------------------------------------------------

/**
 * A manifest capability that a harness may not implement YET.
 *
 * The registry's totality forces every capability to be DECLARED; this type is
 * what lets a declaration say "not yet" out loud. That is the whole point of the
 * scheme: a new `BuiltinHarnessKind` can land with a minimal manifest — launch
 * and discovery only — and grow state, headless and transcript support in later
 * PRs, without the compiler ever letting someone forget one.
 *
 * Deliberately NOT modelled as `T | undefined` or an optional field. An optional
 * field cannot distinguish "this CLI genuinely has no headless mode" from
 * "somebody added a harness and forgot this line", so the two failure modes get
 * the same silent treatment at every call site. Requiring an explicit `reason`
 * makes the unsupported case self-documenting and makes forgetting it a type
 * error.
 *
 * Consumers MUST branch on `supported`. Degrade the feature — grey out the
 * button, skip the observer, report capabilities unknown — never substitute
 * another harness's behavior as a default.
 */
export type Declared<T> =
  | { readonly supported: true; readonly value: T }
  | { readonly supported: false; readonly reason: string }

/** Declare a capability this harness implements. */
export function supported<T>(value: T): Declared<T> {
  return { supported: true, value }
}

/**
 * Declare a capability this harness does NOT implement, and say why — the reason
 * is surfaced in diagnostics (`podium doctor`, degraded settings UI), so write it
 * for a reader deciding whether the gap is permanent or just unfinished.
 */
export function unsupported(reason: string): Declared<never> {
  return { supported: false, reason }
}

/** The declared value, or `undefined` when unsupported — for the many call sites
 *  whose degraded path is simply "don't do it". Keeps `supported` checks from
 *  sprawling without ever inventing a substitute default. */
export function declaredValue<T>(declared: Declared<T>): T | undefined {
  return declared.supported ? declared.value : undefined
}

// ---------------------------------------------------------------------------
// Launch (interactive PTY spawn) — the agentLaunchCommand axis.
// ---------------------------------------------------------------------------

export interface HarnessLaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Stable Podium row identity for this interactive launch. Harnesses may use
   *  it only as runtime correlation metadata; it is not a native resume id. */
  podiumSessionId?: SessionId
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
  /** Model override from settings; absent (or 'auto') = the CLI's own default. */
  model?: string
  /** Reasoning-effort override; absent (or 'auto') = the CLI's own default. */
  effort?: string
  /** A first prompt handed as a trailing positional argv token where the CLI
   *  supports it (capabilities.argvPrompt); ignored otherwise. */
  initialPrompt?: string
  /** Attributed machine-authored context. The adapter must keep this out of the
   * visible user turn and use its harness-native instruction/rules channel. */
  instructions?: AgentInstruction[]
  /** Daemon-local directory available for adapters whose hidden channel is
   * file-backed (OpenCode inline config and Cursor rule plugins). */
  runtimeDir?: string
  /** Effective spawn environment, supplied so file/config transports can merge
   * with an existing harness-specific inline configuration. */
  env?: Record<string, string>
}

export interface LaunchFile {
  path: string
  contents: string
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  files?: LaunchFile[]
}

// ---------------------------------------------------------------------------
// One-shot exec (superagent full-harness turn) — the buildHarnessExec axis.
// ---------------------------------------------------------------------------

export interface HarnessExecOptions {
  prompt: string
  model?: string
  systemPrompt?: string
  /** Path to a written MCP config JSON (Claude `--mcp-config`). */
  mcpConfigPath?: string
  /** The raw MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  /** Tools pre-approved so they run headlessly without a permission prompt. */
  allowedTools?: string[]
}

export interface HarnessExecSpec {
  cmd: string
  args: string[]
  /** Delivered on the child's stdin (then EOF) — Claude's headless prompt path. */
  stdin?: string
  /** Extra env for the child (merged over process.env). Codex passes the MCP
   *  bearer token here via `bearer_token_env_var` rather than argv (POD-1021). */
  env?: Record<string, string>
}

/** Bin resolvers for agents whose executable path isn't a fixed name. */
export interface HarnessBins {
  opencode: () => string
  cursor: () => string
}

// ---------------------------------------------------------------------------
// Machine inventory — install and login discovery.
// ---------------------------------------------------------------------------

/** Best-effort native login state for one harness on one machine. `account` is
 * a safe, human-facing label only (never a token or raw credential). */
export interface HarnessLogin {
  state: 'in' | 'out' | 'unknown'
  account?: string
}

export interface HarnessInventory {
  /** Candidate executable paths in probe order for this machine/home. */
  binCandidates(homeDir: string): string[]
  /** Optional stronger identity probe for ambiguous executable names. */
  identityProbe?: {
    args: readonly string[]
    accepts(output: string): boolean
  }
  /** Read-only local credential/profile detection. Uneven support is explicit. */
  detectLogin(homeDir: string): HarnessLogin
}

/** Prefer a recognizable name + email without duplicating equal values. */
export function accountIdentity(name: unknown, email: unknown): string | undefined {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanEmail = typeof email === 'string' ? email.trim() : ''
  if (cleanName && cleanEmail && cleanName !== cleanEmail) return `${cleanName} · ${cleanEmail}`
  return cleanEmail || cleanName || undefined
}

// ---------------------------------------------------------------------------
// Headless sessions (persistent, process-per-turn) — the headless-drivers axis.
// ---------------------------------------------------------------------------

export interface HeadlessExecOptions {
  prompt: string
  /** Machine-authored seed/delta/focus context. Adapters with a native
   * instruction channel keep this out of the visible user message. */
  contextPrompt?: string
  model?: string
  effort?: string
  systemPrompt?: string
  mcpConfig?: string
  permissionMode?: string
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** The pinned harness session id (pre-minted for grok/cursor). */
  sessionId?: string
}

export interface HarnessHeadless {
  /**
   * Which daemon driver runs a turn:
   *   'claude-sdk'  — the Claude Agent SDK (in-process query, partial events);
   *   'codex-json'  — `codex exec --json` child with a typed event stream;
   *   'resume-exec' — session-pinned one-shot child (grok/opencode/cursor).
   */
  driver: 'claude-sdk' | 'codex-json' | 'resume-exec'
  /** The stdout protocol emitted by one headless turn. The daemon parses this
   * transport shape without branching on which harness selected it. */
  outputFormat: 'claude-stream-json' | 'codex-jsonl' | 'opencode-jsonl' | 'text'
  /**
   * How the persistent session id is allocated on the FIRST turn:
   *   'sdk-session-uuid' — server-minted UUID passed via the SDK's sessionId;
   *   'stream-captured'  — the harness mints it; captured from its JSON stream;
   *   'daemon-minted-uuid' — daemon mints a UUID (grok -s is create-or-resume);
   *   'create-chat'      — pre-allocated via a CLI call (cursor create-chat).
   */
  resumeIdAllocation: 'sdk-session-uuid' | 'stream-captured' | 'daemon-minted-uuid' | 'create-chat'
  /** Pure argv builder for the child-process drivers. Unsupported for
   *  'claude-sdk' (the SDK builds its own invocation). `env` (when present) is
   *  merged over the child's environment — codex passes its MCP bearer token here
   *  (POD-1021). */
  buildExec: Declared<
    (
      opts: HeadlessExecOptions,
      bins: HarnessBins,
    ) => { cmd: string; args: string[]; env?: Record<string, string> }
  >
}

// ---------------------------------------------------------------------------
// Per-session native-store observation — the session-observers axis (#249).
// ---------------------------------------------------------------------------

/** Exact durable lease handed to a causal provider observer. Optional on the
 * outer input only for mixed-version controls and non-causal adapters. */
export interface HarnessObservationLease {
  provider: ObservationProvider
  providerSessionId: string | null
  bindingVersion: number
  observerGeneration: number
  acceptedCheckpoint: SessionObservationCheckpointV1 | null
}

/** Provider-confirmed native-session replacement. The host fences this request
 * against the current lease and returns the resulting +1/+1 lease by ack. */
export interface HarnessProviderRebind {
  nextProviderSessionId: string
  resumeKind: string
  rebindId: string
}

export interface HarnessObserveInput {
  cwd: string
  /** Daemon-owned shared cadence for transcript and native-state stat polls. */
  statTick?: StatTick
  /** Stable Podium row identity whose native session this observer must find. */
  podiumSessionId?: SessionId
  /** The known harness conversation id (resume / reattach / headless bind);
   *  absent on a fresh spawn — the observer discovers the session the CLI
   *  creates. */
  resumeValue?: string
  /** Discovery homeDir override (tests / isolated HOME). */
  homeDir?: string
  /** Freshness floor for spawn-time session discovery, so a new pane can't
   *  latch onto an older sibling session in the same cwd. Omitted on reattach
   *  so discovery has no floor. */
  startedAtMs?: number
  /** The session's ORIGINAL spawn time, persisted by the server (reattach
   *  only). Codex uses it as the discovery floor: rollout files are created
   *  lazily (often at the first prompt), so the file can first appear only
   *  after a daemon restart — without a floor the reattached observer could
   *  never bind it and the session would stay status-blind forever. */
  createdAtMs?: number
  /** Recorded segment evidence (reattach): absolute transcript path, checked
   *  before any cwd-derived location (conversation registry §3.3). */
  pathHint?: string
  /** Durable causal observer lease and last accepted checkpoint [spec:SP-cdb2]. */
  observationLease?: HarnessObservationLease
}

/**
 * The daemon services an observation drives. The host owns the wire and the
 * per-session tail registry; the adapter owns WHAT to watch and WHEN to call
 * back. Every callback is per-session — the host closes over the session id.
 */
export interface HarnessObserverHost {
  /** (Re)point the session's live transcript tail at this file. The host maps
   *  records with THIS adapter's record→items mapper; re-pointing at the same
   *  path is a no-op. */
  tailFile(path: string): void
  /** The harness conversation id is known — the host records the resume ref,
   *  stamped with this adapter's `resumeKind`. Recording a resume ref marks
   *  the session resumable (→ hibernate button); the first transcript frame
   *  marks it chat-capable (→ chat switcher + BTW button). */
  onResumeValue(value: string, confidence?: 'exact' | 'heuristic'): void
  /** A derived human-readable title (codex: its OSC terminal title is just the
   *  cwd basename and is suppressed — the observer-derived title replaces it). */
  onTitle(title: string): void
  /** Normalized state events for the session's reducer. */
  onStateEvents(events: ProviderAgentStateEvent[]): void
  /** Provider-normalized causal evidence. The host validates the exact session,
   * provider, generation and binding before putting it on the wire. */
  onObservation(observation: AgentObservation): void
  /** The provider poll itself completed and found the accepted complete cursor unchanged. */
  onLiveObservationCycle?(providerCursor: ProviderCursor): void
  /** Request an atomic exact-provider native-session replacement. Merely
   * rebinding never changes phase or emits downstream state effects. */
  onExactProviderRebind(rebind: HarnessProviderRebind): void
  /** Live transcript items pushed by the observer itself (opencode: SQLite
   *  store, no file to tail; items arrive already cursor-stamped). */
  onTranscriptItems(items: TranscriptItem[], reset: boolean): void
}

export interface HarnessObservation {
  /** Stop watching (session exit/kill, daemon dispose). Does NOT stop the
   *  transcript tail — the host owns that registry. */
  stop(): void
  /** Hook-channel binding (codex native hooks): the hook payload names the
   *  thread this pane REALLY runs, ending any discovery ambiguity (lazy rollout
   *  creation, cwd siblings, a mid-session /new rolling to a fresh thread).
   *  Re-pins the observation only when its current binding disagrees — every
   *  later POST is a cheap comparison. Absent for harnesses without a hook
   *  re-pin policy. */
  bindHookThread?(threadId: string): void
  /** Server durability acknowledgement, routed only to the exact live lease. */
  onObservationAck?(ack: AgentObservationAckMessage): void
  /** Result of an exact native-session replacement request. */
  onProviderRebindAck?(ack: AgentObservationRebindAckMessage): void
}

/** Start this harness's per-session native-store observation: the state
 *  observer polling its session store (grok/codex/opencode/cursor) and/or the
 *  live transcript tail bootstrap (claude-code, whose state instead arrives on
 *  the hook channel). */
export type HarnessObserver = (
  input: HarnessObserveInput,
  host: HarnessObserverHost,
) => HarnessObservation

// ---------------------------------------------------------------------------
// Transcript reads.
// ---------------------------------------------------------------------------

export interface TranscriptSourceInput {
  cwd: string
  resumeValue?: string
  /** Recorded segment evidence: absolute transcript path, checked before any
   *  cwd-derived location (conversation registry §3.3). */
  pathHint?: string
  homeDir?: string
}

export interface HarnessTranscript {
  storage: 'file-chain' | 'sqlite'
  /** Pure native-record parser selected by this manifest. SQLite-backed
   *  transcripts declare this unsupported because their adapter maps typed rows
   *  before applying the storage-neutral slice contract. */
  recordToItems: Declared<TranscriptRecordMapper>
  /** Pure native-record reader for RUNTIME facts — the model, effort and context
   *  use this harness actually reports. Separate from `recordToItems` because it
   *  answers a different question about the same record: that one produces the
   *  conversation, this one produces what the agent is running as. Unsupported ⇒
   *  no observed model/effort/context for this harness; the transcript still
   *  reads. */
  recordRuntime: Declared<TranscriptRuntimeReader>
  /** Ordered oldest→newest JSONL files for a session ('file-chain' storage only;
   *  unsupported for 'sqlite', which has no files to chain). Every file-based
   *  harness resolves the SPECIFIC conversation by its resume value — a cwd
   *  bucket holds many DISTINCT conversations, so globbing the bucket would merge
   *  unrelated sessions; no resume value ⇒ []. */
  chainPaths: Declared<(input: TranscriptSourceInput) => Promise<string[]>>
  /** Resolve this session's transcript read source (file chain or DB-backed). */
  sourceFor(input: TranscriptSourceInput): Promise<TranscriptSource>
}

/** Build the common file-backed transcript declaration without restating its
 * mapper in both `recordToItems` and `sourceFor`. The parser implementation stays
 * in browser-safe @podium/transcript (ADR 8 D4.3); the per-CLI manifest owns the
 * choice of which parser applies. */
export function fileTranscript(
  chainPaths: (input: TranscriptSourceInput) => Promise<string[]>,
  recordToItems: TranscriptRecordMapper,
  recordRuntime?: TranscriptRuntimeReader,
): HarnessTranscript {
  return {
    storage: 'file-chain',
    recordToItems: supported(recordToItems),
    recordRuntime: recordRuntime
      ? supported(recordRuntime)
      : unsupported('this harness does not report model, effort or context use in its records'),
    chainPaths: supported(chainPaths),
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((path) => ({ path, fileId: fileIdFor(path) }))
      return fileChainSource(chain, recordToItems)
    },
  }
}

// ---------------------------------------------------------------------------
// Browser-open classification — harness-specific intent, ahead of the daemon's
// generic redirect_uri fallback. [spec:SP-a43e]
// ---------------------------------------------------------------------------

/** An adapter's verdict on a forwarded browser-open URL: 'login' keeps the
 * pending-login affordance (callback paste-back when a loopback target is
 * derivable); 'link' is a plain open — confirm toast only, no login card and
 * no callback capability. `undefined` = the adapter doesn't recognize the URL
 * and the generic heuristic decides. */
export interface BrowserOpenClassification {
  intent: 'login' | 'link'
}

export interface HarnessHandoffTranscript {
  transcriptPlacement(input: {
    cwd: string
    homeDir: string
    resumeValue: string
    filename: string
    relativeDir?: string
  }): string
  transcriptForExport(input: {
    cwd: string
    homeDir: string
    resumeValue: string
  }): Promise<{ path: string; relativeDir?: string }>
}

// ---------------------------------------------------------------------------
// The adapter — ONE object per harness; the registry is the only dispatch.
// ---------------------------------------------------------------------------

/**
 * Everything Podium needs to drive one coding-agent CLI (#158/#249) — ONE object
 * per CLI, and the single home for behavioral variance between them. A new
 * harness is ONE manifest file + a registry entry (the exhaustive
 * `Record<BuiltinHarnessKind, AgentManifest>` makes a missing kind a type error).
 * The daemon is a generic host
 * over this interface: launch, exec, headless turns, per-session observation and
 * transcript reads all dispatch through the registry — no per-agent tables and no
 * `if (kind === 'codex')` outside it.
 *
 * TOTALITY vs IMPLEMENTATION (POD-303). Every field below must be DECLARED — the
 * compiler enforces that. Fields typed `Declared<T>` need not be IMPLEMENTED: a
 * harness may land with launch and discovery only and say `unsupported('…')` for
 * the rest, then grow them in later PRs. The three always-required fields
 * (`launch`, `discovery`, `inventory`) are the irreducible minimum for a harness
 * Podium can spawn and find conversations for; anything less is not a harness.
 *

 * PRINCIPAL-FREE. A manifest describes SOFTWARE, never a person. It carries no
 * owner, no user id, no visibility class and no grant check — see `HarnessId` in
 * @podium/protocol for why that separation is load-bearing, and
 * docs/multi-user-readiness.md §3.1.1 for where authorization does live. The
 * per-machine RESOLVED fact ("claude-code is installed here, at this version") is
 * a different thing entirely: see `MachineHarnessInventory` in
 * ./inventory/build-inventory.ts.
 */
export interface AgentManifest {
  kind: BuiltinHarnessKind
  /** Human-facing CLI/provider name for diagnostics. */
  displayName: string
  /** Static SOFTWARE facts for this CLI. These are deliberately declared beside
   * transcript mapping and launch behavior rather than in a parallel table. */
  capabilities: HarnessCapabilities
  /** The resume.kind stamped on this harness's native conversations. */
  resumeKind: string
  /** Machine-local installation and account discovery owned by this harness. */
  inventory: HarnessInventory
  /** Interactive spawn command (fresh vs resume, model/effort flags, argv prompt). */
  launch(opts: HarnessLaunchOptions): LaunchSpec
  /** Native-conversation discovery provider. */
  discovery: ConversationProvider
  /** One-shot full-harness turn (`claude -p` / `codex exec` …). Unsupported ⇒ the
   *  harness cannot serve superagent/work-LLM turns; callers pick another. */
  exec: Declared<(opts: HarnessExecOptions, bins: HarnessBins) => HarnessExecSpec>
  /** Persistent headless sessions. Unsupported ⇒ no headless driver; the session
   *  must run interactively over a PTY. */
  headless: Declared<HarnessHeadless>
  /** Hook/observer state provider. Unsupported ⇒ phase stays 'unknown' rather
   *  than being guessed from another harness's output conventions. */
  state: Declared<AgentStateProvider>
  /** State channels in strict preference order; software provenance only. */
  stateChannels: readonly StateChannelDeclaration[]
  /** Per-session native-store observation (state observer + live tail setup).
   *  Unsupported ⇒ no native-store observation; transcript and status stay blind. */
  observer: Declared<HarnessObserver>
  /** Transcript relocation for cross-machine handoff. Unsupported means this
   * harness cannot be packaged even if it otherwise has readable history. */
  handoffTranscript: Declared<HarnessHandoffTranscript>

  /** Transcript reads. Unsupported ⇒ this harness's conversations cannot be read
   *  back (no chat switcher, no BTW); the session still runs. POD-398 folds the
   *  per-CLI record→items mappers in behind this field. */
  transcript: Declared<HarnessTranscript>
  /** Harness-specific browser-open classification (this harness's known login
   *  vs plain-link URLs), consulted BEFORE the daemon's generic redirect_uri
   *  heuristic. Unsupported (or returning undefined) ⇒ generic fallback decides.
   *  POD-738 owns making this a fully declared capability. */
  classifyBrowserOpen: Declared<(url: URL) => BrowserOpenClassification | undefined>
}

export interface StateChannelDeclaration {
  source: AgentStateEventSource
  confidence: number
  /** Concrete native mechanism and turn boundary for capability ledgers. */
  mechanism: string
  fallbackWhen?: string
}

/** Static per-CLI feature declarations. This is software metadata: it carries no
 * machine, owner, principal, grant, or visibility state. Resolved installation
 * availability is the separate machine-keyed `MachineHarnessInventory`. */
export interface HarnessCapabilities {
  /** Accepts the first prompt as a trailing positional argv token. */
  argvPrompt: boolean
  /** How a reasoning-effort override reaches the CLI. */
  effortFlag: 'effort' | 'codex-config' | 'variant' | 'none'
  /** Has a native extra-system-prompt flag. */
  systemPromptFlag: boolean
  /** The host can read local quota/rate-limit state. */
  quota: boolean
  /** Sessions of this kind can move to a cloud runtime. */
  cloud: boolean
  /** The web controller can scrape the native TUI composer. */
  composerScrape: boolean
  /** The CLI's OSC terminal title is meaningful and should be forwarded. */
  oscTitle: boolean
  /** Reads a native subagent-model environment variable. */
  subagentModelEnv: boolean
  /** Native TUI honours Podium's prompt-mode hint keys. */
  promptModeHints: boolean
  /** Sessions can be packaged and moved to another machine. */
  handoff: boolean
  /** A one-shot invocation can mount Podium's HTTP MCP tool endpoint. */
  mcp: 'full' | 'none'
  /** How Podium state hooks reach the harness. */
  hookInstall: 'settings-args' | 'global-env' | 'none'
  /** Durable observation provider persisted on the server, when one exists. */
  observationProvider: ObservationProvider | 'none'
  /** Binding/ack protocol used by the daemon observer host. */
  observationProtocol: 'claude-causal' | 'codex-exact' | 'generic'
  /** A submitted CR needs transcript/state verification and bounded retry. */
  submitVerification: boolean
  /** Interactive native resume ids must be exclusive to one Podium pane. */
  exclusiveInteractiveResume: boolean
  /** First user transcript item may replace the generic launch title. */
  promptTitleFallback: boolean
  /** How a one-shot invocation receives Podium's MCP configuration. */
  mcpConfigTransport: 'path' | 'inline' | 'none'
}

/** @deprecated Renamed to `AgentManifest` (POD-303/POD-325 vocabulary: the object
 *  is a manifest, not an adapter). Alias kept so POD-398/399 can retire the last
 *  external call sites without widening this leaf's diff. */
export type HarnessAdapter = AgentManifest

/** 'auto' (or empty) is the sentinel for "no override" — the CLI decides. */
export function isSet(value: string | undefined): value is string {
  return !!value && value !== 'auto'
}

/** Shared by the file-chain adapters' `chainPaths` existence checks. */
export async function transcriptFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
