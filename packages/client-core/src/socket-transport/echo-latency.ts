/**
 * User-input→visible-echo latency instrumentation [POD-1784].
 *
 * A sample starts at the browser input event (or, for synthetic/mobile input,
 * immediately before the WebSocket send). The first subsequent PTY output
 * frame supplies the transport/agent boundary; the sample closes only after
 * xterm has rendered that frame and the browser has crossed a paint boundary.
 * That makes the top-level percentile the delay a person feels, while the two
 * nested summaries say whether it was before or after the frame reached the
 * browser.
 *
 * While an agent is actively streaming, the first subsequent frame may be
 * unrelated to the key and the pre-frame leg can undershoot. Measure at an idle
 * prompt (the bundled live probe creates a shell for exactly that reason).
 *
 * The tracker is disabled by default. Its disabled hot path is one boolean
 * check and disabling it clears all retained timings.
 */

export interface EchoLatencySummary {
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  lastMs: number | null
}

export interface EchoLatencySample {
  /** Input event until a corresponding output frame reached the browser. */
  toFrameMs: number
  /** Output-frame arrival until xterm/browser paint confirmation. */
  frameToPaintMs: number
  /** Full input-event to confirmed-paint latency. */
  totalMs: number
}

export interface EchoLatencyStats extends EchoLatencySummary {
  enabled: boolean
  toFrame: EchoLatencySummary
  frameToPaint: EchoLatencySummary
  last: EchoLatencySample | null
}

interface PendingInput {
  inputAt: number
  frameAt?: number
}

interface TimedSample extends EchoLatencySample {
  at: number
}

/** An input this old with still no painted echo was swallowed or unrelated. */
const PENDING_TIMEOUT_MS = 2_000
/** Bound the unpainted input queue (wedged agent + a held-down key). */
const PENDING_CAP = 64
/** Sliding window the stats are computed over. */
const WINDOW_MS = 30_000
/** Hard cap so a burst cannot grow the buffer between stats() calls. */
const SAMPLE_CAP = 512

const EMPTY_SUMMARY: EchoLatencySummary = {
  count: 0,
  p50: null,
  p90: null,
  max: null,
  lastMs: null,
}

function summarize(values: readonly number[], lastMs: number | null): EchoLatencySummary {
  if (values.length === 0) return EMPTY_SUMMARY
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (q: number): number | null =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null
  return {
    count: sorted.length,
    p50: rank(0.5),
    p90: rank(0.9),
    max: rank(1),
    lastMs,
  }
}

export class EchoLatencyTracker {
  private active = false
  /** Inputs waiting for their first subsequent output frame and paint. */
  private pending: PendingInput[] = []
  /** Closed samples, oldest first. */
  private samples: TimedSample[] = []
  private outputAwaitingPaint = false

  setEnabled(enabled: boolean): void {
    if (enabled === this.active) return
    this.active = enabled
    this.pending = []
    this.samples = []
    this.outputAwaitingPaint = false
  }

  enabled(): boolean {
    return this.active
  }

  onInput(now: number): void {
    if (!this.active || this.pending.length >= PENDING_CAP) return
    this.pending.push({ inputAt: now })
  }

  /** Mark the first output frame after each waiting input without closing it. */
  onOutput(now: number): void {
    if (!this.active || this.pending.length === 0) return
    this.pending = this.pending.filter((pending) => now - pending.inputAt <= PENDING_TIMEOUT_MS)
    for (const pending of this.pending) {
      if (pending.frameAt === undefined) pending.frameAt = now
    }
    this.outputAwaitingPaint = this.pending.some((pending) => pending.frameAt !== undefined)
  }

  /** True when xterm's next render can close at least one sample. */
  awaitingPaint(): boolean {
    return this.active && this.outputAwaitingPaint
  }

  /** Close inputs whose output has rendered and crossed a browser paint boundary. */
  onPaint(now: number): void {
    if (!this.active || !this.outputAwaitingPaint) return
    const stillPending: PendingInput[] = []
    for (const pending of this.pending) {
      if (now - pending.inputAt > PENDING_TIMEOUT_MS) continue
      if (pending.frameAt === undefined) {
        stillPending.push(pending)
        continue
      }
      const toFrameMs = pending.frameAt - pending.inputAt
      const frameToPaintMs = now - pending.frameAt
      this.samples.push({
        at: now,
        toFrameMs,
        frameToPaintMs,
        totalMs: toFrameMs + frameToPaintMs,
      })
    }
    this.pending = stillPending
    this.outputAwaitingPaint = false
    if (this.samples.length > SAMPLE_CAP) {
      this.samples.splice(0, this.samples.length - SAMPLE_CAP)
    }
  }

  stats(now: number): EchoLatencyStats {
    if (!this.active) {
      return {
        enabled: false,
        ...EMPTY_SUMMARY,
        toFrame: EMPTY_SUMMARY,
        frameToPaint: EMPTY_SUMMARY,
        last: null,
      }
    }
    const cutoff = now - WINDOW_MS
    while ((this.samples[0]?.at ?? Infinity) < cutoff) this.samples.shift()
    const last = this.samples.at(-1) ?? null
    const total = summarize(
      this.samples.map((sample) => sample.totalMs),
      last?.totalMs ?? null,
    )
    return {
      enabled: true,
      ...total,
      toFrame: summarize(
        this.samples.map((sample) => sample.toFrameMs),
        last?.toFrameMs ?? null,
      ),
      frameToPaint: summarize(
        this.samples.map((sample) => sample.frameToPaintMs),
        last?.frameToPaintMs ?? null,
      ),
      last: last
        ? {
            toFrameMs: last.toFrameMs,
            frameToPaintMs: last.frameToPaintMs,
            totalMs: last.totalMs,
          }
        : null,
    }
  }
}
