/**
 * Attribution layer for the daemon event loop, paired with `@podium/runtime`'s
 * `startLoopMetrics`. When the loop-metrics probe detects a long tick it calls
 * {@link reportLongTick}, which dumps WHAT the loop was busy with in the ~1s
 * around the stall: per-window activity counters (PTY frames, control messages,
 * transcript-tail deltas, worker hand-backs) plus a heap/RSS snapshot. A stall
 * with no discrete cause in the mix but a large/growing heap implicates GC —
 * Bun does not emit GC PerformanceObserver entries, so we infer it.
 *
 * Everything here is a no-op unless `PODIUM_LOOP_PROFILE` is set.
 */
import { formatStallClassification, type StallClassification } from '@podium/runtime/loop-metrics'

const ENABLED = !!process.env.PODIUM_LOOP_PROFILE
export const loopProfileEnabled = ENABLED

const ctr = { frames: 0, frameBytes: 0, control: 0, tails: 0, worker: 0 }
interface ControlCost {
  count: number
  wallMs: number
  heapBytes: number
}
const controlCosts = new Map<string, ControlCost>()

export function countFrame(bytes: number): void {
  if (ENABLED) {
    ctr.frames++
    ctr.frameBytes += bytes
  }
}

/** [spec:SP-c29e] Attribute one complete synchronous control-frame turn (decode + dispatch).
 * Returns a finisher because the message type is only known after decoding.
 * Positive heap deltas are a deliberately cheap allocation-pressure proxy; a
 * GC during the turn contributes zero rather than hiding allocations elsewhere. */
export function beginControlTurn(): (type: string) => void {
  if (!ENABLED) return () => {}
  ctr.control++
  const startedAt = performance.now()
  const heapBefore = process.memoryUsage().heapUsed
  return (type) => {
    const cost = controlCosts.get(type) ?? { count: 0, wallMs: 0, heapBytes: 0 }
    cost.count++
    cost.wallMs += performance.now() - startedAt
    cost.heapBytes += Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    controlCosts.set(type, cost)
  }
}
export function countTail(): void {
  if (ENABLED) ctr.tails++
}
export function countWorker(): void {
  if (ENABLED) ctr.worker++
}

/** Time a labeled synchronous task; log if it blocks the loop > thresholdMs. */
export function timeTask<T>(label: string, fn: () => T, thresholdMs = 50): T {
  if (!ENABLED) return fn()
  const t = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t
    if (ms > thresholdMs) console.warn(`[podium:loop] daemon task ${label} ${ms.toFixed(0)}ms`)
  }
}

/** Hand this to `startLoopMetrics({ onLongTick })`. Reports the current window's
 *  activity mix + heap; the per-second reset keeps the mix scoped to the stall.
 *  The starved-vs-busy classification (POD-600) rides along when the probe
 *  could compute one (Linux schedstat available). */
export function reportLongTick(ms: number, classification?: StallClassification): void {
  if (!ENABLED) return
  const mu = process.memoryUsage()
  const mb = (b: number) => (b / 1048576).toFixed(0)
  const cls = classification ? ` | ${formatStallClassification(classification)}` : ''
  const controlDetail = formatControlCosts(controlCosts)
  const controlSummary = controlDetail ? ' types=' + controlDetail : ''
  console.warn(
    `[podium:loop] daemon stall ${ms.toFixed(0)}ms | frames=${ctr.frames} bytes=${(ctr.frameBytes / 1024).toFixed(0)}KB control=${ctr.control}${controlSummary} tails=${ctr.tails} worker=${ctr.worker} | heap=${mb(mu.heapUsed)}MB rss=${mb(mu.rss)}MB${cls}`,
  )
}

export function formatControlCosts(costs: ReadonlyMap<string, ControlCost>): string {
  return [...costs]
    .sort((a, b) => b[1].wallMs - a[1].wallMs || a[0].localeCompare(b[0]))
    .map(
      ([type, cost]) =>
        type +
        ':' +
        cost.count +
        '/' +
        cost.wallMs.toFixed(0) +
        'ms/+' +
        (cost.heapBytes / 1048576).toFixed(1) +
        'MB',
    )
    .join(',')
}

let resetTimer: ReturnType<typeof setInterval> | undefined
/** Start the per-second counter reset so each long-tick report reflects ~1s of
 *  activity around the stall rather than all activity since boot. */
export function startLoopAttribution(): void {
  if (!ENABLED || resetTimer) return
  resetTimer = setInterval(() => {
    ctr.frames = 0
    ctr.frameBytes = 0
    ctr.control = 0
    ctr.tails = 0
    ctr.worker = 0
    controlCosts.clear()
  }, 1000)
  resetTimer.unref?.()
}
