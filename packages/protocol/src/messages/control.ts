import { z } from 'zod'
import { ApprovalExecRequestMessage } from './approvals'
import { RepoOpRequestMessage, ScanReposRequestMessage, ScanRequestMessage } from './discovery'
import {
  DirListRequestMessage,
  FileAssetRequestMessage,
  FileReadRequestMessage,
  FileWriteRequestMessage,
  ImageUploadRequestMessage,
} from './files'
import { HarnessExecRequestMessage } from './harness'
import {
  HandoffChunkReadRequestMessage,
  HandoffExportRequestMessage,
  HandoffImportChunkMessage,
  HandoffImportRequestMessage,
} from './handoff'
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
import {
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

// ---- Server -> daemon control frames ----
export const ControlMessage = z.discriminatedUnion('type', [
  ApprovalExecRequestMessage,
  RepoOpRequestMessage,
  AgentRelayResultMessage,
  HarnessExecRequestMessage,
  HandoffExportRequestMessage,
  HandoffChunkReadRequestMessage,
  HandoffImportChunkMessage,
  HandoffImportRequestMessage,
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
  SessionResumeRefAckMessage,
  TranscriptMirrorReadMessage,
  SessionPriorityMessage,
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
  DirListRequestMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>
