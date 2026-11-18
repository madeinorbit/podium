// workspace-scoped (POD-6959)
import type { WorkspaceId } from '@podium/model'
import type {
  ClientType,
  CollectionInstance,
  Principal,
  SyncBootstrapRequiredReason,
  SyncMeta,
} from '@podium/protocol'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'

export const SYNC_WORKER_MAX_JOBS = 2
export const SYNC_WORKER_QUEUE_DEPTH = 8
export const SYNC_CHUNK_BYTES = 64 * 1024
export const SYNC_JOB_DEADLINE_MS = 10 * 60 * 1000

export interface BootstrapJob {
  mode?: 'snapshot'
  transferId: string
  principal: Principal
  feedId: string
  epoch: string
  encoding: 'identity' | 'gzip' | 'zstd'
  /** Whose policy orders the first download (POD-7085); absent is a browser's. */
  clientType?: ClientType
  /** What the visible view asked for: the first download's second step. */
  view?: readonly CollectionInstance[]
  /** Absolute epoch milliseconds; omitted means ten minutes from admission. */
  deadlineMs?: number
  /**
   * The workspace whose feed and records the job reads (POD-6959 design 2.7):
   * every read the worker runs for it is that workspace's. Omitted means the
   * self-hosted install's one workspace, until hosted routing (POD-6960) names
   * the workspace of each request.
   */
  workspaceId?: WorkspaceId
}
/** A fetch of named collection instances (`POST /sync/collections`, POD-7085). */
export interface CollectionsJob extends Omit<BootstrapJob, 'mode' | 'view'> {
  mode: 'collections'
  instances: readonly CollectionInstance[]
}
export interface DeltaJob extends Omit<BootstrapJob, 'mode' | 'clientType' | 'view'> {
  mode: 'delta'
  from: number
  to?: number
  pageRows?: number
}
export type SyncJob = BootstrapJob | DeltaJob | CollectionsJob
/** The workspace a job reads: its own, or the self-hosted install's when omitted. */
export const jobWorkspaceId = (job: SyncJob): WorkspaceId =>
  job.workspaceId ?? SELF_HOSTED_WORKSPACE_ID
export type SyncMetaSummary = SyncMeta
export type SyncFailureReason =
  | SyncBootstrapRequiredReason
  | 'queue-full'
  | 'cancelled'
  | 'deadline'
  | 'worker-crashed'
  | 'shutdown'
  | 'row-too-large'
  | 'producer-failed'
  | 'unavailable'
export class SyncWorkerError extends Error {
  constructor(readonly reason: SyncFailureReason) {
    super(`Sync bootstrap failed: ${reason}`)
    this.name = 'SyncWorkerError'
  }
}
export type ToWorker =
  | { type: 'start'; job: SyncJob }
  | { type: 'credit'; transferId: string; n: number }
  | { type: 'cancel'; transferId: string; reason?: SyncFailureReason }
  | { type: 'stop' }
export type FromWorker =
  | { type: 'ready' }
  | { type: 'heartbeat'; progressVersion: number; jobs: number }
  | { type: 'meta'; transferId: string; meta: SyncMetaSummary }
  | { type: 'bytes'; transferId: string; chunk: ArrayBuffer }
  | { type: 'metrics'; transferId: string; metrics: BootstrapMetrics }
  | { type: 'end'; transferId: string }
  | { type: 'error'; transferId: string; reason: SyncFailureReason }

export interface BootstrapMetrics {
  transferId: string
  phases: Record<string, { ms: number; bytes: number }>
  rows: number
  refs: number
  records: number
  bytesBefore: number
  bytesAfter: number
  queueWaitMs: number
  outcome: string
  /** RSS belongs to the process; heapUsed is sampled in the worker isolate. */
  peakProcessRss: number
  heapBefore: number
  heapAfterPrefetch: number
}
