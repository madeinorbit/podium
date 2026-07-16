import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  createStallClassifier,
  formatStallClassification,
  type StallClassification,
} from './loop-stall'

// Re-exported so callers wiring an onLongTick reporter (daemon loop-attribution,
// server) can name the classification without a second subpath import.
export {
  classifyStall,
  createStallClassifier,
  formatStallClassification,
  parseSchedstat,
  type StallClassification,
  type StallClassifier,
} from './loop-stall'

export interface LoopMetricsHandle {
  stop(): void
  snapshot(): { p50: number; p99: number; max: number }
}

/**
 * Sample this process's event-loop delay and warn when a single tick blocks the
 * loop longer than `longTickMs`. The systemd watchdog only catches a full wedge
 * (>30s); this surfaces the sub-second stalls that ruin typing.
 *
 * Measurement uses two sources that complement each other:
 *  - `monitorEventLoopDelay` for cheap, high-resolution percentiles over the run,
 *  - a self-scheduling probe timer that measures how late each tick fires. The
 *    probe is the authoritative signal for a single synchronous block: the
 *    histogram can miss a block that lands before its first internal sample, but
 *    a delayed probe fire always reflects the full stall.
 */
export function startLoopMetrics(opts: {
  label: string
  longTickMs?: number
  sampleMs?: number
  log?: (m: string) => void
  now?: () => number
  /** Called with the stall duration (ms) each time a long tick is logged, so a
   *  caller can attribute it (e.g. dump what the loop was busy with). The
   *  classification (starved vs busy, POD-600) rides along where available. */
  onLongTick?: (ms: number, classification?: StallClassification) => void
}): LoopMetricsHandle {
  const longTickMs = opts.longTickMs ?? 100
  const sampleMs = opts.sampleMs ?? 1000
  const log = opts.log ?? ((m: string) => console.warn(m))
  const now = opts.now ?? (() => Date.now())

  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()

  // Starved-vs-busy classifier (POD-600): baseline re-anchored once per sample
  // window below; each long tick reports own-CPU vs runqueue-wait deltas.
  // Absent (undefined) off Linux — the log line just omits the classification.
  const classifier = createStallClassifier()

  // Lifetime max delay (ms) seen by the probe, and whether the current sample
  // window has already logged a long tick (throttle to once per sampleMs).
  let lifetimeMaxMs = 0
  let windowMaxMs = 0
  let loggedThisWindow = false

  // Probe timer: fires roughly every `probeMs`, and the lateness of each fire is
  // the loop-blocked time. Kept well under sampleMs so a long tick is caught
  // within a window.
  const probeMs = Math.max(5, Math.min(20, Math.floor(sampleMs / 4)))
  let expected = now() + probeMs
  const probe = setInterval(() => {
    const t = now()
    const late = t - expected
    expected = t + probeMs
    if (late > 0) {
      if (late > lifetimeMaxMs) lifetimeMaxMs = late
      if (late > windowMaxMs) windowMaxMs = late
      if (!loggedThisWindow && late > longTickMs) {
        const cls = classifier?.classify(late)
        log(
          `[podium:loop] ${opts.label} long tick ${late.toFixed(0)}ms${
            cls ? ` | ${formatStallClassification(cls)}` : ''
          }`,
        )
        loggedThisWindow = true
        opts.onLongTick?.(late, cls)
      }
    }
  }, probeMs)
  probe.unref?.()

  // Sample timer: every sampleMs, fold the histogram's lifetime max into the
  // snapshot stat and reset the per-window throttle. We deliberately do NOT log
  // off the histogram here: `monitorEventLoopDelay`'s `h.max` is never reset, so
  // it is the LIFETIME max — logging it each window re-reports the same stale
  // value forever after any one stall (the observed "581ms every second" spam).
  // The probe path above is the authoritative, per-window logger; a stall >
  // longTickMs always delays the next probe fire, so nothing escapes it.
  const sample = setInterval(() => {
    const histMaxMs = h.max / 1e6
    if (histMaxMs > lifetimeMaxMs) lifetimeMaxMs = histMaxMs
    windowMaxMs = 0
    loggedThisWindow = false
    // Re-anchor the starved-vs-busy deltas so a long tick's classification
    // reflects roughly the current window, not everything since boot. Ordering
    // note: a stall delays BOTH pending timers, and the probe (registered
    // first, shorter interval) fires first — so the stall is classified
    // against the pre-stall baseline before this refresh moves it.
    classifier?.refreshBaseline()
  }, sampleMs)
  sample.unref?.()

  return {
    stop() {
      clearInterval(probe)
      clearInterval(sample)
      h.disable()
    },
    snapshot() {
      const histMax = h.max / 1e6
      const max = Math.max(lifetimeMaxMs, histMax)
      return {
        p50: h.percentile(50) / 1e6,
        p99: h.percentile(99) / 1e6,
        max,
      }
    },
  }
}
