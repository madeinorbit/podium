import { z } from 'zod'

const positiveInt = z.number().int().positive()

export const Geometry = z.object({ cols: positiveInt, rows: positiveInt })
export type Geometry = z.infer<typeof Geometry>

export const Viewport = z.object({
  cols: positiveInt,
  rows: positiveInt,
  dpr: z.number().positive(),
})
export type Viewport = z.infer<typeof Viewport>

export const AgentKind = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell'])
export type AgentKind = z.infer<typeof AgentKind>

export const ResumeRef = z.object({ kind: z.string(), value: z.string() })
export type ResumeRef = z.infer<typeof ResumeRef>

export const SessionStatus = z.enum(['starting', 'live', 'reconnecting', 'hibernated', 'exited'])
export type SessionStatus = z.infer<typeof SessionStatus>

// ---- Agent runtime state (harness-observed, distinct from SessionStatus) ----
// SessionStatus says whether the PTY/process is alive (starting/live/hibernated/…).
// AgentRuntimeState says what the agent inside it is doing, derived from harness
// side-channels (hooks). `unknown` = uninstrumented agent kind or no events yet.
export const AgentPhase = z.enum([
  'unknown',
  'working',
  'idle',
  'needs_user',
  'errored',
  'compacting',
  'ended',
])
export type AgentPhase = z.infer<typeof AgentPhase>

// Why did the agent go idle? `open_todos` = stopped with unfinished task list;
// `question` = last message reads like it wants an answer; `approval` = stopped
// while in plan mode; `interrupted` = user explicitly aborted the running turn.
// Tier-3 (LLM classification) will refine this later.
export const IdleVerdict = z.object({
  kind: z.enum(['done', 'question', 'approval', 'open_todos', 'interrupted']),
  summary: z.string().optional(),
})
export type IdleVerdict = z.infer<typeof IdleVerdict>

export const AgentNeed = z.object({
  kind: z.enum(['question', 'permission']),
  summary: z.string().optional(),
})
export type AgentNeed = z.infer<typeof AgentNeed>

export const AgentError = z.object({
  class: z.string(), // harness error class, e.g. rate_limit / server_error / billing_error
  retryable: z.boolean(), // true → a blind "continue" is worth offering
})
export type AgentError = z.infer<typeof AgentError>

export const AgentRuntimeState = z.object({
  phase: AgentPhase,
  since: z.string(), // ISO 8601 of the last phase change
  openTaskCount: z.number().int().nonnegative(),
  idle: IdleVerdict.optional(), // present when phase === 'idle'
  need: AgentNeed.optional(), // present when phase === 'needs_user'
  error: AgentError.optional(), // present when phase === 'errored'
})
export type AgentRuntimeState = z.infer<typeof AgentRuntimeState>

export const SessionOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn') }),
  z.object({ kind: z.literal('resume'), conversationId: z.string() }),
])
export type SessionOrigin = z.infer<typeof SessionOrigin>

// The state of the WORK a session carries (kanban column on the home board) —
// user-sorted, unlike AgentPhase which is harness-observed.
export const WorkState = z.enum(['planning', 'implementing', 'testing', 'done', 'icebox'])
export type WorkState = z.infer<typeof WorkState>

export const SessionMeta = z.object({
  sessionId: z.string(),
  agentKind: AgentKind,
  title: z.string(),
  /** User-set name. Wins over `title` (the live terminal title) wherever shown. */
  name: z.string().optional(),
  cwd: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().optional(), // present only when status === 'exited'
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO 8601
  lastActiveAt: z.string(), // ISO 8601 — recency signal for the home board
  origin: SessionOrigin,
  agentState: AgentRuntimeState.optional(),
  archived: z.boolean(),
  workState: WorkState.optional(),
  /** True when a resume ref is known — hibernate→resume is possible. */
  resumable: z.boolean().optional(),
  /** The native CLI resume ref (kind + value) when known — the conversation id
   *  the harness reattaches to. Lets the client surface the literal
   *  `claude --resume <id>` / `codex resume <id>` command without a round-trip.
   *  Present only when `resumable`; omitted for shells / not-yet-known sessions. */
  resume: ResumeRef.optional(),
  /** True once a structured transcript has been observed for this session — the
   *  capability that powers chat view. Set by the layer that owns the tail, so a
   *  new transcript provider lights up chat with no client-side kind checks. */
  transcriptAvailable: z.boolean().optional(),
  /** True while the session is actively writing to its PTY (debounced). The
   *  activity signal for uninstrumented kinds with no agentState — a shell reads
   *  as "working" only while a process is producing output, idle at its prompt. */
  busy: z.boolean().optional(),
  /** The agent's self-chosen identity colour (Claude's `/color`): a named colour
   *  — red|blue|green|yellow|purple|orange|pink|cyan — used to tell agents apart,
   *  shown as the tab/sidebar accent line. Absent / 'default' = no colour. This is
   *  identity, distinct from the runtime *status* dot. */
  agentColor: z.string().optional(),
  /** Snooze state — orthogonal to agentState. `undefined`/absent = not snoozed;
   *  `null` = snoozed until the next message; an ISO string = snoozed until that
   *  time (or the next message, whichever first). Drives the sidebar's attention
   *  triage only; never changes the agent's phase. */
  snoozedUntil: z.string().nullable().optional(),
})
export type SessionMeta = z.infer<typeof SessionMeta>

// Discovery payloads on the wire — dates are ISO strings (Date is not JSON-safe).
export const ConversationGit = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  originUrl: z.string().optional(),
})
export type ConversationGit = z.infer<typeof ConversationGit>
export const ConversationSummaryWire = z.object({
  id: z.string(),
  agentKind: AgentKind,
  title: z.string().optional(),
  projectPath: z.string().optional(),
  parentConversationId: z.string().optional(),
  statusHint: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  git: ConversationGit.optional(),
  resume: ResumeRef.optional(),
  providerId: z.string(),
})
export type ConversationSummaryWire = z.infer<typeof ConversationSummaryWire>

export const ConversationDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  providerId: z.string().optional(),
  root: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
})
export type ConversationDiagnosticWire = z.infer<typeof ConversationDiagnosticWire>

export const GitWorktreeWire = z.object({
  path: z.string(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type GitWorktreeWire = z.infer<typeof GitWorktreeWire>

export const GitRepositoryWire = z.object({
  path: z.string(),
  kind: z.enum(['repository', 'worktree', 'bare']),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  originUrl: z.string().optional(),
  // Always present on the wire; defaults to [] so producers may omit it safely.
  worktrees: z.array(GitWorktreeWire).default([]),
})
export type GitRepositoryWire = z.infer<typeof GitRepositoryWire>

export const GitDiscoveryDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  path: z.string(),
  message: z.string(),
})
export type GitDiscoveryDiagnosticWire = z.infer<typeof GitDiscoveryDiagnosticWire>

// ---- Transcript (structured conversation feed) ----
// Normalized, render-oriented view of the harness transcript JSONL. The daemon
// tails the file (located via hook payloads), parses each record into items,
// and streams them up; the server keeps a bounded per-session buffer for
// late-joining clients. Tool calls and their results are separate items linked
// by toolUseId — the renderer pairs them.
export const TranscriptRole = z.enum(['user', 'assistant', 'tool', 'system'])
export type TranscriptRole = z.infer<typeof TranscriptRole>

export const TranscriptTag = z.object({
  kind: z.enum(['image', 'file']),
  label: z.string().optional(),
})
export type TranscriptTag = z.infer<typeof TranscriptTag>

export const TranscriptItem = z.object({
  id: z.string(),
  /** Opaque, daemon-defined position anchor for read-from/subscribe-since paging.
   *  Stable across re-reads of the same file bytes (unlike `id`, which is
   *  synthesized for some items). The client treats it as opaque. */
  cursor: z.string().optional(),
  role: TranscriptRole,
  ts: z.string().optional(), // ISO 8601
  /** Markdown body. Empty for pure tool-call items. */
  text: z.string(),
  toolName: z.string().optional(),
  /** Compact one-line preview of the tool input. */
  toolInput: z.string().optional(),
  /** Human-readable one-line summary the agent attached to the call (the Bash
   *  `description`), when present. Used for the collapsed tool-batch summary so a
   *  lone command reads as its intent rather than its shell; the chat falls back
   *  to `toolInput` when absent. */
  toolTitle: z.string().optional(),
  /** Full tool input as a JSON string, set only for user-facing prompt tools
   *  (AskUserQuestion) so the chat can render an interactive question card rather
   *  than a collapsed tool row. Omitted for ordinary tools to avoid bloat. */
  toolInputJson: z.string().optional(),
  /** Truncated tool result text (set on role 'tool' result items). */
  toolResult: z.string().optional(),
  /** Pairs a tool call with its result item. */
  toolUseId: z.string().optional(),
  tags: z.array(TranscriptTag).optional(),
  /** Absolute file paths this item structurally references (tool file_path
   *  inputs and @-mention / edit / compact attachment filenames). Drives
   *  clickable file chips and the native-terminal link allow-set. */
  toolPaths: z.array(z.string()).optional(),
  /** A recognized non-conversational user *action* surfaced inline rather than as
   *  a chat bubble — the role stays its true value ('user'); this only changes how
   *  it's shown. 'interrupt' = the user stopped the agent mid-run
   *  ("[Request interrupted by user]"). Shared signal: a transcript-reading agent
   *  state detector can treat an interrupt as a user action without mistaking it
   *  for a typed prompt. */
  event: z.enum(['interrupt']).optional(),
  /** Set on the assistant text that ENDED the turn (transcript stop_reason
   *  'end_turn'/'stop_sequence') — i.e. the final, user-facing answer, as opposed
   *  to the intermediate narration the agent emits between tool calls. The UI
   *  elevates it (distinct bubble + minimap accent). Note: a *buried* answer in an
   *  intermediate block carries no transcript marker, so it can't be flagged here. */
  answer: z.boolean().optional(),
  /** Distinguishes special system items so the chat can render them apart from a
   *  generic "System" line: 'recap' = Claude Code's away/while-you-were-gone
   *  summary (subtype away_summary); 'duration' = a turn's churn time (subtype
   *  turn_duration), carried in `durationMs`. Absent on plain system messages. */
  systemKind: z.enum(['recap', 'duration']).optional(),
  /** Wall-clock duration of the turn in ms (set with systemKind 'duration'),
   *  surfaced as "Churned for Xm Ys". */
  durationMs: z.number().optional(),
})
export type TranscriptItem = z.infer<typeof TranscriptItem>

// daemon -> server AND server -> client (identical shape). Streams newly-tailed
// transcript items as they arrive. `tail` is the cursor of the last item in this
// batch (the resume point for a late subscribe). `reset` replaces the client's
// buffer (the tailer switched files, e.g. resume rolled into a fresh transcript).
export const TranscriptDeltaMessage = z.object({
  type: z.literal('transcriptDelta'),
  sessionId: z.string(),
  items: z.array(TranscriptItem),
  tail: z.string().optional(),
  reset: z.boolean().optional(),
})
export type TranscriptDeltaMessage = z.infer<typeof TranscriptDeltaMessage>

// client -> server. `since` is the cursor of the last item the client already
// holds; the server streams only items after it (omitted = stream from the live
// tail / send what the server buffers).
export const TranscriptSubscribeMessage = z.object({
  type: z.literal('transcriptSubscribe'),
  sessionId: z.string(),
  since: z.string().optional(),
})
export type TranscriptSubscribeMessage = z.infer<typeof TranscriptSubscribeMessage>

export const TranscriptUnsubscribeMessage = z.object({
  type: z.literal('transcriptUnsubscribe'),
  sessionId: z.string(),
})
export type TranscriptUnsubscribeMessage = z.infer<typeof TranscriptUnsubscribeMessage>

// ---- Browser client -> server ----
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
})
export const AttachMessage = z.object({
  type: z.literal('attach'),
  sessionId: z.string(),
  // Resume cursor: the last outputFrame seq this client already rendered. Sent on a
  // reconnect, where the terminal view survived the socket drop — the server then
  // replays only the frames after this point and marks the attach `resumed` so the
  // client appends instead of wiping. Omitted on a fresh mount (no screen to keep)
  // or when the client has rendered nothing yet → full replay + clear.
  sinceSeq: z.number().int().nonnegative().optional(),
})
export const DetachMessage = z.object({ type: z.literal('detach'), sessionId: z.string() })
export const InputMessage = z.object({
  type: z.literal('input'),
  sessionId: z.string(),
  data: z.string(),
})
// Client's requested terminal grid; controller-authoritative. Geometry shape + sessionId.
export const ResizeMessage = z.object({
  type: z.literal('resize'),
  sessionId: z.string(),
  ...Geometry.shape,
})
export const RequestControlMessage = z.object({
  type: z.literal('requestControl'),
  sessionId: z.string(),
})
export const RedrawRequestMessage = z.object({
  type: z.literal('redrawRequest'),
  sessionId: z.string(),
})
// Liveness probe. The browser pings periodically so a half-open connection (laptop
// sleep, dead proxy hop) is detected client-side, and idle-timeout proxies see
// traffic. The server answers with pong.
export const PingMessage = z.object({ type: z.literal('ping') })
// User presence (page visibility) — the smart-notification router skips mobile
// push while some Podium window is visibly open.
export const PresenceMessage = z.object({ type: z.literal('presence'), visible: z.boolean() })

// The in-progress composer / native-prompt text for a session. The controlling
// client publishes its scraped native prompt, and a chat composer edit publishes
// its draft, so every view/device converges. Server-persisted (debounced) so the
// draft survives a full reload / server restart and replays on (re)connect
// (issue #34) — real user work is never lost.
export const SetSessionDraftMessage = z.object({
  type: z.literal('setSessionDraft'),
  sessionId: z.string(),
  text: z.string(),
})
export type SetSessionDraftMessage = z.infer<typeof SetSessionDraftMessage>

export const SessionDraftChangedMessage = z.object({
  type: z.literal('sessionDraftChanged'),
  sessionId: z.string(),
  text: z.string(),
})
export type SessionDraftChangedMessage = z.infer<typeof SessionDraftChangedMessage>

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
  PingMessage,
  PresenceMessage,
  TranscriptSubscribeMessage,
  TranscriptUnsubscribeMessage,
  SetSessionDraftMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>

// ---- Server -> browser client ----
export const WelcomeMessage = z.object({ type: z.literal('welcome'), clientId: z.string() })
export const AttachedMessage = z.object({
  type: z.literal('attached'),
  sessionId: z.string(),
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
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  data: z.string(),
})
export const ControllerChangedMessage = z.object({
  type: z.literal('controllerChanged'),
  sessionId: z.string(),
  controllerId: z.string().nullable(),
  geometry: Geometry,
})
// Server's authoritative PTY size, per session — lets spectators letterbox.
export const GeometryMessage = z.object({
  type: z.literal('geometry'),
  sessionId: z.string(),
  ...Geometry.shape,
})
// Shared in both directions: daemon -> server AND server -> client (identical shape).
export const AgentExitMessage = z.object({
  type: z.literal('agentExit'),
  sessionId: z.string(),
  code: z.number().int(),
})
export const SessionsChangedMessage = z.object({
  type: z.literal('sessionsChanged'),
  sessions: z.array(SessionMeta),
})
export const ConversationsChangedMessage = z.object({
  type: z.literal('conversationsChanged'),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
})
// A single session's live title changed (an agent set its terminal title via OSC).
// Sent on its own rather than rebroadcasting the whole session list, because agents
// emit these at spinner frame-rate (~10 Hz) and the payload is tiny.
export const SessionTitleChangedMessage = z.object({
  type: z.literal('sessionTitleChanged'),
  sessionId: z.string(),
  title: z.string(),
})

// One session's runtime phase changed. A dedicated message — not a full
// sessionsChanged rebroadcast — because hook events fire often (a TodoWrite
// mutation, every turn boundary, across all sessions) and re-serializing the
// whole list per event is O(sessions × clients) several times a second.
export const SessionAgentStateChangedMessage = z.object({
  type: z.literal('sessionAgentStateChanged'),
  sessionId: z.string(),
  state: AgentRuntimeState,
})

// Memory state of a daemon host. "Available" is the kernel's estimate of memory
// applications can still allocate without swapping (Linux MemAvailable) — used is
// total − available, NOT total − free, so page cache doesn't read as pressure.
// Swap travels alongside but is never folded into the headline number.
const byteCount = z.number().int().nonnegative()
export const HostMemoryWire = z.object({
  totalBytes: byteCount,
  availableBytes: byteCount,
  swapTotalBytes: byteCount,
  swapFreeBytes: byteCount,
})
export type HostMemoryWire = z.infer<typeof HostMemoryWire>

export const HostMetricsWire = z.object({
  hostname: z.string(),
  sampledAt: z.string(), // ISO 8601
  memory: HostMemoryWire,
})
export type HostMetricsWire = z.infer<typeof HostMetricsWire>

// Latest sample per daemon host. An array (not a single host) so the wire shape
// already accommodates multiple machines each running a daemon.
export const HostMetricsChangedMessage = z.object({
  type: z.literal('hostMetricsChanged'),
  hosts: z.array(HostMetricsWire),
})
// Reply to a client PingMessage; its arrival is the liveness signal.
export const PongMessage = z.object({ type: z.literal('pong') })
// A session crossed into a state that wants the human (question, permission,
// error, plan approval). Clients surface it as a web notification when hidden.
export const AttentionEventMessage = z.object({
  type: z.literal('attentionEvent'),
  sessionId: z.string(),
  title: z.string(),
  body: z.string(),
})

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  AttachedMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
  SessionsChangedMessage,
  ConversationsChangedMessage,
  SessionTitleChangedMessage,
  SessionAgentStateChangedMessage,
  SessionDraftChangedMessage,
  HostMetricsChangedMessage,
  PongMessage,
  AttentionEventMessage,
  TranscriptDeltaMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>

// ---- Daemon <-> server ----
// server -> daemon
export const SpawnMessage = z.object({
  type: z.literal('spawn'),
  sessionId: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  geometry: Geometry,
  // Settings-driven model defaults. Absent = the harness decides (no flag/env).
  model: z.string().optional(),
  subagentModel: z.string().optional(),
})
export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  sessionId: z.string(),
  durableLabel: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  geometry: Geometry,
  // Lets the daemon classify the live transcript when seeding a survivor's state
  // on reattach, so a session parked on a question keeps its 'needs answer' signal.
  resume: ResumeRef.optional(),
})
export const KillMessage = z.object({ type: z.literal('kill'), sessionId: z.string() })
export const ScanRequestMessage = z.object({
  type: z.literal('scanRequest'),
  requestId: z.string(),
})
export const ScanReposRequestMessage = z.object({
  type: z.literal('scanReposRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
  // When false, $HOME is not auto-added as a scan root (so a scan stays rooted at
  // exactly `roots`). When omitted, the daemon keeps its legacy home-inclusive default.
  includeHome: z.boolean().optional(),
  // Bound on how deep the walk descends from each root. 0 only inspects the roots
  // themselves (used to enrich already-registered repos without a filesystem walk).
  maxDepth: z.number().int().nonnegative().optional(),
})
export const RedrawMessage = z.object({ type: z.literal('redraw'), sessionId: z.string() })
// Unified, cursor-based transcript read (server -> daemon). One request shape for
// both the initial tail and scroll-back paging: the daemon resolves the items
// relative to an opaque `anchor` cursor. `anchor` omitted = read from the tail
// (newest) when direction is 'before', or from the head when 'after'. `direction`
// 'before' walks toward older items (scroll-to-top paging), 'after' toward newer.
// `limit` bounds the page. The server supplies the session metadata the daemon
// needs to RESOLVE the right TranscriptSource (the daemon is keyed by sessionId
// for live PTYs, but a transcript read off disk needs the harness + cwd, and the
// optional resume ref names the on-disk file / DB session): `agentKind` selects
// the source, `cwd` locates the per-cwd file bucket, `resume` (when known) names
// the specific transcript file / opencode session.
export const TranscriptReadRequestMessage = z.object({
  type: z.literal('transcriptRead'),
  requestId: z.string(),
  sessionId: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  anchor: z.string().optional(),
  direction: z.enum(['before', 'after']),
  // Wire-level guard: the daemon reads `limit` items off disk, so bound it at the
  // boundary (positive integer, capped) — a negative/NaN/huge limit must not reach
  // the slice reader. Mirrors the bound the retired transcriptPageRequest carried.
  limit: z.number().int().positive().max(2000),
})
export type TranscriptReadRequestMessage = z.infer<typeof TranscriptReadRequestMessage>

export const FileReadRequestMessage = z.object({
  type: z.literal('fileReadRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted: this path is in the session transcript-known set, so the
   *  daemon may read it even if it resolves outside the cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileReadRequestMessage = z.infer<typeof FileReadRequestMessage>

export const FileAssetRequestMessage = z.object({
  type: z.literal('fileAssetRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted transcript-known path; allows reading outside cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileAssetRequestMessage = z.infer<typeof FileAssetRequestMessage>

export const FileWriteRequestMessage = z.object({
  type: z.literal('fileWriteRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  content: z.string(),
  baseHash: z.string().optional(),
})
export type FileWriteRequestMessage = z.infer<typeof FileWriteRequestMessage>

// On-demand (chip click), not periodic — a full /proc walk is too heavy for the
// 5s hostMetrics heartbeat. `roots` are the repo/worktree paths the client controls;
// the daemon attributes non-agent processes to them by working directory.
export const MemoryBreakdownRequestMessage = z.object({
  type: z.literal('memoryBreakdownRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
})

// Image upload: the web client sends the base64-encoded image; the daemon
// writes it to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
// absolute path so it can be pasted into an agent prompt.
export const ImageUploadRequestMessage = z.object({
  type: z.literal('imageUploadRequest'),
  requestId: z.string(),
  sessionId: z.string(),
  /** Original filename — informational only; the daemon derives the path from mime + id. */
  filename: z.string(),
  mimeType: z.string(),
  /** Base64-encoded file contents. Capped at 10 MiB base64 (~7.5 MiB decoded). */
  dataBase64: z.string().max(10 * 1024 * 1024),
})
export const ImageUploadResultMessage = z.object({
  type: z.literal('imageUploadResult'),
  requestId: z.string(),
  /** Absolute path on the daemon host where the file was written. Empty on failure. */
  path: z.string(),
  /** Set when the daemon failed to write the file; absent on success. */
  error: z.string().optional(),
})

// Constrained git operations the superagent may run on a dev machine. An
// allowlisted enum (not a shell string) — the daemon maps each op to a fixed
// git invocation.
export const RepoOp = z.enum(['status', 'log', 'branches', 'worktreeAdd'])
export type RepoOp = z.infer<typeof RepoOp>
export const RepoOpRequestMessage = z.object({
  type: z.literal('repoOpRequest'),
  requestId: z.string(),
  op: RepoOp,
  cwd: z.string(),
  // op-specific extras (worktreeAdd: { path, branch }).
  args: z.record(z.string()).optional(),
})
// One-shot non-interactive harness run (`claude -p` / `codex exec` / `grok -p`) — the
// harness-backed superagent/work-LLM path. Chat only: no Podium tools inside.
export const HarnessExecRequestMessage = z.object({
  type: z.literal('harnessExecRequest'),
  requestId: z.string(),
  agent: z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor']),
  model: z.string().optional(),
  prompt: z.string(),
  cwd: z.string().optional(),
  /** Extra system prompt injected into the harness turn (the superagent's
   *  orchestrator prompt) — natively where the CLI supports it, else prepended. */
  systemPrompt: z.string().optional(),
  /** MCP config JSON (Claude `--mcp-config`) giving the harness agent Podium's
   *  own orchestrator tools. The daemon writes it to a temp file per run. */
  mcpConfig: z.string().optional(),
  /** Tools pre-approved so they run headlessly without a permission prompt. */
  allowedTools: z.array(z.string()).optional(),
})

// Token-usage harvest from harness transcripts (ccusage-style, in-house so it
// feeds the same wire). Hourly buckets keep the payload small while supporting
// 5h/weekly windows and per-day analytics.
export const UsageBucketWire = z.object({
  /** Bucket start, ISO 8601, truncated to the hour. */
  hour: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
})
export type UsageBucketWire = z.infer<typeof UsageBucketWire>
export const UsageRequestMessage = z.object({
  type: z.literal('usageRequest'),
  requestId: z.string(),
  /** Only count activity at/after this epoch ms (default: 7 days back). */
  sinceMs: z.number().optional(),
})
export const UsageResultMessage = z.object({
  type: z.literal('usageResult'),
  requestId: z.string(),
  hostname: z.string(),
  buckets: z.array(UsageBucketWire),
})

// ── Agent plan-quota (rate-limit windows). Distinct from UsageBucketWire, which
// is transcript-harvested token-cost analytics. Quota is the share of each rolling
// plan window consumed + when it resets, read live from each agent's own usage
// endpoint on the daemon host. Claude: 5h + weekly. Codex: 5h + weekly.
export const QuotaWindowWire = z.object({
  key: z.enum(['5h', 'weekly']),
  label: z.string(),
  usedPercent: z.number(), // 0..100
  resetsAt: z.string(), // ISO 8601 ('' when unknown)
  windowMinutes: z.number().int().positive(),
})
export type QuotaWindowWire = z.infer<typeof QuotaWindowWire>

export const AgentQuotaWire = z.object({
  agent: AgentKind,
  status: z.enum(['ok', 'unauthenticated', 'expired', 'error']),
  account: z.object({ email: z.string().optional(), plan: z.string().optional() }).optional(),
  windows: z.array(QuotaWindowWire),
  error: z.string().optional(),
  fetchedAt: z.string(), // ISO 8601
})
export type AgentQuotaWire = z.infer<typeof AgentQuotaWire>

export const AgentQuotaRequestMessage = z.object({
  type: z.literal('agentQuotaRequest'),
  requestId: z.string(),
  refresh: z.boolean().optional(),
})
export const AgentQuotaResultMessage = z.object({
  type: z.literal('agentQuotaResult'),
  requestId: z.string(),
  hostname: z.string(),
  agents: z.array(AgentQuotaWire),
})

export const ControlMessage = z.discriminatedUnion('type', [
  RepoOpRequestMessage,
  HarnessExecRequestMessage,
  UsageRequestMessage,
  AgentQuotaRequestMessage,
  ImageUploadRequestMessage,
  SpawnMessage,
  ReattachMessage,
  KillMessage,
  ScanRequestMessage,
  ScanReposRequestMessage,
  InputMessage,
  ResizeMessage,
  RedrawMessage,
  MemoryBreakdownRequestMessage,
  TranscriptReadRequestMessage,
  FileReadRequestMessage,
  FileAssetRequestMessage,
  FileWriteRequestMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>

// daemon -> server
export const BindMessage = z.object({
  type: z.literal('bind'),
  sessionId: z.string(),
  cmd: z.string(),
  cwd: z.string(),
  agentKind: AgentKind,
  geometry: Geometry,
})
export const AgentFrameMessage = z.object({
  type: z.literal('agentFrame'),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string(),
})
export const SpawnErrorMessage = z.object({
  type: z.literal('spawnError'),
  sessionId: z.string(),
  message: z.string(),
})
export const ReattachFailedMessage = z.object({
  type: z.literal('reattachFailed'),
  sessionId: z.string(),
  reason: z.string(),
})
// Live terminal title sniffed from the agent's PTY (OSC 0/1/2). The daemon
// detects it in the byte stream and forwards it so the server can label the panel.
export const TitleMessage = z.object({
  type: z.literal('title'),
  sessionId: z.string(),
  title: z.string(),
})
// Harness-observed agent state changed (hooks-driven). Low-frequency: phase
// transitions only, never per-frame.
export const AgentStateMessage = z.object({
  type: z.literal('agentState'),
  sessionId: z.string(),
  state: AgentRuntimeState,
})
// Daemon → server: the agent's `/color` accent, parsed from the transcript tail.
export const AgentColorMessage = z.object({
  type: z.literal('agentColor'),
  sessionId: z.string(),
  color: z.string(),
})
export const ScanResultMessage = z.object({
  type: z.literal('scanResult'),
  requestId: z.string(),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
})
// Periodic host health sample (currently every ~5 s). hostname keys the server's
// latest-per-host map so several machines' daemons can report side by side.
export const HostMetricsMessage = z.object({
  type: z.literal('hostMetrics'),
  ...HostMetricsWire.shape,
})
// Who owns the used memory. Agents are attributed by process tree (the session's
// PTY/durable-host subtree); projects by working directory under a controlled root.
// Sizes are PSS where readable (shared pages divided fairly), RSS otherwise.
export const AgentMemoryWire = z.object({
  sessionId: z.string(),
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
})
export type AgentMemoryWire = z.infer<typeof AgentMemoryWire>
export const ProjectMemoryWire = z.object({
  root: z.string(),
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  topProcesses: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative() })),
})
export type ProjectMemoryWire = z.infer<typeof ProjectMemoryWire>
export const MemoryBreakdownResultMessage = z.object({
  type: z.literal('memoryBreakdownResult'),
  requestId: z.string(),
  hostname: z.string(),
  sampledAt: z.string(), // ISO 8601
  // False where the breakdown can't be computed (no /proc — macOS/Windows);
  // memory + otherBytes still carry the headline numbers.
  supported: z.boolean(),
  memory: HostMemoryWire,
  agents: z.array(AgentMemoryWire),
  projects: z.array(ProjectMemoryWire),
  // used − agents − projects: everything on the box we don't control.
  otherBytes: z.number().int().nonnegative(),
})
export const ScanReposResultMessage = z.object({
  type: z.literal('scanReposResult'),
  requestId: z.string(),
  repositories: z.array(GitRepositoryWire),
  diagnostics: z.array(GitDiscoveryDiagnosticWire),
})

// The daemon learned how to resume this session later (e.g. the Claude session
// uuid from its transcript path). Unlocks hibernate→resume for spawned sessions.
export const SessionResumeRefMessage = z.object({
  type: z.literal('sessionResumeRef'),
  sessionId: z.string(),
  resume: ResumeRef,
})

// Reply to a TranscriptReadRequest (daemon -> server): the requested page of
// items plus the cursors that bound it. `head`/`tail` are the cursors of the
// first/last item in `items` (omitted when the page is empty), and `hasMore`
// says whether further items remain in the requested `direction` (so the client
// can stop paging at the file's head/tail).
export const TranscriptReadResultMessage = z.object({
  type: z.literal('transcriptReadResult'),
  requestId: z.string(),
  sessionId: z.string(),
  items: z.array(TranscriptItem),
  head: z.string().optional(),
  tail: z.string().optional(),
  hasMore: z.boolean(),
})
export type TranscriptReadResultMessage = z.infer<typeof TranscriptReadResultMessage>

export const FileReadResultMessage = z.object({
  type: z.literal('fileReadResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  content: z.string().optional(),
  /** `${mtimeMs}:${size}` snapshot, echoed back on write to detect conflicts. */
  baseHash: z.string().optional(),
  tooLarge: z.boolean().optional(),
  binary: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileReadResultMessage = z.infer<typeof FileReadResultMessage>

export const FileAssetResultMessage = z.object({
  type: z.literal('fileAssetResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  /** Base64-encoded file bytes (images etc.). */
  dataBase64: z.string().optional(),
  contentType: z.string().optional(),
  tooLarge: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileAssetResultMessage = z.infer<typeof FileAssetResultMessage>

export const FileWriteResultMessage = z.object({
  type: z.literal('fileWriteResult'),
  requestId: z.string(),
  ok: z.boolean(),
  baseHash: z.string().optional(),
  conflict: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileWriteResultMessage = z.infer<typeof FileWriteResultMessage>

export const RepoOpResultMessage = z.object({
  type: z.literal('repoOpResult'),
  requestId: z.string(),
  ok: z.boolean(),
  output: z.string(),
})
export const HarnessExecResultMessage = z.object({
  type: z.literal('harnessExecResult'),
  requestId: z.string(),
  ok: z.boolean(),
  output: z.string(),
})

export const DaemonMessage = z.discriminatedUnion('type', [
  RepoOpResultMessage,
  HarnessExecResultMessage,
  UsageResultMessage,
  AgentQuotaResultMessage,
  ImageUploadResultMessage,
  SessionResumeRefMessage,
  BindMessage,
  AgentFrameMessage,
  AgentExitMessage,
  SpawnErrorMessage,
  ReattachFailedMessage,
  TitleMessage,
  AgentStateMessage,
  AgentColorMessage,
  ScanResultMessage,
  ConversationsChangedMessage,
  ScanReposResultMessage,
  HostMetricsMessage,
  MemoryBreakdownResultMessage,
  TranscriptDeltaMessage,
  TranscriptReadResultMessage,
  FileReadResultMessage,
  FileAssetResultMessage,
  FileWriteResultMessage,
])
export type DaemonMessage = z.infer<typeof DaemonMessage>

// Codecs. parse* functions throw on malformed JSON (SyntaxError) or on a schema
// mismatch (ZodError); callers handle both.
// ---- codec ----
type AnyMessage = ClientMessage | ServerMessage | DaemonMessage | ControlMessage

export function encode(msg: AnyMessage): string {
  return JSON.stringify(msg)
}

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw))
}
export function parseServerMessage(raw: string): ServerMessage {
  return ServerMessage.parse(JSON.parse(raw))
}
export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}
export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
