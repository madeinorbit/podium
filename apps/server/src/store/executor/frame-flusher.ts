/**
 * Publication flush, driven by the scheduler going idle [POD-3248, spec §3.3].
 *
 * THE PROBLEM IT SOLVES. Publication is flushed on the microtask boundary today
 * (`funnel.ts`, `feed-serving.ts`), which is correct while a burst of commits
 * happens in ONE synchronous turn: the whole burst lands in one frame per
 * connection. With every commit awaited, each one gets its own microtask
 * boundary, so a burst of N commits becomes N frames per connection — the boot
 * reconcile and a bind storm are exactly the bursts that would show it.
 *
 * So the flush signal moves from "the microtask queue drained" to "the
 * scheduler has nothing in flight and nothing queued", bounded by a maximum
 * batch and a maximum delay so a scheduler that never goes idle still
 * publishes. Frames per burst is a scheduler test, not a hope.
 */

import type { Scheduler } from './scheduler'

export interface FrameFlusherOptions<T> {
  scheduler: Scheduler
  /** One frame. Called once per flush, with everything buffered since the last. */
  flush: (batch: readonly T[]) => void
  /** Flush early once this many items are buffered. 0 disables the bound. */
  maxBatch?: number
  /** Flush after this long even if the scheduler never goes idle. */
  maxDelayMs?: number
  /**
   * The MAX-DELAY TIMER's flush failed.
   *
   * That path has no caller to reject: it is raised from `setTimeout`, where an
   * escaping error is an uncaught exception that takes the process down. So it
   * is isolated and reported here; absent, the failure is dropped.
   *
   * The IDLE path is not this sink's business, and deliberately so. It is
   * raised from inside the release of the operation that just committed, so
   * isolating it is the SCHEDULER's job (`SchedulerOptions.onIdleFailure`) —
   * a listener that threw must not take out the listeners after it or the
   * scheduler's own close, whether or not it happens to be a flusher. Layering
   * a second catch here would only make that one untestable.
   *
   * THE BATCH IS LOST when a flush throws: the buffer is emptied before the
   * frame is emitted, and re-buffering it would retry a poisoned batch forever.
   * A direct {@link FrameFlusher.flushNow} still throws to its own caller,
   * which is the one path that has somewhere to report to.
   */
  onFlushFailure?: (error: unknown) => void
}

export interface FrameFlusher<T> {
  publish(item: T): void
  /** Frames emitted so far. The "frames per burst" measurement reads this. */
  readonly frames: number
  /** Flush now, if anything is buffered. */
  flushNow(): void
  stop(): void
}

export function createFrameFlusher<T>(options: FrameFlusherOptions<T>): FrameFlusher<T> {
  const maxBatch = options.maxBatch ?? 0
  const buffer: T[] = []
  let frames = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function flushNow(): void {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (buffer.length === 0) return
    const batch = buffer.splice(0)
    frames++
    options.flush(batch)
  }

  /** The TIMER's form: see {@link FrameFlusherOptions.onFlushFailure}. */
  function flushOnTimer(): void {
    try {
      flushNow()
    } catch (error) {
      try {
        options.onFlushFailure?.(error)
      } catch {
        /* the flush-failure sink threw; there is nowhere further to report it */
      }
    }
  }

  const unsubscribe = options.scheduler.onIdle(flushNow)

  return {
    publish(item) {
      buffer.push(item)
      if (maxBatch > 0 && buffer.length >= maxBatch) {
        flushNow()
        return
      }
      if (options.maxDelayMs !== undefined && timer === undefined) {
        timer = setTimeout(flushOnTimer, options.maxDelayMs)
        // `unref` so a buffered frame can never hold a process open.
        timer.unref?.()
      }
    },
    get frames() {
      return frames
    },
    flushNow,
    stop() {
      unsubscribe()
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
