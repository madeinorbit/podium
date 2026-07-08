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
const ENABLED = !!process.env.PODIUM_LOOP_PROFILE
export const loopProfileEnabled = ENABLED

const ctr = { frames: 0, frameBytes: 0, control: 0, tails: 0, worker: 0 }

export function countFrame(bytes: number): void {
  if (ENABLED) {
    ctr.frames++
    ctr.frameBytes += bytes
  }
}
export function countControl(): void {
  if (ENABLED) ctr.control++
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
 *  activity mix + heap; the per-second reset keeps the mix scoped to the stall. */
export function reportLongTick(ms: number): void {
  if (!ENABLED) return
  const mu = process.memoryUsage()
  const mb = (b: number) => (b / 1048576).toFixed(0)
  console.warn(
    `[podium:loop] daemon stall ${ms.toFixed(0)}ms | frames=${ctr.frames} bytes=${(ctr.frameBytes / 1024).toFixed(0)}KB control=${ctr.control} tails=${ctr.tails} worker=${ctr.worker} | heap=${mb(mu.heapUsed)}MB rss=${mb(mu.rss)}MB`,
  )
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
  }, 1000)
  resetTimer.unref?.()
}
