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

export const AgentKind = z.enum(['claude-code', 'codex', 'shell'])
export type AgentKind = z.infer<typeof AgentKind>

export const ResumeRef = z.object({ kind: z.string(), value: z.string() })
export type ResumeRef = z.infer<typeof ResumeRef>

export const SessionStatus = z.enum(['starting', 'live', 'reconnecting', 'hibernated', 'exited'])
export type SessionStatus = z.infer<typeof SessionStatus>

export const SessionOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn') }),
  z.object({ kind: z.literal('resume'), conversationId: z.string() }),
])
export type SessionOrigin = z.infer<typeof SessionOrigin>

export const SessionMeta = z.object({
  sessionId: z.string(),
  agentKind: AgentKind,
  title: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().optional(), // present only when status === 'exited'
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO 8601
  origin: SessionOrigin,
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

// ---- Browser client -> server ----
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
})
export const AttachMessage = z.object({ type: z.literal('attach'), sessionId: z.string() })
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

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
  PingMessage,
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
  HostMetricsChangedMessage,
  PongMessage,
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
})
export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  sessionId: z.string(),
  durableLabel: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  geometry: Geometry,
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
// On-demand (chip click), not periodic — a full /proc walk is too heavy for the
// 5s hostMetrics heartbeat. `roots` are the repo/worktree paths the client controls;
// the daemon attributes non-agent processes to them by working directory.
export const MemoryBreakdownRequestMessage = z.object({
  type: z.literal('memoryBreakdownRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
})

export const ControlMessage = z.discriminatedUnion('type', [
  SpawnMessage,
  ReattachMessage,
  KillMessage,
  ScanRequestMessage,
  ScanReposRequestMessage,
  InputMessage,
  ResizeMessage,
  RedrawMessage,
  MemoryBreakdownRequestMessage,
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

export const DaemonMessage = z.discriminatedUnion('type', [
  BindMessage,
  AgentFrameMessage,
  AgentExitMessage,
  SpawnErrorMessage,
  ReattachFailedMessage,
  TitleMessage,
  ScanResultMessage,
  ConversationsChangedMessage,
  ScanReposResultMessage,
  HostMetricsMessage,
  MemoryBreakdownResultMessage,
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
