import type {
  ClientSwitchTrace,
  PerfOpSummary,
  PerfPrincipalRef,
  PerfPrincipalSlice,
  PerfSliceSize,
  PerfSnapshot,
} from '@podium/protocol'

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
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION IS A REQUIRED ARGUMENT, AND THAT IS THE POINT (POD-736)
 * ---------------------------------------------------------------------------
 *
 * Every `record` names WHO the work was for: a {@link PerfPrincipalRef}, or the
 * literal {@link DEPLOYMENT} for work that genuinely belongs to nobody (log
 * pruning, boot). It is a required positional parameter rather than an optional
 * trailing option because an optional dimension is one a call site can forget,
 * and a sample with no principal is precisely the sample that makes a
 * post-cutover A/B invalid — the feed is per-principal now, so "which slice was
 * this measured over" has an answer at every site or the number means nothing.
 *
 * `DEPLOYMENT` is a NAMED answer, not a default. A site that reaches for it is
 * claiming the work is not on any principal's behalf, and that claim is visible
 * in the diff.
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
    p95Ms: percentile(recent, 0.95),
    p99Ms: percentile(recent, 0.99),
    maxMs: stats.maxMs,
    lastMs: stats.lastMs,
    totalBytes: stats.totalBytes,
  }
}

/**
 * Work that is on NO principal's behalf — change-log pruning, boot, event-log
 * compaction. A named answer to "whose slice is this", never a fallback.
 */
export const DEPLOYMENT = 'deployment' as const
export type PerfAttribution = PerfPrincipalRef | typeof DEPLOYMENT

/** The partition key. `DEPLOYMENT` gets a reserved one that no digest can collide
 *  with, because a digest is hex and this is not. */
const partitionKey = (attribution: PerfAttribution): string =>
  attribution === DEPLOYMENT ? DEPLOYMENT : attribution.digest

interface Partition {
  principal: PerfPrincipalRef | typeof DEPLOYMENT
  rpc: Map<string, OpStats>
  phases: Map<string, OpStats>
  clientSwitches: ClientSwitchTrace[]
  slice: { last: number; min: number; max: number; samples: number }
}

const newPartition = (principal: PerfAttribution): Partition => ({
  principal,
  rpc: new Map(),
  phases: new Map(),
  clientSwitches: [],
  slice: { last: 0, min: 0, max: 0, samples: 0 },
})

function bump(map: Map<string, OpStats>, name: string, ms: number, bytes: number): void {
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

const summarizeAll = (map: Map<string, OpStats>): Record<string, PerfOpSummary> => {
  const out: Record<string, PerfOpSummary> = {}
  for (const [name, stats] of map) out[name] = summarize(stats)
  return out
}

export class PerfRegistry {
  private rpc = new Map<string, OpStats>()
  private phases = new Map<string, OpStats>()
  private clientSwitches: ClientSwitchTrace[] = []
  private partitions = new Map<string, Partition>()
  private sinceAt = Date.now()

  private partition(attribution: PerfAttribution): Partition {
    const key = partitionKey(attribution)
    let existing = this.partitions.get(key)
    if (!existing) {
      existing = newPartition(attribution)
      this.partitions.set(key, existing)
    }
    return existing
  }

  /**
   * Record one timed operation, for one principal. O(1), no allocation after an
   * op's first call — two `bump`s per sample rather than one, which is the cost
   * of the dimension and is measured in nanoseconds.
   *
   * BOTH the deployment-wide aggregate AND the principal's partition, deliberately:
   * the aggregate is the shape every recorded POD-701 baseline is in, and dropping
   * it to "tidy up" would strand those baselines.
   */
  record(
    kind: 'rpc' | 'phase',
    name: string,
    ms: number,
    attribution: PerfAttribution,
    bytes = 0,
  ): void {
    bump(kind === 'rpc' ? this.rpc : this.phases, name, ms, bytes)
    const partition = this.partition(attribution)
    bump(kind === 'rpc' ? partition.rpc : partition.phases, name, ms, bytes)
  }

  /**
   * How many rows the Authority evaluated as visible to this principal.
   *
   * Recorded at BOOTSTRAP, because that is the one moment the whole slice is
   * enumerated — a delta batch's size is churn, not working set, and reporting it
   * as slice size is the mistake that makes an A/B look like a speedup.
   */
  observeSliceSize(principal: PerfPrincipalRef, rows: number): void {
    const slice = this.partition(principal).slice
    slice.last = rows
    slice.min = slice.samples === 0 ? rows : Math.min(slice.min, rows)
    slice.max = Math.max(slice.max, rows)
    slice.samples += 1
  }

  /**
   * Keep a completed client switch trace (bounded ring, newest last).
   *
   * THE ATTRIBUTION IS REQUIRED HERE TOO, and today the only caller can only
   * honestly pass {@link DEPLOYMENT} — see `modules/perf/commands.ts`. That is a
   * KNOWN GAP, stated at the type rather than papered over: a trace names a
   * `sessionId`, so the day two principals exist this ring is the harness's one
   * cross-principal exposure, and the reason it cannot be closed here is that
   * `perf.report` arrives over /trpc, which has no per-connection principal to
   * attribute it to. Deriving one from the trace's own `sessionId` would be
   * attribution read from payload, which ADR 3 Am1 D17 forbids for exactly the
   * reason that applies here: a client could then report a trace onto someone
   * else's partition.
   */
  pushClientTrace(trace: ClientSwitchTrace, attribution: PerfAttribution): void {
    this.clientSwitches.push(trace)
    if (this.clientSwitches.length > CLIENT_TRACE_RING_SIZE) this.clientSwitches.shift()
    if (attribution === DEPLOYMENT) return
    const partition = this.partition(attribution)
    partition.clientSwitches.push(trace)
    if (partition.clientSwitches.length > CLIENT_TRACE_RING_SIZE) partition.clientSwitches.shift()
  }

  /** Aggregate view — percentiles are computed here, not on the record path. */
  snapshot(): PerfSnapshot {
    const byPrincipal: Record<string, PerfPrincipalSlice> = {}
    for (const [key, partition] of this.partitions) {
      if (partition.principal === DEPLOYMENT) continue
      byPrincipal[key] = this.slice(partition)
    }
    return {
      rpc: summarizeAll(this.rpc),
      phases: summarizeAll(this.phases),
      clientSwitches: [...this.clientSwitches],
      sinceAt: this.sinceAt,
      byPrincipal,
    }
  }

  /**
   * ONE principal's partition, or `undefined` if it has none.
   *
   * The scoped read, expressible by SELECTION. Nothing on the tRPC surface calls
   * it yet and that is stated rather than hidden: `perf.snapshot` is declared
   * `deployment-substrate` (admin-grade) and the transport does not enforce
   * grades today — see the flag in `packages/commands/src/perf/contracts.ts`.
   * What this method buys is that serving a scoped read is a call-site change,
   * not a re-architecture, the day a grade is enforced.
   */
  snapshotFor(principal: PerfPrincipalRef): PerfPrincipalSlice | undefined {
    const partition = this.partitions.get(principal.digest)
    if (partition === undefined || partition.principal === DEPLOYMENT) return undefined
    return this.slice(partition)
  }

  private slice(partition: Partition): PerfPrincipalSlice {
    const sliceSize: PerfSliceSize = { ...partition.slice }
    return {
      principal: partition.principal as PerfPrincipalRef,
      sliceSize,
      rpc: summarizeAll(partition.rpc),
      phases: summarizeAll(partition.phases),
      clientSwitches: [...partition.clientSwitches],
    }
  }

  reset(): void {
    this.rpc.clear()
    this.phases.clear()
    this.clientSwitches = []
    this.partitions.clear()
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
