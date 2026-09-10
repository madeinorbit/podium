/**
 * WHAT THIS PROCESS'S EVENT LOOP DID, once a second and once a minute
 * (docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md §4).
 *
 * WHY IT EXISTS. Both components carried a stall probe that could say "a tick
 * blocked for 340 ms" and nothing else. Three numbers were missing and each one
 * cost an investigation:
 *
 *  - HOW BUSY the loop is at all. `performance.eventLoopUtilization()` returns
 *    zeros under Bun 1.3.x and `monitorEventLoopDelay` missed a measured 300 ms
 *    synchronous block outright, so a loop 80 percent busy in 20 ms slices —
 *    which is what the live server measured at, from /proc, on 2026-09-10 — was
 *    invisible to every instrument in the process. The main thread's own
 *    utime/stime out of /proc IS the busy number, and nothing else here is.
 *  - WHETHER THE BUSY IS OURS. A stall on a 10x-oversubscribed host is often
 *    runqueue wait, not work; the classifier already knew that per stall, and
 *    the same schedstat delta belongs on every window.
 *  - WHAT IT LOOKED LIKE LATER. Stalls were single log lines, so "percent of
 *    wall blocked" was recomputed by hand from journal output every time.
 *
 * So: one ring of one-second windows, one ring of one-minute rollups, and one
 * NDJSON line per minute through a sink. Both processes run this module
 * verbatim, which is also why `loop-metrics.ts` is now a wrapper over it — two
 * probe timers measuring the same loop would each perturb what the other reads.
 *
 * COST. Nothing here allocates per event: the rings are preallocated
 * `Float64Array`s, the per-second path is two `/proc` reads and a handful of
 * arithmetic, and the only per-minute allocation is the record itself. The
 * module measures its own wall time and reports it as `selfCostPct` in that
 * same record, so its overhead is a field a reader can check rather than a
 * claim this comment makes.
 */
import { readFileSync } from 'node:fs'
import type { LoopProfileLevel } from './config'
import {
  createStallClassifier,
  parseSchedstat,
  type StallClassification,
  type StallClassifier,
} from './loop-stall'

export type LoopComponent = 'server' | 'daemon'

/**
 * The fixed cost buckets both components attribute into (§6.1). Fixed, and
 * shared: a record whose bucket names varied by component could not be read
 * across the fleet, and `coverage` below only means something against a set
 * that does not change under the reader.
 *
 * A component only ever fills the buckets it has seams for — the daemon runs no
 * SQL — and an absent bucket is absent from its records rather than zero, so
 * "no cost" and "not measured here" stay distinguishable.
 */
export const LOOP_BUCKETS = [
  'ws.client',
  'ws.daemon',
  'rpc',
  'sql',
  'timers',
  'control',
  'frames',
  'tails',
  'worker',
] as const
export type LoopBucket = (typeof LOOP_BUCKETS)[number]

/**
 * Buckets whose cost is CONTAINED IN another bucket's, so a reader subtracts
 * them before comparing the sum to busy time (§6.2). SQL runs inside an rpc
 * handler, a timer callback and both WebSocket paths, so a bucket sum that
 * counts it twice can exceed 100 percent of a busy second without anything
 * being wrong.
 */
export const LOOP_NESTED_BUCKETS: readonly LoopBucket[] = ['sql']

/**
 * Buckets whose wall time SPANS work that is not theirs, so a reader must not
 * read them as own-CPU (§6.1). A tRPC call is timed across its awaits because
 * the handler's own time between them is not separable at that seam: the number
 * is real, it just is not exclusively `rpc`. Unlike a nested bucket there is
 * nothing to subtract — an inclusive bucket overlaps idle time as readily as it
 * overlaps another bucket — so it is FLAGGED rather than corrected for, and a
 * coverage above 1 on an rpc-heavy minute is that flag being earned.
 */
export const LOOP_INCLUSIVE_BUCKETS: readonly LoopBucket[] = ['rpc']

export interface LoopBucketCost {
  wallMs: number
  count: number
}

/** One long tick, as handed to the component's own reporter. */
export interface LoopStall {
  /** How late the probe fired, ms — the loop-blocked time. */
  durationMs: number
  /** Starved-vs-busy verdict, absent where schedstat is unreadable. */
  classification?: StallClassification
  /** Main-thread busy percentage of the last completed window. */
  utilizationPct?: number
}

/** One decoded second. Percentages are 0–100; absent where /proc could not answer. */
export interface LoopWindow {
  /** Epoch ms at the END of the window. */
  at: number
  utilizationPct?: number
  runqueueWaitPct?: number
  blockedMs: number
  stalls: number
  stallMaxMs: number
  heapUsedBytes: number
  rssBytes: number
  selfCostMs: number
  buckets?: Partial<Record<LoopBucket, LoopBucketCost>>
}

/** One minute, as written to the sink and kept in the minute ring (§4.3). */
export interface LoopMinute {
  /** ISO timestamp of the minute boundary this record closes. */
  at: string
  component: LoopComponent
  level: LoopProfileLevel
  utilizationPct?: number
  utilizationMaxPct?: number
  runqueueWaitPct?: number
  blockedPct: number
  stalls: number
  stallP50Ms: number
  stallP99Ms: number
  stallMaxMs: number
  heapUsedBytes: number
  rssBytes: number
  selfCostPct: number
  /**
   * Profile captures this minute that were refused because one was already
   * running or the five-minute rate limit had not elapsed (spec §8). A stall
   * burst that produced ONE profile and nine refusals is a different situation
   * from a stall burst that produced one profile, and only this says which.
   */
  profileSuppressed?: number
  /**
   * Main-thread ms this minute spent draining the sampling profiler's buffer.
   *
   * Kept OUT of `selfCostPct`, which is the accounting timer's own cost and is
   * paid at every level above `off`. This is paid only after the process's first
   * capture, and only at `attribution` and above, so folding the two together
   * would make the accounting overhead look like it doubled the moment someone
   * took a profile. See `loop-profile-capture.ts` for why the drain exists.
   */
  profilerCostMs?: number
  /**
   * Only the buckets that recorded at least once this minute. An absent bucket
   * is absent rather than zero, so "this component has no such seam" (the daemon
   * runs no SQL) and "that seam stayed quiet" stay distinguishable.
   */
  buckets?: Partial<Record<LoopBucket, LoopBucketCost>>
  /**
   * Top-level bucket sum over busy time — nested buckets subtracted, inclusive
   * ones left in. Below 0.5 means the next seam is missing (§6.2, POD-1931);
   * above 1 is possible on an rpc-heavy minute, see {@link LOOP_INCLUSIVE_BUCKETS}.
   */
  coverage?: number
  nestedBuckets?: readonly LoopBucket[]
  inclusive?: readonly LoopBucket[]
}

/** Where completed minutes go. The file implementation is `loop-minute-sink.ts`. */
export interface LoopMinuteSink {
  write(minute: LoopMinute): void
}

export interface LoopAccountingSnapshot {
  level: LoopProfileLevel
  component: LoopComponent
  /** The last 120 one-second windows, newest last. */
  windows: LoopWindow[]
  /** The last 60 one-minute rollups, newest last. */
  minutes: LoopMinute[]
}

export interface LoopAccountingHandle {
  stop(): void
  snapshot(): LoopAccountingSnapshot
  /** Feed one attributed cost into the current window. No-op below `attribution`. */
  attribute(bucket: LoopBucket, wallMs: number): void
  /**
   * Probe-lateness percentiles over the last {@link LATENESS_SAMPLES} fires, ms.
   *
   * This is what replaced `monitorEventLoopDelay`: the probe's lateness IS the
   * loop delay, it is measured by the same timer everything else here reads,
   * and unlike the histogram it does not go blind under Bun. Percentiles are
   * computed on demand — the hot path only writes one number into a ring.
   */
  delaySnapshot(): { p50: number; p99: number; max: number }
  /** The most recently completed window, for a caller that wants one number. */
  latestWindow(): LoopWindow | undefined
  /** The most recently completed minute, for the host metrics push (part C). */
  latestMinute(): LoopMinute | undefined
  /** Count one profile request that was refused. No-op below `attribution`. */
  noteProfileSuppressed(): void
  /** Add main-thread ms spent draining the sampling profiler. No-op below `attribution`. */
  noteProfilerCost(ms: number): void
}

/** Windows kept: two minutes of seconds. */
export const WINDOW_RING = 120
/** Minutes kept: an hour. */
export const MINUTE_RING = 60
/** Stall durations kept per minute for the percentiles; oldest dropped. */
export const STALL_RESERVOIR = 256
/** Probe lateness samples kept for {@link LoopAccountingHandle.delaySnapshot}. */
export const LATENESS_SAMPLES = 1024
/** Probe lateness below this is timer jitter, not blocked loop. */
const BLOCKED_FLOOR_MS = 5

/**
 * The window ring's column layout. The ring is one flat `Float64Array`, so
 * these indices are the schema: a column added in the middle silently
 * reinterprets every row, which is why they are named here once and nowhere
 * else. `NaN` is the ABSENT value — /proc answers neither utilization nor
 * runqueue wait off Linux, and a zero there would read as a perfectly idle
 * loop rather than as no measurement.
 */
export const LoopWindowColumn = {
  at: 0,
  utilizationPct: 1,
  runqueueWaitPct: 2,
  blockedMs: 3,
  stalls: 4,
  stallMaxMs: 5,
  heapUsedBytes: 6,
  rssBytes: 7,
  selfCostMs: 8,
} as const
/** Fixed columns; the bucket columns (wallMs, count per bucket) follow. */
const FIXED_COLUMNS = 9
const WINDOW_COLUMNS = FIXED_COLUMNS + LOOP_BUCKETS.length * 2

/**
 * Linux's USER_HZ. It is part of the kernel's userspace ABI — `/proc/<pid>/stat`
 * reports clock ticks in it — and 100 on every architecture Podium runs on.
 * Injectable rather than assumed so a host that disagrees is a parameter and
 * not a wrong utilization number nobody can explain.
 */
const DEFAULT_CLOCK_TICKS_PER_SECOND = 100

export interface MainThreadCpu {
  utimeTicks: number
  stimeTicks: number
}

/**
 * The main thread's user and system time, in clock ticks, from
 * `/proc/self/task/<pid>/stat` fields 14 and 15. The main thread's tid equals
 * the pid, and the THREAD's row is the point: `/proc/self/stat` is the whole
 * process, worker threads included, and a janitor thread burning a core would
 * read as a busy event loop.
 *
 * Field 2 (`comm`) is parenthesised and may itself contain spaces and a `)`, so
 * the split starts after the LAST `)` — the standard way to parse this file.
 * Undefined off Linux or on any unreadable/short row; the record then says the
 * utilization is absent rather than guessing at zero.
 */
export function parseProcStat(text: string): MainThreadCpu | undefined {
  const close = text.lastIndexOf(')')
  if (close === -1) return undefined
  // After `comm` the next field is `state` (field 3), so field N is index N - 3.
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const utimeTicks = Number(fields[11])
  const stimeTicks = Number(fields[12])
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return undefined
  return { utimeTicks, stimeTicks }
}

function readMainThreadCpuFromProc(): MainThreadCpu | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8'))
  } catch {
    return undefined
  }
}

function readSchedstatFromProc(): string {
  return readFileSync(`/proc/self/task/${process.pid}/schedstat`, 'utf8')
}

/** Nearest-rank percentile over an already-sorted slice. */
function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

export interface LoopAccountingOptions {
  component: LoopComponent
  level: LoopProfileLevel
  /** Probe lateness above this is a stall. Default 100 ms. */
  longTickMs?: number
  /** Window length. Default 1000 ms; the minute rollup is 60 of these. */
  sampleMs?: number
  /**
   * Called once per window at most, for the first stall in it — the same
   * throttle the probe has always had, because the caller writes a log record
   * per call and a wedged second must not produce fifty of them.
   */
  onLongTick?: (stall: LoopStall) => void
  /** Where completed minutes go. Absent means nothing is written anywhere. */
  sink?: LoopMinuteSink
  /** Monotonic ms clock; also what the probe's lateness is measured against. */
  now?: () => number
  /** Wall clock, for the minute record's ISO stamp only. */
  wallClockNow?: () => number
  readMainThreadCpu?: () => MainThreadCpu | undefined
  readSchedstat?: () => string
  memoryUsage?: () => { heapUsed: number; rss: number }
  clockTicksPerSecond?: number
}

/**
 * The one capability a RECORDING SEAM needs: somewhere to put a cost. Narrowed
 * to it on purpose — a seam that could also `stop()` the accounting, or read its
 * snapshot, is a seam that could change what it is supposed to be measuring.
 */
export type LoopAttributionSink = Pick<LoopAccountingHandle, 'attribute'>

/**
 * The accounting handles the recording seams feed, newest last.
 *
 * WHY A MODULE-LEVEL REGISTRY, which is otherwise the wrong shape. `recordQuery`,
 * `recordTask` and `measureTask` are called from the hot path of code that has no
 * idea this subsystem exists — a store driver, a socket handler — and threading a
 * handle down to every one of them would mean changing signatures across both
 * components to carry a diagnostic.
 *
 * WHY A LIST AND NOT ONE HANDLE. `all-in-one` hosts the server AND the daemon in
 * a single PID (apps/cli `roles: { server: true, daemon: true }`), so two handles
 * really do exist at once, each writing its own minute file. A single slot would
 * let the second registration silently capture every seam and leave the other
 * component's buckets empty — a wiring loss with no error and no empty-looking
 * log line, just a coverage figure that reads as a missing seam. There is one
 * event loop in that PID, so every seam's cost genuinely is on the loop both
 * records describe, and both receive it. In the split topology the list holds
 * exactly one handle and this is a one-iteration loop.
 *
 * An ARRAY walked by index rather than a Set: this runs once per statement and
 * once per frame, and an iterator allocation per call is not a cost a diagnostic
 * gets to add.
 */
const sinks: LoopAttributionSink[] = []

/**
 * Register an accounting handle with the recording seams. Called from a boot
 * path, once per handle; the returned function unregisters it.
 */
export function addLoopAccounting(handle: LoopAttributionSink): () => void {
  sinks.push(handle)
  return () => {
    const at = sinks.indexOf(handle)
    if (at >= 0) sinks.splice(at, 1)
  }
}

/** Drop every registered handle. For tests and for a hard process teardown. */
export function clearLoopAccounting(): void {
  sinks.length = 0
}

/**
 * Feed one attributed cost into this process's accounting.
 *
 * The single entry point into the buckets (§6.1), and a no-op below `attribution`
 * twice over: no boot path registers a handle there, and a handle's own
 * `attribute` is inert anyway. A seam therefore never has to ask what level it is
 * running at to know whether to call this, and an empty registry — the state
 * during boot, before accounting starts — costs one length check.
 */
export function attribute(bucket: LoopBucket, wallMs: number): void {
  for (let i = 0; i < sinks.length; i += 1) sinks[i]?.attribute(bucket, wallMs)
}

/** A handle that measures nothing, for level `off` and for `stop()`ped callers. */
function inertHandle(component: LoopComponent, level: LoopProfileLevel): LoopAccountingHandle {
  return {
    stop() {},
    snapshot: () => ({ level, component, windows: [], minutes: [] }),
    attribute() {},
    delaySnapshot: () => ({ p50: 0, p99: 0, max: 0 }),
    latestWindow: () => undefined,
    latestMinute: () => undefined,
    noteProfileSuppressed() {},
    noteProfilerCost() {},
  }
}

/**
 * Start accounting for this process's event loop.
 *
 * At level `off` this registers NO timer, opens NO file and reads NO /proc: it
 * returns the inert handle above, so an install that is not profiling is on
 * byte-for-byte the path it was on before any of this existed. That property is
 * the reason the level is checked here rather than at each call site.
 */
export function startLoopAccounting(opts: LoopAccountingOptions): LoopAccountingHandle {
  const { component, level } = opts
  if (level === 'off') return inertHandle(component, level)

  const sampleMs = opts.sampleMs ?? 1000
  const longTickMs = opts.longTickMs ?? 100
  const now = opts.now ?? (() => performance.now())
  const wallClockNow = opts.wallClockNow ?? (() => Date.now())
  const readCpu = opts.readMainThreadCpu ?? readMainThreadCpuFromProc
  const readSchedstat = opts.readSchedstat ?? readSchedstatFromProc
  const memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage())
  const ticksPerSecond = opts.clockTicksPerSecond ?? DEFAULT_CLOCK_TICKS_PER_SECOND
  const attributing = level === 'attribution' || level === 'full'

  const windows = new Float64Array(WINDOW_RING * WINDOW_COLUMNS)
  let windowCount = 0
  const minutes: LoopMinute[] = []
  const lateness = new Float64Array(LATENESS_SAMPLES)
  let latenessCount = 0
  const stallReservoir = new Float64Array(STALL_RESERVOIR)
  let stallReservoirCount = 0
  const windowBuckets = new Float64Array(LOOP_BUCKETS.length * 2)
  const minuteBuckets = new Float64Array(LOOP_BUCKETS.length * 2)

  // Per-window accumulators, reset at each sample.
  let blockedMs = 0
  let windowStalls = 0
  let windowStallMaxMs = 0
  let stalledThisWindow = false

  // Per-minute accumulators. Percentages fold from summed ms rather than from a
  // mean of per-window percentages: a window that ran long (the loop was
  // blocked when the sample timer should have fired) would otherwise count the
  // same as a short one, which is precisely backwards.
  let minuteWallMs = 0
  let minuteCpuMs = 0
  let minuteCpuMeasured = false
  let minuteWaitMs = 0
  let minuteWaitMeasured = false
  let minuteBlockedMs = 0
  let minuteStalls = 0
  let minuteStallMaxMs = 0
  let minuteUtilizationMaxPct = Number.NaN
  let minuteSelfCostMs = 0
  let minuteProfileSuppressed = 0
  let minuteProfilerCostMs = 0
  let windowsThisMinute = 0

  const classifier: StallClassifier | undefined = createStallClassifier({ readSchedstat })
  let lastCpu = readCpu()
  let lastWaitNs = readWaitNs()
  let lastSampleAt = now()
  let latestWindowIndex = -1

  function readWaitNs(): number | undefined {
    try {
      return parseSchedstat(readSchedstat())
    } catch {
      return undefined
    }
  }

  function bucketIndex(bucket: LoopBucket): number {
    return LOOP_BUCKETS.indexOf(bucket) * 2
  }

  function latestUtilizationPct(): number | undefined {
    if (latestWindowIndex < 0) return undefined
    const value = windows[latestWindowIndex * WINDOW_COLUMNS + LoopWindowColumn.utilizationPct]
    return value === undefined || Number.isNaN(value) ? undefined : value
  }

  /**
   * The probe: a short self-scheduling timer whose LATENESS is the loop-blocked
   * time. It stays the authoritative detector — a synchronous block always
   * delays the next fire, whatever a sampling histogram does or does not see.
   */
  const probeMs = Math.max(5, Math.min(20, Math.floor(sampleMs / 4)))
  let expected = now() + probeMs
  const probe = setInterval(() => {
    const t = now()
    const late = t - expected
    expected = t + probeMs
    if (late <= 0) return
    lateness[latenessCount % LATENESS_SAMPLES] = late
    latenessCount += 1
    if (late > BLOCKED_FLOOR_MS) blockedMs += late
    if (late > longTickMs) {
      windowStalls += 1
      if (late > windowStallMaxMs) windowStallMaxMs = late
      if (late > minuteStallMaxMs) minuteStallMaxMs = late
      stallReservoir[stallReservoirCount % STALL_RESERVOIR] = late
      stallReservoirCount += 1
      if (!stalledThisWindow && opts.onLongTick) {
        stalledThisWindow = true
        // Classified ONCE: `classify` reads /proc, and this is the one path
        // here that runs while the loop is already known to be in trouble.
        const classification = classifier?.classify(late)
        const utilizationPct = latestUtilizationPct()
        opts.onLongTick({
          durationMs: late,
          ...(classification ? { classification } : {}),
          ...(utilizationPct === undefined ? {} : { utilizationPct }),
        })
      }
    }
  }, probeMs)
  probe.unref?.()

  /**
   * Decode the bucket columns, KEEPING ONLY what recorded. The ring always has a
   * column per bucket — it is a fixed-width array — but a column that never took
   * a sample must not reach the record as a zero, or every daemon minute would
   * claim it measured 0 ms of SQL rather than that it measures none.
   */
  function readBuckets(source: Float64Array): Partial<Record<LoopBucket, LoopBucketCost>> {
    const out: Partial<Record<LoopBucket, LoopBucketCost>> = {}
    for (const [index, bucket] of LOOP_BUCKETS.entries()) {
      const count = source[index * 2 + 1] ?? 0
      if (count === 0) continue
      out[bucket] = { wallMs: source[index * 2] ?? 0, count }
    }
    return out
  }

  function flushMinute(endedAt: number): void {
    const wallMs = minuteWallMs || 1
    const sorted = Array.from(
      stallReservoir.slice(0, Math.min(stallReservoirCount, STALL_RESERVOIR)),
    ).sort((a, b) => a - b)
    const busyMs = minuteCpuMeasured ? minuteCpuMs : undefined
    const buckets = attributing ? readBuckets(minuteBuckets) : undefined
    // The TOP-LEVEL sum: nested buckets come back out, because their cost is
    // already inside the bucket that called them. Counting sql twice is what
    // would turn a minute one seam explains a sixth of into a claimed half.
    let bucketSum = 0
    if (buckets)
      for (const [bucket, cost] of Object.entries(buckets) as [LoopBucket, LoopBucketCost][]) {
        if (!LOOP_NESTED_BUCKETS.includes(bucket)) bucketSum += cost.wallMs
      }
    const minute: LoopMinute = {
      at: new Date(Math.floor(endedAt / 60_000) * 60_000).toISOString(),
      component,
      level,
      ...(minuteCpuMeasured ? { utilizationPct: (minuteCpuMs / wallMs) * 100 } : {}),
      ...(Number.isNaN(minuteUtilizationMaxPct)
        ? {}
        : { utilizationMaxPct: minuteUtilizationMaxPct }),
      ...(minuteWaitMeasured ? { runqueueWaitPct: (minuteWaitMs / wallMs) * 100 } : {}),
      blockedPct: (minuteBlockedMs / wallMs) * 100,
      stalls: minuteStalls,
      stallP50Ms: percentileOf(sorted, 0.5),
      stallP99Ms: percentileOf(sorted, 0.99),
      stallMaxMs: minuteStallMaxMs,
      heapUsedBytes:
        windows[latestWindowIndex * WINDOW_COLUMNS + LoopWindowColumn.heapUsedBytes] ?? 0,
      rssBytes: windows[latestWindowIndex * WINDOW_COLUMNS + LoopWindowColumn.rssBytes] ?? 0,
      selfCostPct: (minuteSelfCostMs / wallMs) * 100,
      ...(minuteProfileSuppressed > 0 ? { profileSuppressed: minuteProfileSuppressed } : {}),
      ...(minuteProfilerCostMs > 0 ? { profilerCostMs: minuteProfilerCostMs } : {}),
      ...(buckets
        ? {
            buckets,
            // Coverage needs a busy number to divide by; off Linux there is
            // none, and a coverage figure computed against wall time would
            // read as "the seams explain a third of it" on an idle process.
            ...(busyMs && busyMs > 0 ? { coverage: bucketSum / busyMs } : {}),
            nestedBuckets: LOOP_NESTED_BUCKETS,
            inclusive: LOOP_INCLUSIVE_BUCKETS,
          }
        : {}),
    }
    minutes.push(minute)
    if (minutes.length > MINUTE_RING) minutes.shift()
    try {
      opts.sink?.write(minute)
    } catch {
      // A sink that cannot write is a diagnostic failing, and a diagnostic that
      // can stop the sample timer is worse than the gap it would leave. The
      // sink reports its own failure (it degrades to the console); the ring
      // above keeps the record either way.
    }

    minuteWallMs = 0
    minuteCpuMs = 0
    minuteCpuMeasured = false
    minuteWaitMs = 0
    minuteWaitMeasured = false
    minuteBlockedMs = 0
    minuteStalls = 0
    minuteStallMaxMs = 0
    minuteUtilizationMaxPct = Number.NaN
    minuteSelfCostMs = 0
    minuteProfileSuppressed = 0
    minuteProfilerCostMs = 0
    windowsThisMinute = 0
    stallReservoirCount = 0
    minuteBuckets.fill(0)
  }

  /** One window: sample, write the row, roll the minute up when it is full. */
  function sample(): void {
    const startedAt = now()
    const wallMs = Math.max(1, startedAt - lastSampleAt)
    lastSampleAt = startedAt

    const cpu = readCpu()
    let utilizationPct = Number.NaN
    if (cpu && lastCpu) {
      const ticks = cpu.utimeTicks - lastCpu.utimeTicks + (cpu.stimeTicks - lastCpu.stimeTicks)
      const cpuMs = Math.max(0, (ticks / ticksPerSecond) * 1000)
      utilizationPct = (cpuMs / wallMs) * 100
      minuteCpuMs += cpuMs
      minuteCpuMeasured = true
    }
    if (cpu) lastCpu = cpu

    const waitNs = readWaitNs()
    let runqueueWaitPct = Number.NaN
    if (waitNs !== undefined && lastWaitNs !== undefined) {
      const waitMs = Math.max(0, waitNs - lastWaitNs) / 1e6
      runqueueWaitPct = (waitMs / wallMs) * 100
      minuteWaitMs += waitMs
      minuteWaitMeasured = true
    }
    if (waitNs !== undefined) lastWaitNs = waitNs

    const memory = memoryUsage()

    const index = windowCount % WINDOW_RING
    const base = index * WINDOW_COLUMNS
    windows[base + LoopWindowColumn.at] = wallClockNow()
    windows[base + LoopWindowColumn.utilizationPct] = utilizationPct
    windows[base + LoopWindowColumn.runqueueWaitPct] = runqueueWaitPct
    windows[base + LoopWindowColumn.blockedMs] = blockedMs
    windows[base + LoopWindowColumn.stalls] = windowStalls
    windows[base + LoopWindowColumn.stallMaxMs] = windowStallMaxMs
    windows[base + LoopWindowColumn.heapUsedBytes] = memory.heapUsed
    windows[base + LoopWindowColumn.rssBytes] = memory.rss
    for (let i = 0; i < windowBuckets.length; i += 1) {
      windows[base + FIXED_COLUMNS + i] = windowBuckets[i] ?? 0
    }
    latestWindowIndex = index
    windowCount += 1

    minuteWallMs += wallMs
    minuteBlockedMs += blockedMs
    minuteStalls += windowStalls
    if (!Number.isNaN(utilizationPct)) {
      minuteUtilizationMaxPct = Number.isNaN(minuteUtilizationMaxPct)
        ? utilizationPct
        : Math.max(minuteUtilizationMaxPct, utilizationPct)
    }
    windowsThisMinute += 1

    blockedMs = 0
    windowStalls = 0
    windowStallMaxMs = 0
    stalledThisWindow = false
    windowBuckets.fill(0)

    // Re-anchor the starved-vs-busy deltas so a stall is classified against
    // roughly the current window. A stall delays BOTH timers and the probe
    // (registered first, shorter interval) fires first, so the stall is
    // classified against the pre-stall baseline before this moves it.
    classifier?.refreshBaseline()

    if (windowsThisMinute >= 60) flushMinute(wallClockNow())

    // The self cost of THIS window lands in the NEXT one, which is the only
    // ordering available: the row is already written. Over a minute it is the
    // same total, which is what `selfCostPct` reports.
    const cost = now() - startedAt
    windows[base + LoopWindowColumn.selfCostMs] = cost
    minuteSelfCostMs += cost
  }

  const sampleTimer = setInterval(sample, sampleMs)
  sampleTimer.unref?.()

  function decodeWindow(index: number): LoopWindow {
    const base = index * WINDOW_COLUMNS
    const utilizationPct = windows[base + LoopWindowColumn.utilizationPct]
    const runqueueWaitPct = windows[base + LoopWindowColumn.runqueueWaitPct]
    return {
      at: windows[base + LoopWindowColumn.at] ?? 0,
      ...(utilizationPct === undefined || Number.isNaN(utilizationPct) ? {} : { utilizationPct }),
      ...(runqueueWaitPct === undefined || Number.isNaN(runqueueWaitPct)
        ? {}
        : { runqueueWaitPct }),
      blockedMs: windows[base + LoopWindowColumn.blockedMs] ?? 0,
      stalls: windows[base + LoopWindowColumn.stalls] ?? 0,
      stallMaxMs: windows[base + LoopWindowColumn.stallMaxMs] ?? 0,
      heapUsedBytes: windows[base + LoopWindowColumn.heapUsedBytes] ?? 0,
      rssBytes: windows[base + LoopWindowColumn.rssBytes] ?? 0,
      selfCostMs: windows[base + LoopWindowColumn.selfCostMs] ?? 0,
      ...(attributing
        ? { buckets: readBuckets(windows.subarray(base + FIXED_COLUMNS, base + WINDOW_COLUMNS)) }
        : {}),
    }
  }

  return {
    stop() {
      clearInterval(probe)
      clearInterval(sampleTimer)
    },
    snapshot() {
      const count = Math.min(windowCount, WINDOW_RING)
      const first = windowCount <= WINDOW_RING ? 0 : windowCount % WINDOW_RING
      const decoded: LoopWindow[] = []
      for (let i = 0; i < count; i += 1) decoded.push(decodeWindow((first + i) % WINDOW_RING))
      return { level, component, windows: decoded, minutes: [...minutes] }
    },
    attribute(bucket, wallMs) {
      if (!attributing) return
      const index = bucketIndex(bucket)
      if (index < 0) return
      windowBuckets[index] = (windowBuckets[index] ?? 0) + wallMs
      windowBuckets[index + 1] = (windowBuckets[index + 1] ?? 0) + 1
      minuteBuckets[index] = (minuteBuckets[index] ?? 0) + wallMs
      minuteBuckets[index + 1] = (minuteBuckets[index + 1] ?? 0) + 1
    },
    delaySnapshot() {
      const count = Math.min(latenessCount, LATENESS_SAMPLES)
      const sorted = Array.from(lateness.slice(0, count)).sort((a, b) => a - b)
      return {
        p50: percentileOf(sorted, 0.5),
        p99: percentileOf(sorted, 0.99),
        max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
      }
    },
    latestWindow() {
      return latestWindowIndex < 0 ? undefined : decodeWindow(latestWindowIndex)
    },
    latestMinute() {
      return minutes[minutes.length - 1]
    },
    noteProfileSuppressed() {
      if (!attributing) return
      minuteProfileSuppressed += 1
    },
    noteProfilerCost(ms) {
      if (!attributing || !Number.isFinite(ms) || ms <= 0) return
      minuteProfilerCostMs += ms
    },
  }
}
