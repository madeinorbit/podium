import { z } from 'zod'
import { TopicWatchMessage } from '../planes/topics'
import { ApprovalExecRequestMessage } from './approvals'
import { SessionOpenUrlCallbackMessage, SessionOpenUrlDismissMessage } from './browser-open'
import { CodexCompleteRequestMessage } from './codex'
import { ConversationPrepareRequestMessage } from './conversation'
import { CredentialExportRequestMessage, CredentialInstallRequestMessage } from './credentials'
import {
  BrowseDirsRequestMessage,
  DirOpRequestMessage,
  RepoOpRequestMessage,
  ScanReposRequestMessage,
  ScanRequestMessage,
} from './discovery'
import {
  DirListRequestMessage,
  FileAssetRequestMessage,
  FileReadRequestMessage,
  FileWriteRequestMessage,
  ImageUploadRequestMessage,
} from './files'
import { SetDaemonLogLevelMessage } from './fleet-logs'
import { GitHubCliRequestMessage } from './github'
import {
  HandoffBindingFinalizeRequestMessage,
  HandoffChunkReadRequestMessage,
  HandoffExportRequestMessage,
  HandoffImportChunkMessage,
  HandoffImportRequestMessage,
} from './handoff'
import { HarnessExecRequestMessage } from './harness'
import {
  HeadlessBindMessage,
  HeadlessInterruptMessage,
  HeadlessTurnAckMessage,
  HeadlessTurnRequestMessage,
} from './headless'
import {
  CredentialRemoveRequestMessage,
  HomeEnsureRequestMessage,
  HomeRemoveRequestMessage,
} from './homes'
import {
  AgentQuotaRequestMessage,
  MemoryBreakdownRequestMessage,
  QuotaHistoryRequestMessage,
  ReclaimAttachmentsMessage,
  ReclaimDiskEstimateRequestMessage,
  UsageRequestMessage,
} from './host'
import { InventoryRequestMessage, ModelProbeRequestMessage } from './inventory'
import { AgentRelayResultMessage } from './issues'
import { OauthLoopbackCancelMessage, OauthLoopbackRequestMessage } from './oauth-loopback'
import {
  RuntimeAnswerRequestMessage,
  RuntimeConfigureRequestMessage,
  RuntimeDraftRequestMessage,
  RuntimeDurableSendRequestMessage,
  RuntimeEventAckMessage,
  RuntimeHistoryRequestMessage,
  RuntimeInterruptRequestMessage,
  RuntimeLifecycleRequestMessage,
  RuntimeQueueDrainAbandonedAckMessage,
  RuntimeSendRequestMessage,
  RuntimeSnapshotRequestMessage,
  RuntimeStageAttachmentRequestMessage,
  RuntimeWatchMessage,
} from './runtime'
import { AgentObservationAckMessage, AgentObservationRebindAckMessage } from './runtime-state'
import {
  ServerEndpointCommitRequestMessage,
  ServerEndpointProbeRequestMessage,
  ServerEndpointResumeRequestMessage,
  ServerTransferAbortRequestMessage,
  ServerTransferAcknowledgeRequestMessage,
  ServerTransferChunkRequestMessage,
  ServerTransferInspectRequestMessage,
  ServerTransferPrepareRequestMessage,
  ServerTransferPromoteRequestMessage,
  ServerTransferValidateRequestMessage,
} from './server-transfer'
import { SessionAccessRefreshMessage } from './session-access'
import {
  ShippingEvidenceRequestMessage,
  ShippingJobRequestMessage,
  ShippingRepairApplyRequestMessage,
} from './shipping'
import {
  CloseClientTerminalMessage,
  DraftTargetMessage,
  InputMessage,
  KillMessage,
  ReattachMessage,
  RedrawMessage,
  ResizeMessage,
  SessionBindingRetireMessage,
  SessionPriorityMessage,
  SessionResumeRefAckMessage,
  SessionResumeRefConflictMessage,
  SpawnMessage,
  StealWriterMessage,
} from './terminal'
import {
  TranscriptMirrorReadMessage,
  TranscriptPathsRequestMessage,
  TranscriptReadRequestMessage,
} from './transcript'
import { DevArtifactProbeRequestMessage, UpdateGrantMessage } from './update'
import {
  WorkspaceCleanRequestMessage,
  WorkspaceExportRequestMessage,
  WorkspaceImportRequestMessage,
} from './workspace'

// ---- Server -> daemon control frames ----
export const ControlMessage = z.discriminatedUnion('type', [
  ApprovalExecRequestMessage,
  CredentialExportRequestMessage,
  CredentialInstallRequestMessage,
  OauthLoopbackRequestMessage,
  OauthLoopbackCancelMessage,
  GitHubCliRequestMessage,
  RepoOpRequestMessage,
  AgentRelayResultMessage,
  HarnessExecRequestMessage,
  HandoffExportRequestMessage,
  HandoffChunkReadRequestMessage,
  HandoffImportChunkMessage,
  HandoffImportRequestMessage,
  HandoffBindingFinalizeRequestMessage,
  WorkspaceExportRequestMessage,
  WorkspaceImportRequestMessage,
  WorkspaceCleanRequestMessage,
  HeadlessTurnRequestMessage,
  HeadlessInterruptMessage,
  HeadlessTurnAckMessage,
  HeadlessBindMessage,
  UsageRequestMessage,
  AgentQuotaRequestMessage,
  QuotaHistoryRequestMessage,
  InventoryRequestMessage,
  ModelProbeRequestMessage,
  DevArtifactProbeRequestMessage,
  UpdateGrantMessage,
  ImageUploadRequestMessage,
  SpawnMessage,
  ReattachMessage,
  KillMessage,
  StealWriterMessage,
  SessionBindingRetireMessage,
  AgentObservationAckMessage,
  AgentObservationRebindAckMessage,
  DraftTargetMessage,
  SessionResumeRefAckMessage,
  SessionResumeRefConflictMessage,
  TranscriptMirrorReadMessage,
  SessionPriorityMessage,
  ScanRequestMessage,
  ScanReposRequestMessage,
  BrowseDirsRequestMessage,
  DirOpRequestMessage,
  InputMessage,
  ResizeMessage,
  RedrawMessage,
  MemoryBreakdownRequestMessage,
  ReclaimAttachmentsMessage,
  ReclaimDiskEstimateRequestMessage,
  TranscriptReadRequestMessage,
  FileReadRequestMessage,
  FileAssetRequestMessage,
  FileWriteRequestMessage,
  DirListRequestMessage,
  SessionOpenUrlCallbackMessage,
  SessionOpenUrlDismissMessage,
  ServerTransferPrepareRequestMessage,
  ServerTransferChunkRequestMessage,
  ServerTransferValidateRequestMessage,
  ServerTransferPromoteRequestMessage,
  ServerTransferAbortRequestMessage,
  ServerTransferAcknowledgeRequestMessage,
  ServerTransferInspectRequestMessage,
  ServerEndpointProbeRequestMessage,
  ServerEndpointCommitRequestMessage,
  ServerEndpointResumeRequestMessage,
  ShippingJobRequestMessage,
  ShippingEvidenceRequestMessage,
  ShippingRepairApplyRequestMessage,
  // The Agent Runtime contract's write path (POD-1761 W3). One correlated verb
  // per frame, reaching the flagged session's driver and nothing else — the
  // legacy `input`/`kill` frames above stay exactly as they are for every
  // unflagged session.
  RuntimeStageAttachmentRequestMessage,
  RuntimeSendRequestMessage,
  RuntimeInterruptRequestMessage,
  RuntimeAnswerRequestMessage,
  RuntimeLifecycleRequestMessage,
  RuntimeSnapshotRequestMessage,
  RuntimeHistoryRequestMessage,
  RuntimeQueueDrainAbandonedAckMessage,
  RuntimeEventAckMessage,
  /** The desired watch level for a session's live observation (POD-2293).
   *  Uncorrelated: it carries a state, not an increment — see the frame. */
  RuntimeWatchMessage,
  /** Sticky model/effort for a running session (POD-3081). Appended at the END
   *  of this union for the same reason it is appended at the end of
   *  `RuntimeCommandMessage`: the golden corpus samples arms by index. */
  RuntimeConfigureRequestMessage,
  RuntimeDraftRequestMessage,
  SetDaemonLogLevelMessage,
  RuntimeDurableSendRequestMessage,
  /** Server-ordered attach-TUI warm-park close (POD-4524). Appended at the END
   *  so the golden corpus's arm-by-index sampling keeps every existing arm's
   *  index — see the RuntimeConfigureRequestMessage note above. */
  CloseClientTerminalMessage,
  /** Server-side LLM over a catalog Codex login (POD-4750). Appended at the
   *  END for the same index-stability reason — an older daemon that does not
   *  know this frame is answered by the frame-guard's payload-rejection arm. */
  CodexCompleteRequestMessage,
  /** Topic demand, a desired state (ADR 7 Amendment 2 D21). Appended at the
   *  END for index stability; sent only to a daemon that accepted topics.v1. */
  TopicWatchMessage,
  /** A live session's access, sent again after a reconnect (credential
   *  management §8). Appended at the END for index stability; sent only to a
   *  daemon that accepted `CAP_SESSION_ACCESS`. */
  SessionAccessRefreshMessage,
  /** Harness homes (credential management §10, epic Task 8). Appended at the
   *  END for index stability; sent only to a daemon that accepted
   *  `CAP_HARNESS_HOMES`. */
  HomeEnsureRequestMessage,
  HomeRemoveRequestMessage,
  CredentialRemoveRequestMessage,
  /** Placing a conversation for another credential (credential management
   *  §9, epic Task 11). Appended at the END for index stability; sent only to
   *  a daemon that accepted `CAP_CONVERSATION_PREPARE`. */
  ConversationPrepareRequestMessage,
  /** Batched transcript presence, sent only with CAP_TRANSCRIPT_PATHS. Appended for index stability. */
  TranscriptPathsRequestMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>

/**
 * THE FRAMES THAT CAN CARRY A SECRET (credential management §8, "Never
 * logged"): every control type whose shape has an `access` field. A logger, a
 * trace or a dropped-frame warning names only the type of such a frame, never
 * its fields or a parse error built from them. Pinned against the union's
 * shapes by `session-access.test.ts`, so a new carrier cannot be left out.
 */
export const ACCESS_CARRYING_CONTROL_TYPES: ReadonlySet<ControlMessage['type']> = new Set([
  'spawn',
  'runtimeSendRequest',
  'runtimeDurableSendRequest',
  'sessionAccessRefresh',
] as const satisfies readonly ControlMessage['type'][])

/** Can a control frame of this type carry a session's access? */
export function carriesAccess(type: string): boolean {
  return (ACCESS_CARRYING_CONTROL_TYPES as ReadonlySet<string>).has(type)
}

/**
 * EVERY FRAME THAT CAN CARRY A SECRET, `access` or not (credential management
 * §7 and §8): the access carriers, the server-transfer promote frame, whose
 * `vaultDataKey` is the vault's data key, and the login-file install, whose
 * `bundles` hold a harness's login file. Such a frame is named by its type only
 * in a log, a trace or a dropped-frame warning. Pinned against the union's
 * shapes by `session-access.test.ts`. The daemon's half is
 * `SECRET_CARRYING_DAEMON_TYPES` in `./daemon`.
 */
export const SECRET_CARRYING_CONTROL_TYPES: ReadonlySet<ControlMessage['type']> = new Set([
  ...ACCESS_CARRYING_CONTROL_TYPES,
  'serverTransferPromoteRequest',
  'credentialInstallRequest',
] as const satisfies readonly ControlMessage['type'][])

/** Can a control frame of this type carry a secret? Log it by type only. */
export function carriesSecret(type: string): boolean {
  return (SECRET_CARRYING_CONTROL_TYPES as ReadonlySet<string>).has(type)
}
