import {
  type LoopAccountingHandle,
  type LoopComponent,
  startLoopAccounting,
} from './loop-accounting'
import type { StallClassification } from './loop-stall'

// Re-exported so callers wiring an onLongTick reporter (daemon loop-attribution,
// server) can name the classification without a second subpath import.
export {
  classifyStall,
  createStallClassifier,
  parseSchedstat,
  type StallClassification,
  type StallClassifier,
} from './loop-stall'

export interface LoopMetricsHandle {
  stop(): void
  /** Loop-delay percentiles over the probe's recent fires, ms. */
  snapshot(): { p50: number; p99: number; max: number }
}

/**
 * A bare stall probe for a caller that wants ONE measurement and no accounting:
 * a bench, a load test, a harness that starts and stops it around a window.
 *
 * It is a thin wrapper over `startLoopAccounting` (loop profile levels design
 * §4.1) and owns nothing of its own. Two probe timers measuring one loop would
 * each show up in the other's lateness, so there is exactly one implementation
 * of the probe and this is a view onto it: no sink, no minute file, no rings a
 * caller here would read.
 *
 * It runs at `accounting` WHATEVER this process's profile level is, because
 * constructing it is the request — a load test that measured nothing on a
 * customer-shaped install would fail in a way that reads as a passing loop.
 *
 * The `monitorEventLoopDelay` histogram this used to keep alongside the probe
 * is gone. It was blind under Bun (it missed a measured 300 ms synchronous
 * block), and its `h.max` is a LIFETIME maximum that is never reset, which is
 * what made one stall re-report itself every window forever (POD-1932). The
 * probe's own lateness answers the same question and cannot go stale.
 */
export function startLoopMetrics(opts: {
  longTickMs?: number
  sampleMs?: number
  now?: () => number
  component?: LoopComponent
  /** Called once per detected long tick, with the stall duration (ms) and, where
   *  available, the starved-vs-busy classification (POD-600).
   *
   *  This is the ONLY report of a stall: the probe detects, the caller records.
   *  Required, because a probe whose detections go nowhere is invisible — and
   *  because this module previously ALSO logged a prose line of its own, which
   *  meant every stall was recorded twice, once unqueryably (POD-1932). The
   *  caller owns the record so the fields it can name (heap, activity mix, SQL)
   *  land on the SAME record as the duration. */
  onLongTick: (ms: number, classification?: StallClassification) => void
}): LoopMetricsHandle {
  const handle: LoopAccountingHandle = startLoopAccounting({
    component: opts.component ?? 'server',
    level: 'accounting',
    ...(opts.longTickMs === undefined ? {} : { longTickMs: opts.longTickMs }),
    ...(opts.sampleMs === undefined ? {} : { sampleMs: opts.sampleMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    onLongTick: (stall) => opts.onLongTick(stall.durationMs, stall.classification),
  })
  return {
    stop: () => handle.stop(),
    snapshot: () => handle.delaySnapshot(),
  }
}
