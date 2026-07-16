import type { ClientSwitchTrace, PerfOpSummary, PerfSnapshot } from '@podium/protocol'

/**
 * Switch-latency perf registry [POD-701]: permanent, always-on, in-memory
 * aggregation of where server time goes when a user switches sessions/issues.
 *
 * Design constraints (this is on hot paths — the tRPC middleware times EVERY
 * call, and the sessions broadcast records per phase):
 *  - `record()` is O(1) and allocation-free after an op's first sample: per-name
 *    scalars (count/last/max/totalBytes) plus a preallocated Float64Array ring
 *    of recent samples. Percentiles are computed only at `snapshot()` time.
 *  - No dependencies beyond the @podium/protocol wire types.
 *
 * All times are milliseconds. Bytes are approximate where noted at call sites
 * (e.g. JSON string length, not UTF-8 encoded length).
 */

/** Recent-sample ring size per op — enough for stable p50/p90/p99. */
const SAMPLE_RING_SIZE = 512
/** Client switch traces kept (newest last). */
const CLIENT_TRACE_RING_SIZE = 100

interface OpStats {
  count: number
  lastMs: number
  maxMs: number
  totalBytes: number
  /** Ring of the most recent samples; `next` is the write cursor. */
  samples: Float64Array
  next: number
}

function newOpStats(): OpStats {
  return {
    count: 0,
    lastMs: 0,
    maxMs: 0,
    totalBytes: 0,
    samples: new Float64Array(SAMPLE_RING_SIZE),
    next: 0,
  }
}

/** Nearest-rank percentile over an ascending-sorted array (q in [0, 1]). */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[rank]!
}

function summarize(stats: OpStats): PerfOpSummary {
  const n = Math.min(stats.count, stats.samples.length)
  const recent = Array.from(stats.samples.subarray(0, n)).sort((a, b) => a - b)
  return {
    count: stats.count,
    p50Ms: percentile(recent, 0.5),
    p90Ms: percentile(recent, 0.9),
    p99Ms: percentile(recent, 0.99),
    maxMs: stats.maxMs,
    lastMs: stats.lastMs,
    totalBytes: stats.totalBytes,
  }
}

export class PerfRegistry {
  private rpc = new Map<string, OpStats>()
  private phases = new Map<string, OpStats>()
  private clientSwitches: ClientSwitchTrace[] = []
  private sinceAt = Date.now()

  /** Record one timed operation. O(1), no allocation after an op's first call. */
  record(kind: 'rpc' | 'phase', name: string, ms: number, bytes = 0): void {
    const map = kind === 'rpc' ? this.rpc : this.phases
    let stats = map.get(name)
    if (!stats) {
      stats = newOpStats()
      map.set(name, stats)
    }
    stats.count += 1
    stats.lastMs = ms
    if (ms > stats.maxMs) stats.maxMs = ms
    stats.totalBytes += bytes
    stats.samples[stats.next] = ms
    stats.next = (stats.next + 1) % stats.samples.length
  }

  /** Keep a completed client switch trace (bounded ring, newest last). */
  pushClientTrace(trace: ClientSwitchTrace): void {
    this.clientSwitches.push(trace)
    if (this.clientSwitches.length > CLIENT_TRACE_RING_SIZE) this.clientSwitches.shift()
  }

  /** Aggregate view — percentiles are computed here, not on the record path. */
  snapshot(): PerfSnapshot {
    const rpc: Record<string, PerfOpSummary> = {}
    for (const [name, stats] of this.rpc) rpc[name] = summarize(stats)
    const phases: Record<string, PerfOpSummary> = {}
    for (const [name, stats] of this.phases) phases[name] = summarize(stats)
    return { rpc, phases, clientSwitches: [...this.clientSwitches], sinceAt: this.sinceAt }
  }

  reset(): void {
    this.rpc.clear()
    this.phases.clear()
    this.clientSwitches = []
    this.sinceAt = Date.now()
  }
}

/**
 * The process-level registry every instrumentation site writes to. A singleton
 * (not per-SessionRegistry) so deep hot paths — the tRPC middleware, Session
 * replay, the broadcast pipeline — record without threading a dependency
 * through every constructor; relay.ts exposes this same instance as
 * `modules.perf` so router procs reach it through the normal module seam.
 */
export const perf = new PerfRegistry()
