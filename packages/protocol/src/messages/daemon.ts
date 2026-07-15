import { z } from 'zod'
import {
  ConversationsChangedMessage,
  RepoOpResultMessage,
  ScanReposResultMessage,
  ScanResultMessage,
} from './discovery'
import { FileAssetResultMessage, FileReadResultMessage, FileWriteResultMessage, DirListResultMessage, ImageUploadResultMessage } from './files'
import { ApprovalExecResultMessage } from './approvals'
import { HarnessExecResultMessage } from './harness'
import { HeadlessBindResultMessage, HeadlessTurnEventMessage, HeadlessTurnResultMessage } from './headless'
import { AgentQuotaResultMessage, HostMetricsMessage, MemoryBreakdownResultMessage, UsageResultMessage } from './host'
import { InventoryReportMessage } from './inventory'
import { IssueRelayRequestMessage } from './issues'
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
import { TranscriptDeltaMessage, TranscriptMirrorResultMessage, TranscriptReadResultMessage } from './transcript'

// The daemon learned how to resume this session later (e.g. the Claude session
// uuid from its transcript path). Unlocks hibernate→resume for spawned sessions.
export const SessionResumeRefMessage = z.object({
  type: z.literal('sessionResumeRef'),
  sessionId: z.string(),
  resume: ResumeRef,
  // Exact = native hook, known resume, or an embedded Podium launch marker.
  // Heuristic/absent = cwd/time inference from an older daemon. Optional keeps
  // rolling upgrades wire-compatible.
  confidence: z.enum(['exact', 'heuristic']).optional(),
})

// daemon -> server: the agent's live working directory changed (read from the
// `cwd` every Claude hook payload carries — it follows EnterWorktree and plain
// `cd`). The server restamps the session's cwd so the sidebar re-groups it under
// the worktree it actually moved into, instead of pinning it to the launch dir.
export const SessionCwdMessage = z.object({
  type: z.literal('sessionCwd'),
  sessionId: z.string(),
  cwd: z.string(),
  // True when the agent DECLARED this worktree (`podium worktree`), as opposed
  // to hook-observed cd wandering. An explicit declaration also stamps the
  // worktree onto the session's attached issue (if that issue has none yet).
  explicit: z.boolean().optional(),
})
export type SessionCwdMessage = z.infer<typeof SessionCwdMessage>

// ---- Daemon -> server ----
export const DaemonMessage = z.discriminatedUnion('type', [
  RepoOpResultMessage,
  IssueRelayRequestMessage,
  ApprovalExecResultMessage,
  HarnessExecResultMessage,
  HeadlessTurnEventMessage,
  HeadlessTurnResultMessage,
  HeadlessBindResultMessage,
  UsageResultMessage,
  AgentQuotaResultMessage,
  ImageUploadResultMessage,
  SessionResumeRefMessage,
  SessionCwdMessage,
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
  TranscriptMirrorResultMessage,
  HostMetricsMessage,
  MemoryBreakdownResultMessage,
  TranscriptDeltaMessage,
  TranscriptReadResultMessage,
  FileReadResultMessage,
  FileAssetResultMessage,
  FileWriteResultMessage,
  DirListResultMessage,
])
export type DaemonMessage = z.infer<typeof DaemonMessage>
