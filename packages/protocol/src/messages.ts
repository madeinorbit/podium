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

export const AgentKind = z.enum(['claude-code', 'codex'])
export type AgentKind = z.infer<typeof AgentKind>

export const ResumeRef = z.object({ kind: z.string(), value: z.string() })
export type ResumeRef = z.infer<typeof ResumeRef>

export const SessionStatus = z.enum(['starting', 'live', 'exited'])
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

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
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

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  AttachedMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
  SessionsChangedMessage,
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
export const KillMessage = z.object({ type: z.literal('kill'), sessionId: z.string() })
export const ScanRequestMessage = z.object({
  type: z.literal('scanRequest'),
  requestId: z.string(),
})
export const ScanReposRequestMessage = z.object({
  type: z.literal('scanReposRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
})
export const RedrawMessage = z.object({ type: z.literal('redraw'), sessionId: z.string() })

export const ControlMessage = z.discriminatedUnion('type', [
  SpawnMessage,
  KillMessage,
  ScanRequestMessage,
  ScanReposRequestMessage,
  InputMessage,
  ResizeMessage,
  RedrawMessage,
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
export const ScanResultMessage = z.object({
  type: z.literal('scanResult'),
  requestId: z.string(),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
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
  ScanResultMessage,
  ScanReposResultMessage,
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
