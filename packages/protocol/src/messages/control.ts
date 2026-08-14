import { z } from 'zod'
import { ApprovalExecRequestMessage } from './approvals'
import { SessionOpenUrlCallbackMessage, SessionOpenUrlDismissMessage } from './browser-open'
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
  AgentQuotaRequestMessage,
  MemoryBreakdownRequestMessage,
  UsageRequestMessage,
} from './host'
import { InventoryRequestMessage, ModelProbeRequestMessage } from './inventory'
import { AgentRelayResultMessage } from './issues'
import {
  RuntimeAnswerRequestMessage,
  RuntimeInterruptRequestMessage,
  RuntimeLifecycleRequestMessage,
  RuntimeSendRequestMessage,
} from './runtime'
import { AgentObservationAckMessage, AgentObservationRebindAckMessage } from './runtime-state'
import {
  ServerTransferAbortRequestMessage,
  ServerTransferAcknowledgeRequestMessage,
  ServerTransferChunkRequestMessage,
  ServerTransferPrepareRequestMessage,
  ServerTransferPromoteRequestMessage,
  ServerTransferStatusRequestMessage,
  ServerTransferValidateRequestMessage,
} from './server-transfer'
import {
  ShippingEvidenceRequestMessage,
  ShippingJobRequestMessage,
  ShippingRepairApplyRequestMessage,
} from './shipping'
import {
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
} from './terminal'
import { TranscriptMirrorReadMessage, TranscriptReadRequestMessage } from './transcript'
import { UpdateGrantMessage } from './update'
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
  InventoryRequestMessage,
  ModelProbeRequestMessage,
  UpdateGrantMessage,
  ImageUploadRequestMessage,
  SpawnMessage,
  ReattachMessage,
  KillMessage,
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
  ServerTransferStatusRequestMessage,
  ShippingJobRequestMessage,
  ShippingEvidenceRequestMessage,
  ShippingRepairApplyRequestMessage,
  // The Agent Runtime contract's write path (POD-1761 W3). One correlated verb
  // per frame, reaching the flagged session's driver and nothing else — the
  // legacy `input`/`kill` frames above stay exactly as they are for every
  // unflagged session.
  RuntimeSendRequestMessage,
  RuntimeInterruptRequestMessage,
  RuntimeAnswerRequestMessage,
  RuntimeLifecycleRequestMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>
