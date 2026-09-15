import type { Principal, SyncMeta } from '@podium/protocol'

export const SYNC_WORKER_MAX_JOBS = 2
export const SYNC_WORKER_QUEUE_DEPTH = 8
export const SYNC_CHUNK_BYTES = 64 * 1024
export const SYNC_JOB_DEADLINE_MS = 10 * 60 * 1000

export interface BootstrapJob {
  transferId: string
  principal: Principal
  feedId: string
  epoch: string
  encoding: 'identity' | 'gzip' | 'zstd'
  /** Absolute epoch milliseconds; omitted means ten minutes from admission. */
  deadlineMs?: number
}
export type SyncMetaSummary = SyncMeta & { totalRows: number }
export type SyncFailureReason = 'queue-full' | 'cancelled' | 'deadline' | 'worker-crashed' | 'shutdown' | 'row-too-large' | 'producer-failed' | 'unavailable'
export class SyncWorkerError extends Error {
  constructor(readonly reason: SyncFailureReason) { super(`Sync bootstrap failed: ${reason}`); this.name = 'SyncWorkerError' }
}
export type ToWorker =
  | { type: 'start'; job: BootstrapJob }
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
