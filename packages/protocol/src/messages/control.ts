import { z } from 'zod'
import { ApprovalExecRequestMessage } from './approvals'
import { RepoOpRequestMessage, ScanReposRequestMessage, ScanRequestMessage } from './discovery'
import { FileAssetRequestMessage, FileReadRequestMessage, FileWriteRequestMessage, DirListRequestMessage, ImageUploadRequestMessage } from './files'
import { HarnessExecRequestMessage } from './harness'
import { HeadlessBindMessage, HeadlessInterruptMessage, HeadlessTurnRequestMessage } from './headless'
import { AgentQuotaRequestMessage, MemoryBreakdownRequestMessage, UsageRequestMessage } from './host'
import { IssueRelayResultMessage } from './issues'
import {
  InputMessage,
  KillMessage,
  ReattachMessage,
  RedrawMessage,
  ResizeMessage,
  SessionPriorityMessage,
  SpawnMessage,
} from './terminal'
import { TranscriptMirrorReadMessage, TranscriptReadRequestMessage } from './transcript'

// ---- Server -> daemon control frames ----
export const ControlMessage = z.discriminatedUnion('type', [
  ApprovalExecRequestMessage,
  RepoOpRequestMessage,
  IssueRelayResultMessage,
  HarnessExecRequestMessage,
  HeadlessTurnRequestMessage,
  HeadlessInterruptMessage,
  HeadlessBindMessage,
  UsageRequestMessage,
  AgentQuotaRequestMessage,
  ImageUploadRequestMessage,
  SpawnMessage,
  ReattachMessage,
  KillMessage,
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
