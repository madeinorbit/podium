/**
 * Process-local workspace write diagnostics, not stored facts. No SQL, timers or
 * per-statement samples. Percentiles are computed only on read. At most 128
 * workspace entries survive; a write touches the LRU and evicts the oldest.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  MetricHistogram,
  WorkspaceWriteMetricsSnapshot,
  WorkspaceWriteSummary,
} from '@podium/protocol'

export const WORKSPACE_METRICS_CAPACITY = 128
const RECENT_SAMPLES = 512
const RATE_SECONDS = 60
const DURATION_BOUNDS = [0, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 5_000]
const RATE_BOUNDS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 4_096]

class Histogram {
  private readonly recent = new Float64Array(RECENT_SAMPLES)
  private readonly buckets: number[]
  private count = 0
  private total = 0
  private max = 0

  constructor(private readonly bounds: readonly number[]) {
    this.buckets = Array.from({ length: bounds.length + 1 }, () => 0)
  }

  record(value: number): void {
    this.recent[this.count % RECENT_SAMPLES] = value
    this.count++
    this.total += value
    this.max = Math.max(this.max, value)
    let bucket = 0
    while (bucket < this.bounds.length && value > this.bounds[bucket]!) bucket++
    this.buckets[bucket]!++
  }

  snapshot(): MetricHistogram {
    const sorted = Array.from(this.recent.subarray(0, Math.min(this.count, RECENT_SAMPLES))).sort(
      (a, b) => a - b,
    )
    const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0
    return {
      count: this.count,
      total: this.total,
      max: this.max,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      buckets: [...this.buckets],
    }
  }
}

class WorkspaceStats {
  readonly wait = new Histogram(DURATION_BOUNDS)
  readonly writeWait = new Histogram(DURATION_BOUNDS)
  readonly hold = new Histogram(DURATION_BOUNDS)
  readonly queue = new Histogram(DURATION_BOUNDS)
  readonly seconds = new Float64Array(RATE_SECONDS).fill(-1)
  readonly writes = new Float64Array(RATE_SECONDS)
  committed = 0
  rolledBack = 0
  acquisitionFailures = 0
  failed = 0
  uncalibratedWaits = 0

  constructor(readonly sinceMs: number) {}

  commit(now: number): void {
    this.committed++
    const second = Math.floor(now / 1_000)
    const slot = second % RATE_SECONDS
    if (this.seconds[slot] !== second) {
      this.seconds[slot] = second
      this.writes[slot] = 0
    }
    this.writes[slot]!++
  }

  snapshot(now: number): WorkspaceWriteSummary {
    const rates = new Histogram(RATE_BOUNDS)
    const end = Math.floor(now / 1_000)
    // Complete seconds only; include idle seconds without a timer or an idle loop.
    for (
      let second = Math.max(Math.ceil(this.sinceMs / 1_000), end - RATE_SECONDS);
      second < end;
      second++
    ) {
      const slot = second % RATE_SECONDS
      rates.record(this.seconds[slot] === second ? this.writes[slot]! : 0)
    }
    const observedMs = Math.max(0, now - this.sinceMs)
    return {
      committed: this.committed,
      rolledBack: this.rolledBack,
      acquisitionFailures: this.acquisitionFailures,
      failed: this.failed,
      uncalibratedWaits: this.uncalibratedWaits,
      observedMs,
      writesPerSecond: (this.committed * 1_000) / Math.max(1, observedMs),
      waitMs: this.wait.snapshot(),
      writeWaitMs: this.writeWait.snapshot(),
      holdMs: this.hold.snapshot(),
      schedulerQueueMs: this.queue.snapshot(),
      writesPerSecondHistogram: rates.snapshot(),
    }
  }
}

export interface WorkspaceWriteObservation {
  readonly workspaceId: string
  readonly outcome: 'committed' | 'rolled-back' | 'acquisition-failed' | 'failed'
  /** BEGIN+lock reply minus the minimum recent plain pipeline round trip. */
  readonly waitMs: number | undefined
  readonly schedulerQueueMs: number
  /** BEGIN request to COMMIT/ROLLBACK reply, minus estimated lock wait. */
  readonly holdMs: number
  readonly acquisitionMs: number
  readonly roundTrips: number
  readonly statements: number
  /** Native driver pipeline time, excluding estimated lock wait. */
  readonly driverMs: number
  /** Native statement/batch pipeline time; a subset of driverMs. */
  readonly statementMs: number
}

export class WorkspaceWriteMetrics {
  private readonly workspaces = new Map<string, WorkspaceStats>()
  private readonly listeners = new Set<(sample: WorkspaceWriteObservation) => void>()
  private evicted = 0

  constructor(
    readonly capacity = WORKSPACE_METRICS_CAPACITY,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('workspace metric capacity must be positive')
  }

  private touch(workspace: string, now: number): WorkspaceStats {
    let stats = this.workspaces.get(workspace)
    if (stats) this.workspaces.delete(workspace)
    else {
      if (this.workspaces.size === this.capacity) {
        this.workspaces.delete(this.workspaces.keys().next().value!)
        this.evicted++
      }
      stats = new WorkspaceStats(now)
    }
    this.workspaces.set(workspace, stats)
    return stats
  }

  record(sample: WorkspaceWriteObservation): void {
    const now = this.now()
    const stats = this.touch(sample.workspaceId, now)
    if (sample.outcome === 'acquisition-failed') stats.acquisitionFailures++
    else {
      if (sample.waitMs === undefined) stats.uncalibratedWaits++
      else {
        stats.wait.record(sample.waitMs)
        stats.writeWait.record(sample.waitMs + sample.schedulerQueueMs)
      }
      stats.hold.record(sample.holdMs)
      if (sample.outcome === 'committed') stats.commit(now)
      else if (sample.outcome === 'rolled-back') stats.rolledBack++
      else stats.failed++
    }
    for (const listener of this.listeners) {
      try {
        listener(sample)
      } catch {
        /* Diagnostics cannot change a committed write's result. */
      }
    }
  }

  recordQueue(workspace: string, ms: number): void {
    this.touch(workspace, this.now()).queue.record(ms)
  }

  /** Diagnostic subscription; no retained per-write objects without a subscriber. */
  probe(listener: (sample: WorkspaceWriteObservation) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(workspace?: string): WorkspaceWriteMetricsSnapshot {
    const now = this.now()
    const selected =
      workspace === undefined
        ? this.workspaces
        : this.workspaces.has(workspace)
          ? [[workspace, this.workspaces.get(workspace)!] as const]
          : []
    return {
      capacity: this.capacity,
      evictedWorkspaces: this.evicted,
      durationBoundsMs: [...DURATION_BOUNDS],
      rateBounds: [...RATE_BOUNDS],
      byWorkspace: Object.fromEntries(
        [...selected].map(([id, stats]) => [id, stats.snapshot(now)]),
      ),
    }
  }
}

export const workspaceWriteMetrics = new WorkspaceWriteMetrics()

// A lease may run more than one transaction (post-commit work). Charge its queue
// once, to the first write, rather than adding the same wait to every transaction.
const admission = new AsyncLocalStorage<{ queueMs: number }>()
export function withWorkspaceWriteAdmission<T>(queueMs: number, run: () => T): T {
  return admission.run({ queueMs }, run)
}

/** Minimum of 32 recent, existing single-step round trips. No calibration query. */
export class PlainRoundTripBaseline {
  private readonly recent = new Float64Array(32)
  private count = 0

  record(ms: number): void {
    this.recent[this.count++ % this.recent.length] = ms
  }

  estimate(): number | undefined {
    if (this.count === 0) return undefined
    let minimum = Number.POSITIVE_INFINITY
    for (let at = 0; at < Math.min(this.count, this.recent.length); at++)
      minimum = Math.min(minimum, this.recent[at]!)
    return minimum
  }
}

/** One lease's counters, shared by its existing pipelines. Never a stored fact. */
export class WorkspaceWriteTiming {
  private workspace: string | undefined
  private startedAt = 0
  private acquiredAt: number | undefined
  private baselineMs: number | undefined
  private queueMs = 0
  private trips = 0
  private statements = 0
  private pipelineMs = 0
  private statementMs = 0

  constructor(
    private readonly baseline: PlainRoundTripBaseline,
    private readonly metrics = workspaceWriteMetrics,
    private readonly now: () => number = () => performance.now(),
  ) {}

  begin(workspace: string): void {
    this.workspace = workspace
    this.startedAt = this.now()
    this.acquiredAt = undefined
    this.baselineMs = this.baseline.estimate()
    const queued = admission.getStore()
    this.queueMs = queued?.queueMs ?? 0
    if (queued) queued.queueMs = 0
    this.trips = this.statements = this.pipelineMs = this.statementMs = 0
  }

  acquired(): void {
    this.acquiredAt = this.now()
  }

  pipeline(
    ms: number,
    steps: number,
    statements: number,
    succeeded: boolean,
    locking: boolean,
  ): void {
    if (this.workspace !== undefined) {
      this.trips++
      this.statements += statements
      this.pipelineMs += ms
      if (statements > 0) this.statementMs += ms
    }
    // A lock pipeline is never its own baseline; neither are cold multi-step batches.
    if (succeeded && steps === 1 && !locking) this.baseline.record(ms)
  }

  end(outcome: WorkspaceWriteObservation['outcome']): void {
    if (this.workspace === undefined) return
    const waitMs =
      this.acquiredAt === undefined || this.baselineMs === undefined
        ? undefined
        : Math.max(0, this.acquiredAt - this.startedAt - this.baselineMs)
    const duration = this.now() - this.startedAt
    this.metrics.record({
      workspaceId: this.workspace,
      outcome,
      waitMs,
      schedulerQueueMs: this.queueMs,
      holdMs: outcome === 'acquisition-failed' ? 0 : Math.max(0, duration - (waitMs ?? 0)),
      acquisitionMs: (this.acquiredAt ?? this.now()) - this.startedAt,
      roundTrips: this.trips,
      statements: this.statements,
      driverMs: Math.max(0, this.pipelineMs - (waitMs ?? 0)),
      statementMs:
        this.trips === 1 ? Math.max(0, this.statementMs - (waitMs ?? 0)) : this.statementMs,
    })
    this.workspace = undefined
  }
}
