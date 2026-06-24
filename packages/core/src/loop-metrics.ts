import { monitorEventLoopDelay } from 'node:perf_hooks'

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
}): LoopMetricsHandle {
  const longTickMs = opts.longTickMs ?? 100
  const sampleMs = opts.sampleMs ?? 1000
  const log = opts.log ?? ((m: string) => console.warn(m))
  const now = opts.now ?? (() => Date.now())

  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()

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
        log(`[podium:loop] ${opts.label} long tick ${late.toFixed(0)}ms`)
        loggedThisWindow = true
      }
    }
  }, probeMs)
  probe.unref?.()

  // Sample timer: every sampleMs, also fold the histogram's view in (it can
  // catch stalls between probe fires) and reset the per-window throttle.
  const sample = setInterval(() => {
    const histMaxMs = h.max / 1e6
    if (histMaxMs > lifetimeMaxMs) lifetimeMaxMs = histMaxMs
    if (!loggedThisWindow && windowMaxMs <= longTickMs && histMaxMs > longTickMs) {
      log(`[podium:loop] ${opts.label} long tick ${histMaxMs.toFixed(0)}ms`)
      loggedThisWindow = true
    }
    windowMaxMs = 0
    loggedThisWindow = false
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
