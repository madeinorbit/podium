import { readFileSync } from 'node:fs'

/**
 * Classify a long event-loop tick as scheduler starvation vs the loop's own
 * work (POD-600). The loop-metrics probe can say a tick was late, but not WHY:
 * on a contended host the main thread can spend most of a "stall" waiting on
 * the kernel runqueue (measured on this host: ~60% of wall time), which looks
 * identical in the log to a synchronous block or a GC pause.
 *
 * Two cheap counters disambiguate:
 *  - `process.cpuUsage()` — CPU the process actually burned (user+system).
 *    Process-wide (worker threads included), so it's a coarse upper bound on
 *    the loop's own work.
 *  - the MAIN thread's runqueue wait from `/proc/self/task/<tid>/schedstat`
 *    (2nd field, ns; the main thread's tid equals the pid) — time spent
 *    runnable but not running, i.e. pure scheduler starvation.
 *
 * A baseline of both is refreshed once per sample window; on a long tick the
 * deltas since the baseline are compared against the stall's wall time for a
 * coarse verdict: `starved` (runqueue wait dominates), `busy` (own CPU
 * dominates — sync work or GC), `mixed`. Linux-only: on hosts without
 * schedstat the classifier is simply absent (feature-detected at creation).
 */

export interface StallClassification {
  /** CPU (user+system) the process burned since the baseline, ms. */
  ownCpuMs: number
  /** Main-thread runqueue wait accrued since the baseline, ms. */
  runqueueWaitMs: number
  verdict: 'starved' | 'busy' | 'mixed'
}

/** Parse the cumulative runqueue wait (2nd field, ns) from a schedstat line
 *  (`<running_ns> <waiting_ns> <timeslices>`). Undefined on malformed input. */
export function parseSchedstat(text: string): number | undefined {
  const fields = text.trim().split(/\s+/)
  if (fields.length < 2) return undefined
  const ns = Number(fields[1])
  return Number.isFinite(ns) && ns >= 0 ? ns : undefined
}

/**
 * Pure delta → verdict math. Fractions are of the stall's wall time; a side
 * wins outright when it covers at least half the stall AND doubles the other
 * side, otherwise the verdict is `mixed`. Both deltas span the whole baseline
 * window (up to ~1s), not just the stall, so fractions can exceed 1 — the
 * verdict is deliberately coarse.
 */
export function classifyStall(input: {
  stallMs: number
  /** process.cpuUsage() delta since baseline, user+system µs. */
  cpuDeltaUs: number
  /** Main-thread schedstat runqueue-wait delta since baseline, ns. */
  waitDeltaNs: number
}): StallClassification {
  const ownCpuMs = input.cpuDeltaUs / 1000
  const runqueueWaitMs = input.waitDeltaNs / 1e6
  const denom = Math.max(input.stallMs, 1)
  const cpuFrac = ownCpuMs / denom
  const waitFrac = runqueueWaitMs / denom
  let verdict: StallClassification['verdict'] = 'mixed'
  if (waitFrac >= 0.5 && waitFrac >= 2 * cpuFrac) verdict = 'starved'
  else if (cpuFrac >= 0.5 && cpuFrac >= 2 * waitFrac) verdict = 'busy'
  return { ownCpuMs, runqueueWaitMs, verdict }
}

/** Render the classification the way the loop log lines expect. */
export function formatStallClassification(c: StallClassification): string {
  return `own-cpu=${c.ownCpuMs.toFixed(0)}ms runqueue-wait=${c.runqueueWaitMs.toFixed(0)}ms verdict=${c.verdict}`
}

export interface StallClassifier {
  /** Re-anchor the deltas; call once per sample window. */
  refreshBaseline(): void
  /** Deltas since the baseline + verdict; undefined if schedstat vanished. */
  classify(stallMs: number): StallClassification | undefined
}

/**
 * Stateful sampler over the two counters. Returns undefined where schedstat
 * isn't readable (non-Linux, restricted /proc) — callers just skip the
 * classification. Reads are readFileSync of a few bytes (~µs), cheap enough
 * for a once-per-second baseline plus one read per logged stall.
 */
export function createStallClassifier(deps?: {
  readSchedstat?: () => string
  cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
}): StallClassifier | undefined {
  const cpuUsage = deps?.cpuUsage ?? process.cpuUsage.bind(process)
  const read =
    deps?.readSchedstat ??
    // Main thread only: its tid equals the pid. /proc/self/schedstat would
    // also work but is process-rollup on some kernels; the task path is the
    // per-thread truth.
    ((): string => readFileSync(`/proc/self/task/${process.pid}/schedstat`, 'utf8'))

  // Feature-detect with one probing read; absent classifier on any failure.
  let probedWaitNs: number | undefined
  try {
    probedWaitNs = parseSchedstat(read())
  } catch {
    return undefined
  }
  if (probedWaitNs === undefined) return undefined

  let baseCpu = cpuUsage()
  let baseWaitNs = probedWaitNs
  return {
    refreshBaseline() {
      try {
        const waitNs = parseSchedstat(read())
        if (waitNs === undefined) return
        baseWaitNs = waitNs
        baseCpu = cpuUsage()
      } catch {
        // Transient /proc hiccup — keep the previous baseline.
      }
    },
    classify(stallMs) {
      let waitNs: number | undefined
      try {
        waitNs = parseSchedstat(read())
      } catch {
        return undefined
      }
      if (waitNs === undefined) return undefined
      const cpu = cpuUsage(baseCpu)
      return classifyStall({
        stallMs,
        cpuDeltaUs: cpu.user + cpu.system,
        waitDeltaNs: Math.max(0, waitNs - baseWaitNs),
      })
    },
  }
}
