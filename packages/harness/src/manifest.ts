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
  /** A caller-chosen native id for a NEW conversation (capabilities.newSessionIdFlag).
   *  Mutually exclusive with `resume`: it names the session the CLI is about to
   *  create, so the host knows the native id — and its transcript path — from the
   *  spawn instead of discovering it after the first turn. [POD-386] */
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  newSessionId?: string
  /** Model override from settings; absent (or 'auto') = the CLI's own default. */
  model?: string
  /** Reasoning-effort override; absent (or 'auto') = the CLI's own default. */
  effort?: string
  /** A first prompt handed as a trailing positional argv token where the CLI
   *  supports it (capabilities.argvPrompt); ignored otherwise. Adapters MUST
   *  emit it through `promptArgv`, which guards the `--` boundary so an
   *  option-like prompt is not parsed as a flag. */
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
  /** Provider-specific reasoning/effort variant (OpenCode uses --variant). */
  effort?: string
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

// ---------------------------------------------------------------------------
// Machine inventory — install and login discovery.
// ---------------------------------------------------------------------------

/** Best-effort native login state for one harness on one machine. `account` is
 * a safe, human-facing label only (never a token or raw credential). */
export interface LoginIdentity {
  fingerprint: string
  email?: string
  /** UNBRANDED BY DECISION: a provider account id, not a server-minted Podium AccountId. */
  providerAccountId?: string
}

export interface PortableCredential {
  files: readonly string[]
  compareFreshness(a: string, b: string): -1 | 0 | 1 | null
}

export interface HarnessLogin {
  state: 'in' | 'out' | 'unknown'
  account?: string
  identity?: LoginIdentity
  freshness?: number
}

/** Complete, bounded output from a non-interactive native login probe. */
export interface LoginCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut: boolean
  /** Bounded OS/runtime category such as ENOENT or ERR_CHILD_PROCESS_STDIO_MAXBUFFER. */
  readonly errorCode?: string
}

export type LoginCommandDecision =
  | { readonly kind: 'determined'; readonly login: HarnessLogin }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'unknown'; readonly reason: string }

export interface HarnessLoginCommandProbe {
  readonly args: readonly string[]
  readonly timeoutMs: number
  classify(result: LoginCommandResult): LoginCommandDecision
}

export interface HarnessExecutableDeclaration {
  /** Bare executable names in PATH precedence order. */
  names: readonly string[]
  /** Harness-owned locations outside generic command-environment fallbacks. */
  fallbackCandidates?: (machineHome: string) => readonly string[]
  versionArgs: readonly string[]
  /** Optional stronger identity probe for ambiguous executable names. */
  identityProbe?: {
    args: readonly string[]
    accepts(output: string): boolean
  }
}

export interface HarnessInventory {
  executable: HarnessExecutableDeclaration
  /** Read-only local credential/profile detection. Uneven support is explicit. */
  detectLogin(homeDir: string): HarnessLogin
  /** Authoritative native login probe. Local detection is only its compatibility fallback. */
  loginCommandProbe: Declared<HarnessLoginCommandProbe>
  /** Native interactive authentication entry point. The daemon launches this in
   * a PTY; the server and browser never encode provider OAuth behavior. */
  loginCommand: Declared<{ cmd: string; args: readonly string[] }>
  loginIdentity: Declared<(homeDir: string) => LoginIdentity | undefined>
  portableCredential: Declared<PortableCredential>
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
  /** Fail-closed capability request. `none` means the adapter must remove every
   * built-in, MCP, web, subagent and shell tool. */
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** The pinned harness session id (pre-minted for grok/cursor). */
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
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
  /** A native, tested all-tools-off mechanism, or an explicit refusal. */
  noTools: 'enforced' | 'unsupported'
  /** Pure argv builder for the child-process drivers. Unsupported for
   *  'claude-sdk' (the SDK builds its own invocation). `env` (when present) is
   *  merged over the child's environment — codex passes its MCP bearer token here
   *  (POD-1021). */
  buildExec: Declared<
    (opts: HeadlessExecOptions) => { cmd: string; args: string[]; env?: Record<string, string> }
  >
}

// ---------------------------------------------------------------------------
// Per-session native-store observation — the session-observers axis (#249).
// ---------------------------------------------------------------------------

/** Exact durable lease handed to a causal provider observer. Optional on the
 * outer input only for mixed-version controls and non-causal adapters. */
export interface HarnessObservationLease {
  provider: ObservationProvider
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  providerSessionId: string | null
  bindingVersion: number
  observerGeneration: number
  acceptedCheckpoint: SessionObservationCheckpointV1 | null
}

/** Provider-confirmed native-session replacement. The host fences this request
 * against the current lease and returns the resulting +1/+1 lease by ack. */
export interface HarnessProviderRebind {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
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
  /** The provider reports the model/effort it actually used. */
  onModel?(model: string, effort?: string): void
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
  /** UNBRANDED BY DECISION: a provider/harness-native thread id, not a Podium messaging ThreadId. */
  bindHookThread?(threadId: string): void
  /** Server durability acknowledgement, routed only to the exact live lease. */
  onObservationAck?(ack: AgentObservationAckMessage): void
  /** Result of an exact native-session replacement request. */
  onProviderRebindAck?(ack: AgentObservationRebindAckMessage): void
  /** HTTP hook payload. Return true when the adapter handled it on the causal
   *  path so the host does not emit a legacy unfenced agentState. */
  onHookPayload?(payload: unknown): boolean
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
// The runtime axis — how this CLI can be DRIVEN (POD-1761 W1).
// docs/2026-08-07-agent-runtime-architecture.html §2, §3 "Manifest integration".
// ---------------------------------------------------------------------------

/**
 * ONE AXIS INSTEAD OF MORE FLAGS.
 *
 * The manifest already answers "how do I launch this CLI interactively"
 * (`launch`), "how do I run one shot" (`exec`) and "does it have a persistent
 * headless mode" (`headless`). Those three grew independently and each carries
 * its own launch shape. `runtime` is the axis they fold INTO: it says which
 * DRIVER FAMILIES this harness supports and how to reach each one, so that
 * codex-terminal → codex-server becomes a `select()` result rather than a new
 * flag every consumer has to learn.
 *
 * DECLARATIONS ONLY IN W1. Nothing reads this yet — W3 wires the terminal
 * driver behind it and W5 the opencode server driver. It lands now, ahead of
 * both, because a manifest field that arrives WITH its first consumer gets
 * shaped by that consumer's convenience; one that arrives first has to be
 * argued from the harnesses.
 *
 * WHY `terminal` IS REQUIRED AND THE OTHER TWO ARE NOT. Every harness Podium
 * ships can be driven by emulating a user at a TUI — that is the current stack,
 * and §2's decision is that it is a PERMANENT tier, not a deprecation path: it
 * is the only subscription-preserving way to run Claude Code and the only way to
 * run harnesses that never grow a protocol. A `server` or `embedded` spec is a
 * capability a vendor either shipped or did not, so both are `Declared<T>` and
 * say WHY when absent.
 */
export interface AgentRuntimeAxis {
  /**
   * The harness's own server, and how to launch and address it. Unsupported ⇒
   * this CLI has no server mode, so the server family is simply unavailable and
   * `select()` must never return one of its ids.
   */
  server: Declared<ServerRuntimeSpec>
  /**
   * The harness ships a library rather than a server, and the runtime hosts the
   * agent loop in a worker child it owns. Unsupported ⇒ no SDK to host.
   */
  embedded: Declared<EmbeddedRuntimeSpec>
  /** ALWAYS PRESENT: today's `launch()` + composer + state providers, named as a
   *  driver family rather than as "the way sessions work". */
  terminal: TerminalRuntimeSpec
  /**
   * Which driver to use for one session. A PURE function of the selection
   * context — no clock, no filesystem, no network — because the server plans a
   * spawn with it and the machine performs one with it, and the two must agree.
   *
   * TOTAL: it always returns an id, because a caller planning a spawn has no
   * sensible branch for "no answer". When `ctx.available` contains any candidate
   * the policy ranks, the answer is one of those. When it contains NONE — an
   * unusable or not-yet-probed machine — the answer is this harness's TERMINAL
   * driver id, which the caller must treat as a diagnostic ("this machine
   * reports it cannot run this harness") rather than as a green light.
   *
   * The alternative — returning `undefined` and making every caller invent a
   * fallback — pushes the same decision to N call sites and guarantees they
   * disagree. See {@link selectRuntimeDriver}, which is where the rule is
   * implemented once.
   */
  select(ctx: SelectionContext): DriverId
}

/**
 * THE DRIVER TAXONOMY IS DEFINED HERE, and `@podium/agent-runtime` re-exports it.
 *
 * The direction is forced: agent-runtime imports this package, never the
 * reverse, and a cycle would be rejected by turbo, `declared-deps` and the layer
 * manifest alike. So the names the MANIFEST needs — the families, the driver
 * ids, the three `*RuntimeSpec` shapes and the selection context — live beside
 * the manifest that declares them, and the runtime package aliases them rather
 * than keeping a second copy reconciled by a test.
 *
 * CLOSED on purpose: a driver lands as code in `packages/agent-runtime`, so a
 * new id is a deliberate edit here rather than a string that typos silently.
 */
/**
 * The three ways a harness can be driven (spec §2). A harness may support
 * several; `select()` picks one per session at spawn.
 *
 * `terminal` IS A PERMANENT TIER, NOT A DEPRECATION PATH: it is the only
 * subscription-preserving way to run Claude Code and the only way to run a
 * harness that never grows a protocol. What changes is its RANK — it stops
 * being the definition of a session and becomes one driver behind one contract.
 */
export type DriverFamily = 'server' | 'embedded' | 'terminal'

export const DRIVER_IDS = [
  /** `codex app-server` over JSON-RPC on a per-session unix socket (W6). */
  'codex-app-server',
  /** `opencode serve` over HTTP + SSE on a secret-guarded loopback port (W5). */
  'opencode-server',
  /** `grok agent stdio` over ACP JSON-RPC (W7). */
  'grok-acp',
  /** The Claude Agent SDK loop, hosted in a runtime-owned worker child. */
  'claude-sdk',
  /** Today's interactive Claude CLI under abduco, wrapped (W3). */
  'claude-pty',
  /** The same terminal mechanism for harnesses with no protocol (grok, cursor). */
  'generic-pty',
  /** The in-memory reference driver the conformance corpus runs against. */
  'fake',
] as const

/** A CONST ARRAY rather than a bare union, so the set exists at RUN time too:
 *  the conformance corpus checks that every manifest names a driver this build
 *  knows, and a type-only union cannot be iterated to do that. */
export type DriverId = (typeof DRIVER_IDS)[number]

/** What `select()` is allowed to decide on. `auth` is the load-bearing axis:
 *  Claude on a subscription is terminal (the compliant path) and on an API key
 *  is embedded. */
export interface SelectionContext {
  auth: 'subscription' | 'api-key' | 'bedrock' | 'vertex' | 'unknown'
  platform: NodeJS.Platform
  /** Driver ids this machine can actually run right now: binary present,
   *  version in the pinned range. May be EMPTY on a machine that has not been
   *  probed or cannot run this harness at all — see `select()` for what that
   *  answers. */
  available: readonly DriverId[]
  /** The operator's explicit choice, honoured over the policy's own preference —
   *  but still only if it is available. */
  preference?: DriverId
  role?: 'interactive' | 'executor'
}

/**
 * How to launch and address the harness's own server.
 *
 * `transport` is not decoration: it is the security posture. A unix socket at
 * mode 0600 authenticates by filesystem permission; a loopback TCP port
 * authenticates by NOTHING unless a secret is required, and an unauthenticated
 * per-session HTTP server holding a credentialed agent is not acceptable even on
 * loopback — every local process and user can reach it (spec §6). Hence
 * `requiresPerSessionSecret`, which the opencode driver must honour and the
 * conformance suite tests.
 */
export interface ServerRuntimeSpec {
  driverId: DriverId
  kind: 'jsonrpc' | 'http-sse'
  /** argv that starts the server. The port/socket is chosen per session by the
   *  driver, so this is the STEM, not a complete command line. */
  spawn: readonly string[]
  /**
   * `stdio` IS THE CHILD'S OWN PIPE PAIR, added by W6 after measuring codex.
   *
   * The plan expected a per-session unix socket there and codex does create one
   * — but it is a daemon CONTROL socket that closes the connection on a JSON-RPC
   * `initialize`, including through codex's own proxy bridge. An inherited pipe
   * is the actual client channel, and for spec section 6's purposes it is the
   * strongest of the three: no filesystem object, no port, nothing for another
   * local process to reach by name. Hence `requiresPerSessionSecret: false` for
   * a reason rather than as an omission.
   */
  transport: 'unix-socket' | 'loopback-tcp' | 'stdio'
  /**
   * MANDATORY for loopback TCP: an unauthenticated per-session HTTP server
   * holding a credentialed agent is reachable by every local process and user,
   * which is not acceptable even on loopback. This is the POLICY, declared in
   * W1 because it is an architectural commitment rather than a protocol detail.
   */
  requiresPerSessionSecret: boolean
  /**
   * The env var the secret rides in — SPAWN ENV, NEVER ARGV (the hook-port
   * discipline, unchanged), and named here so a driver cannot invent one.
   *
   * ABSENT UNTIL THE DRIVER VERIFIES IT. The exact variable is a fact about a
   * vendor's pre-1.0 CLI, and W1 has no client with which to check it; writing a
   * plausible name here would be a guess that reads as a citation.
   */
  secretEnvVar?: string
  /** Where the OpenAPI document lives, for the drivers that generate a client. */
  openapiPath?: string
  /**
   * The harness versions this driver speaks. The server family's crown jewels
   * ride pre-1.0, vendor-internal protocols — codex app-server has already
   * renamed its approval methods once. The stance is the codex-hooks
   * minor-version gate: refuse loudly with a machine diagnostic, never guess.
   *
   * `Declared<T>`, and UNSUPPORTED in W1 for every harness, because a range is a
   * claim about which wire shapes this build has actually been tested against.
   * The driver items (W5, W6) pin it against recorded fixtures. An invented
   * range would be worse than none: it would let a driver start against a
   * protocol nobody verified while looking like it had been checked.
   */
  versionRange: Declared<string>
}

/** The harness ships a library; the runtime hosts the loop in a worker child it
 *  owns — deliberately NOT in the supervisor's heap, so a runaway embedded
 *  session cannot OOM the daemon (spec §6). */
export interface EmbeddedRuntimeSpec {
  driverId: DriverId
  module: string
  /** Auth modes the SDK actually supports headlessly. Subscription OAuth is
   *  absent from every entry today, which is exactly why Claude-on-subscription
   *  selects terminal. */
  auth: readonly ('api-key' | 'bedrock' | 'vertex')[]
}

/** Today's stack, named. There is no new mechanism here — `launch()` above is
 *  still the spawn — but the family needs an id and needs to say what it can
 *  prove about a send. */
export interface TerminalRuntimeSpec {
  driverId: DriverId
  /**
   * How this harness's terminal driver proves a send was accepted, in preference
   * order. `hook` is available only where a CAUSAL hook exists — Claude's
   * `UserPromptSubmit` — and where it does not, `transcript-echo` is the
   * fallback and `unverified` is the honest outcome when even that times out.
   */
  sendProof: readonly ('hook' | 'transcript-echo')[]
}

/**
 * The shared body of every `select()`: honour an available preference, else take
 * the first available driver in the harness's own ranked order.
 *
 * `ranked` MUST end with this harness's terminal driver id, and that is not a
 * convention — it is what makes the function total. The terminal family is
 * always present (§2), so it is always a legal answer, and a selection policy
 * that could return "nothing" would push a fallback decision into every caller.
 * The last entry is returned even when `available` does not list it: a machine
 * reporting no runnable driver at all is an inventory problem, and answering it
 * with a driver id that then fails to start is a better diagnostic than
 * answering it with silence.
 *
 * Five one-line `select()` implementations rather than five copies of this
 * logic — the per-harness variance is the ORDER, which is the thing worth
 * reading in each manifest.
 */
export function selectRuntimeDriver(
  ctx: SelectionContext,
  ranked: readonly [...DriverId[], DriverId],
): DriverId {
  const available = new Set(ctx.available)
  // An explicit operator choice wins over the policy — but only if the machine
  // can actually run it. Honouring an unavailable preference would turn a
  // settings toggle into a broken session.
  if (ctx.preference && available.has(ctx.preference)) return ctx.preference
  for (const id of ranked) if (available.has(id)) return id
  return ranked[ranked.length - 1] as DriverId
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
  exec: Declared<(opts: HarnessExecOptions) => HarnessExecSpec>
  /** Persistent headless sessions. Unsupported ⇒ no headless driver; the session
   *  must run interactively over a PTY.
   *  SUPERSEDED IN DIRECTION by `runtime` below (POD-1761): a superagent thread
   *  becomes an ordinary runtime session with no attach, and this axis retires
   *  once server drivers carry the harnesses that use it. Still authoritative
   *  today — nothing reads `runtime` yet. */
  headless: Declared<HarnessHeadless>
  /** WHICH DRIVER FAMILIES this CLI supports and how to reach each (POD-1761).
   *  Required, so a new harness cannot land without saying how it is driven —
   *  the same totality argument as every other field here. Declarations only in
   *  W1: W3 wires the terminal driver behind it, W5 the opencode server one. */
  runtime: AgentRuntimeAxis
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
  /** An interactive launch accepts a caller-chosen id for a NEW conversation
   *  (HarnessLaunchOptions.newSessionId), and creating the session that way
   *  materializes its transcript at boot rather than at the first turn. Declaring
   *  it makes the daemon mint the id, so a session that is spawned and left idle
   *  is still bound and readable. [POD-386] */
  newSessionIdFlag: boolean
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
  /**
   * The first user turn cannot be started by bracketed-paste into a fresh TUI.
   * Chat send must type the prompt as raw keystrokes (the native-view path)
   * until a user turn exists; later turns keep paste. [POD-549, POD-901]
   */
  rawFirstTurn: boolean
  /** Interactive native resume ids must be exclusive to one Podium pane. */
  exclusiveInteractiveResume: boolean
  /** First user transcript item may replace the generic launch title. */
  promptTitleFallback: boolean
  /** How a one-shot invocation receives Podium's MCP configuration. */
  mcpConfigTransport: 'path' | 'inline' | 'none'
  /**
   * The keystroke that aborts a RUNNING turn in this CLI's interactive TUI.
   * There is no universal one: claude-code and grok cancel on Esc and ignore
   * Ctrl-C, codex ignores Esc entirely (single AND double) and cancels on
   * Ctrl-C. Sending the wrong one is a silent no-op, which is what
   * `sessions.interrupt` did for every codex session before POD-1214.
   */
  interruptKey: 'esc' | 'ctrl-c'
  /**
   * Pressing {@link interruptKey} while NO turn is running exits the CLI.
   * Measured on codex 0.147.0: one Ctrl-C at an idle prompt quits outright (not
   * the two-press confirm its docs imply), so an abort aimed at a turn that has
   * already ended would kill the session instead. Declared per harness rather
   * than derived from the key, because a `shell` session's Ctrl-C is harmless at
   * a prompt while codex's is terminal.
   */
  interruptQuitsWhenIdle: boolean
}

/** @deprecated Renamed to `AgentManifest` (POD-303/POD-325 vocabulary: the object
 *  is a manifest, not an adapter). Alias kept so POD-398/399 can retire the last
 *  external call sites without widening this leaf's diff. */
export type HarnessAdapter = AgentManifest

/** 'auto' (or empty) is the sentinel for "no override" — the CLI decides. */
export function isSet(value: string | undefined): value is string {
  return !!value && value !== 'auto'
}

/**
 * The trailing argv tokens that hand an argv-capable CLI its initial prompt.
 *
 * The `--` is load-bearing: every CLI Podium launches parses argv with a
 * conventional parser (commander for claude, clap for codex/grok), and a prompt
 * whose first character is `-` — a bullet list, a diff hunk, a flag the user
 * quoted — is read as an option instead of the positional prompt. Claude 2.1.234
 * given a description starting `- remove` died in ~1s with
 * `error: unknown option '- remove …'`, before any conversation or transcript
 * existed; clap prints the same fix as its own tip ("to pass '- ' as a value,
 * use '-- - '"). `--` ends option parsing, so the prompt reaches the agent
 * verbatim whatever it contains [POD-1317].
 *
 * A blank or whitespace-only prompt yields no tokens at all — a bare launch
 * stays bare, and no stray `--` reaches the CLI. The prompt itself is passed
 * UNTRIMMED: only the emptiness test trims, so leading indentation the user
 * wrote survives.
 */
export function promptArgv(initialPrompt: string | undefined): string[] {
  return initialPrompt?.trim() ? ['--', initialPrompt] : []
}

/** Shared by the file-chain adapters' `chainPaths` existence checks. */
export async function transcriptFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
