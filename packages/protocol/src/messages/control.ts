import { z } from 'zod'
import { ApprovalExecRequestMessage } from './approvals'
import { SessionOpenUrlCallbackMessage, SessionOpenUrlDismissMessage } from './browser-open'
import { CredentialExportRequestMessage, CredentialInstallRequestMessage } from './credentials'
import {
  BrowseDirsRequestMessage,
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
import {
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
import { InventoryRequestMessage } from './inventory'
import { AgentRelayResultMessage } from './issues'
import { AgentObservationAckMessage, AgentObservationRebindAckMessage } from './runtime-state'
import {
  DraftTargetMessage,
  InputMessage,
  KillMessage,
  ReattachMessage,
  RedrawMessage,
  ResizeMessage,
  SessionPriorityMessage,
  SessionResumeRefAckMessage,
  SpawnMessage,
} from './terminal'
import { TranscriptMirrorReadMessage, TranscriptReadRequestMessage } from './transcript'
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
  RepoOpRequestMessage,
  AgentRelayResultMessage,
  HarnessExecRequestMessage,
  HandoffExportRequestMessage,
  HandoffChunkReadRequestMessage,
  HandoffImportChunkMessage,
  HandoffImportRequestMessage,
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
  ImageUploadRequestMessage,
  SpawnMessage,
  ReattachMessage,
  KillMessage,
  AgentObservationAckMessage,
  AgentObservationRebindAckMessage,
  DraftTargetMessage,
  SessionResumeRefAckMessage,
  TranscriptMirrorReadMessage,
  SessionPriorityMessage,
  ScanRequestMessage,
  ScanReposRequestMessage,
  BrowseDirsRequestMessage,
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
])
export type ControlMessage = z.infer<typeof ControlMessage>
