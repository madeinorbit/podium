import { runTimeBudgetedJob, type TimeBudgetedJobMetrics } from '@podium/runtime/time-budget'
import type { EventsRepository } from '../../store/events'

// podium_events retention (issue #61): pruned on a sparse timer — first run
// shortly after boot, then every 6h. Hardcoded (no settings knob yet); revisit
// as a setting when the steward goes always-on.
const EVENT_RETENTION_MAX_AGE_DAYS = 14
const EVENT_RETENTION_MAX_ROWS = 50_000
const EVENT_PRUNE_BOOT_DELAY_MS = 60_000
const EVENT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
const EVENT_PRUNE_BATCH_ROWS = 500

export interface EventLogRetentionOptions {
  batchSize?: number
  /** Monotonic clock seam for deterministic slice tests. */
  now?: () => number
  onMetrics?: (metrics: TimeBudgetedJobMetrics) => void
}

/**
 * Event-log retention (issue #61), owned by the events aggregate: a one-shot
 * boot delay (off the boot hot path) that hands off to the 6h interval. Both
 * timers are unref'd so they never hold the process open; a broken prune is
 * logged, never thrown.
 */
export class EventLogRetention {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly shutdown = new AbortController()

  constructor(
    private readonly events: Pick<EventsRepository, 'planEventPrune' | 'pruneEventBatch'>,
    private readonly options: EventLogRetentionOptions = {},
  ) {}

  start(): void {
    this.bootTimer = setTimeout(() => {
      this.schedulePrune()
      this.timer = setInterval(() => this.schedulePrune(), EVENT_PRUNE_INTERVAL_MS)
      this.timer.unref?.()
    }, EVENT_PRUNE_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    this.shutdown.abort()
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * One complete retention job over podium_events [spec:SP-c29e]. Each DELETE
   * is bounded before it reaches this loop; the shared helper yields by
   * macrotask between units when the 12ms slice budget is spent.
   */
  async pruneNow(): Promise<{ deleted: number; metrics: TimeBudgetedJobMetrics }> {
    const batchSize = this.options.batchSize ?? EVENT_PRUNE_BATCH_ROWS
    let deleted = 0
    let plan: ReturnType<EventsRepository['planEventPrune']> | undefined
    const metrics = await runTimeBudgetedJob(
      () => {
        if (!plan) {
          plan = this.events.planEventPrune({
            maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
            maxRows: EVENT_RETENTION_MAX_ROWS,
          })
          return 'continue'
        }
        const batchDeleted = this.events.pruneEventBatch(plan, batchSize)
        deleted += batchDeleted
        return batchDeleted < batchSize ? 'done' : 'continue'
      },
      {
        signal: this.shutdown.signal,
        now: this.options.now,
        onMetrics: this.options.onMetrics,
      },
    )
    if (deleted > 0) {
      console.log(
        `[podium:events] pruned ${deleted} event log rows ` +
          `(total=${metrics.totalDurationMs.toFixed(1)}ms, ` +
          `maxSlice=${metrics.maxUninterruptedSliceMs.toFixed(1)}ms)`,
      )
    }
    if (metrics.exceededPlacementThreshold) {
      console.warn(
        `[podium:events] retention job took ${metrics.totalDurationMs.toFixed(1)}ms; ` +
          'candidate for janitor placement',
      )
    }
    return { deleted, metrics }
  }

  /** Timer failures are logged, never thrown into the process. */
  private schedulePrune(): void {
    void this.pruneNow().catch((err) => {
      console.warn('[podium:events] event log prune failed:', err)
    })
  }
}
