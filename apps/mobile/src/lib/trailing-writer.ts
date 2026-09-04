/**
 * A TRAILING WRITE COALESCER for best-effort persistence on hot paths.
 *
 * Born for the transcript warm-cache (POD perf round): SessionConversation used
 * to call `putTranscriptWindow` — a synchronous SQLite commit on the JS thread
 * on native — on EVERY streaming delta, several times per second, on the exact
 * screen where the operator is scrolling and typing. The cache is only ever
 * read on mount, so per-delta durability buys nothing; what matters is that a
 * write eventually lands, and that closing the screen or backgrounding the app
 * does not lose the tail.
 *
 * Semantics are trailing THROTTLE, not debounce: the first `schedule` arms one
 * timer, later schedules only replace the pending value, and the timer fires
 * with whatever is newest. A pure debounce that re-arms per call would starve
 * forever under a steady stream — exactly the workload this exists for — so
 * staleness is bounded by `delayMs` instead. `flush` writes the pending value
 * immediately (unmount, session switch, app background); `cancel` drops it.
 */
export interface TrailingWriter<T> {
  /** Record `value` as the newest thing to persist; writes at most once per
   *  `delayMs`, with the latest value at fire time. */
  schedule(value: T): void
  /** Write any pending value NOW and disarm. No-op when nothing is pending. */
  flush(): void
  /** Drop any pending value without writing. */
  cancel(): void
}

export function createTrailingWriter<T>(
  write: (value: T) => void,
  delayMs: number,
): TrailingWriter<T> {
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = () => {
    timer = null
    if (pending === null) return
    const { value } = pending
    pending = null
    write(value)
  }

  return {
    schedule(value: T) {
      pending = { value }
      // Already armed: the running timer picks up this newer value when it
      // fires. Re-arming here would push the write out indefinitely under a
      // steady stream.
      timer ??= setTimeout(fire, delayMs)
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (pending === null) return
      const { value } = pending
      pending = null
      write(value)
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
    },
  }
}
