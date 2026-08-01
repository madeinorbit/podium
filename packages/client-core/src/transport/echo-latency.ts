/**
 * Keystroke→echo latency instrumentation (#11).
 *
 * Measures the time from an input send to the FIRST output frame that arrives
 * after it. For a focused session idling at a prompt this is exactly the echo
 * round-trip the user feels while typing: network out + relay/daemon dwell +
 * the agent's own repaint + network back + nothing else. While the agent is
 * actively streaming output the metric degrades to "time to the next frame"
 * and undershoots — read it while typing into an idle composer.
 *
 * Pure and clock-free: callers pass `now` (ms), which keeps it trivially
 * testable and independent of Date vs performance clocks.
 */

export interface EchoLatencyStats {
  /** Samples inside the sliding window. */
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  /** Most recent sample. */
  lastMs: number | null
}

/** An input this old with still no output produced no echo (a modifier, a key
 *  the app swallowed) — discard it rather than pollute the distribution with
 *  a giant outlier when output eventually resumes. */
const PENDING_TIMEOUT_MS = 2_000
/** Bound the un-echoed input queue (wedged agent + a held-down key). */
const PENDING_CAP = 64
/** Sliding window the stats are computed over. */
const WINDOW_MS = 30_000
/** Hard cap so a output-frame flood can't grow the buffer between stats() calls. */
const SAMPLE_CAP = 512

export class EchoLatencyTracker {
  /** Send times of inputs still awaiting their first subsequent output frame. */
  private pending: number[] = []
  /** Closed samples, oldest first. */
  private samples: { at: number; ms: number }[] = []

  onInput(now: number): void {
    if (this.pending.length >= PENDING_CAP) return
    this.pending.push(now)
  }

  onOutput(now: number): void {
    if (this.pending.length === 0) return
    for (const sentAt of this.pending) {
      const ms = now - sentAt
      if (ms > PENDING_TIMEOUT_MS) continue
      this.samples.push({ at: now, ms })
    }
    this.pending = []
    if (this.samples.length > SAMPLE_CAP) {
      this.samples.splice(0, this.samples.length - SAMPLE_CAP)
    }
  }

  stats(now: number): EchoLatencyStats {
    const cutoff = now - WINDOW_MS
    while ((this.samples[0]?.at ?? Infinity) < cutoff) this.samples.shift()
    const last = this.samples[this.samples.length - 1]
    if (last === undefined) {
      return { count: 0, p50: null, p90: null, max: null, lastMs: null }
    }
    const sorted = this.samples.map((s) => s.ms).sort((a, b) => a - b)
    // Nearest-rank percentile: the smallest value with at least q of the mass below it.
    const rank = (q: number): number | null =>
      sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null
    return {
      count: sorted.length,
      p50: rank(0.5),
      p90: rank(0.9),
      max: rank(1),
      lastMs: last.ms,
    }
  }
}
