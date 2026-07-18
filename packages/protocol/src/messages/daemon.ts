import { z } from 'zod'
import { ApprovalExecResultMessage } from './approvals'
import { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from './browser-open'
import {
  BrowseDirsResultMessage,
  ConversationsChangedMessage,
  RepoOpResultMessage,
  ScanReposResultMessage,
  ScanResultMessage,
} from './discovery'
import {
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
  ImageUploadResultMessage,
} from './files'
import {
  HandoffChunkReadResultMessage,
  HandoffExportResultMessage,
  HandoffImportChunkResultMessage,
  HandoffImportResultMessage,
} from './handoff'
import {
  WorkspaceCleanResultMessage,
  WorkspaceExportResultMessage,
  WorkspaceImportResultMessage,
} from './workspace'
import { HarnessExecResultMessage } from './harness'
import {
  HeadlessBindResultMessage,
  HeadlessTurnEventMessage,
  HeadlessTurnResultMessage,
} from './headless'
import {
  AgentQuotaResultMessage,
  HostMetricsMessage,
  MemoryBreakdownResultMessage,
  UsageResultMessage,
} from './host'
import { InventoryReportMessage } from './inventory'
import { AgentRelayRequestMessage } from './issues'
import { AgentStateMessage } from './runtime-state'
import {
  AgentColorMessage,
  AgentExitMessage,
  AgentFrameBatchMessage,
  AgentFrameMessage,
  BindMessage,
  ReattachFailedMessage,
  ResumeRef,
  SpawnErrorMessage,
  TitleMessage,
} from './terminal'
import {
  TranscriptDeltaMessage,
  TranscriptMirrorResultMessage,
  TranscriptReadResultMessage,
} from './transcript'

// The daemon learned how to resume this session later (e.g. the Claude session
// uuid from its transcript path). Unlocks hibernate→resume for spawned sessions.
export const SessionResumeRefMessage = z.object({
  type: z.literal('sessionResumeRef'),
  sessionId: z.string(),
  resume: ResumeRef,
  // Exact = native hook, known resume, or a legacy embedded Podium launch marker.
  // Heuristic/absent = cwd/time inference from an older daemon. Optional keeps
  // rolling upgrades wire-compatible.
  confidence: z.enum(['exact', 'heuristic']).optional(),
  // Retained native-hook evidence is removed only after this is persisted.
  ackRequested: z.boolean().optional(),
})

// daemon -> server: the agent's live working directory changed (read from the
// `cwd` every Claude hook payload carries — it follows EnterWorktree and plain
// `cd`). The server restamps the session's cwd so the sidebar re-groups it under
// the worktree it actually moved into, instead of pinning it to the launch dir.
export const SessionCwdMessage = z.object({
  type: z.literal('sessionCwd'),
  sessionId: z.string(),
  cwd: z.string(),
  // True when the agent DECLARED this worktree (`podium worktree`), as opposed to
  // hook-observed cd wandering. Its weight is on the DAEMON side: a declaration
  // always sends, bypassing the dedup that would swallow a re-declaration of the
  // root the session already sits in. The server does not gate adoption on it —
  // `kind` and the issue guards decide that (POD-665).
  explicit: z.boolean().optional(),
  // What `cwd` IS, classified by git on the daemon (the only side that can run it):
  // the repo's main checkout, a linked worktree, or outside git entirely. Only a
  // linked worktree may be adopted as an issue's workspace [spec:SP-4ef9] — main
  // never is. Optional because an older daemon cannot send it; such a daemon simply
  // does not adopt (no path test can stand in for git here — worktrees live inside
  // the repo dir), and self-heals when its binary updates.
  kind: z.enum(['main', 'worktree', 'none']).optional(),
  // The branch checked out in `cwd`, resolved fresh at send time; absent when
  // detached or when `cwd` is no worktree. Lets the server stamp branch AND
  // worktree together when it adopts (POD-664: the harness makes its own worktree,
  // leaving the issue with neither).
  branch: z.string().optional(),
  // The primary checkout of the repo `cwd` belongs to — an issue's `repoPath`. The
  // server matches it before adopting, so a session that steps into some OTHER
  // repo's worktree can't hand that worktree to this issue.
  repoRoot: z.string().optional(),
})
export type SessionCwdMessage = z.infer<typeof SessionCwdMessage>

// daemon -> server: the native composer draft the daemon scraped from a flagged
// session's PTY (Draft Sync v2, POD-859). The server sequences it as an
// origin='native' versioned edit and broadcasts, so drafts reach every view/device
// with zero browsers attached.
export const NativeDraftMessage = z.object({
  type: z.literal('nativeDraft'),
  sessionId: z.string(),
  text: z.string(),
})
export type NativeDraftMessage = z.infer<typeof NativeDraftMessage>

// ---- Daemon -> server ----
export const DaemonMessage = z.discriminatedUnion('type', [
  RepoOpResultMessage,
  AgentRelayRequestMessage,
  ApprovalExecResultMessage,
  HarnessExecResultMessage,
  HandoffExportResultMessage,
  HandoffChunkReadResultMessage,
  HandoffImportChunkResultMessage,
  HandoffImportResultMessage,
  WorkspaceExportResultMessage,
  WorkspaceImportResultMessage,
  WorkspaceCleanResultMessage,
  HeadlessTurnEventMessage,
  HeadlessTurnResultMessage,
  HeadlessBindResultMessage,
  UsageResultMessage,
  AgentQuotaResultMessage,
  ImageUploadResultMessage,
  SessionResumeRefMessage,
  SessionCwdMessage,
  NativeDraftMessage,
  InventoryReportMessage,
  BindMessage,
  AgentFrameMessage,
  AgentFrameBatchMessage,
  AgentExitMessage,
  SpawnErrorMessage,
  ReattachFailedMessage,
  TitleMessage,
  AgentStateMessage,
  AgentColorMessage,
  ScanResultMessage,
  ConversationsChangedMessage,
  ScanReposResultMessage,
  BrowseDirsResultMessage,
  TranscriptMirrorResultMessage,
  HostMetricsMessage,
  MemoryBreakdownResultMessage,
  TranscriptDeltaMessage,
  TranscriptReadResultMessage,
  FileReadResultMessage,
  FileAssetResultMessage,
  FileWriteResultMessage,
  DirListResultMessage,
  SessionOpenUrlMessage,
  SessionOpenUrlResultMessage,
])
export type DaemonMessage = z.infer<typeof DaemonMessage>
