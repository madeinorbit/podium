import type { EventsRepository } from '../../store/events'

// podium_events retention (issue #61): pruned on a sparse timer — first run
// shortly after boot, then every 6h. Hardcoded (no settings knob yet); revisit
// as a setting when the steward goes always-on.
const EVENT_RETENTION_MAX_AGE_DAYS = 14
const EVENT_RETENTION_MAX_ROWS = 50_000
const EVENT_PRUNE_BOOT_DELAY_MS = 60_000
const EVENT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Event-log retention (issue #61), owned by the events aggregate: a one-shot
 * boot delay (off the boot hot path) that hands off to the 6h interval. Both
 * timers are unref'd so they never hold the process open; a broken prune is
 * logged, never thrown.
 */
export class EventLogRetention {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly events: Pick<EventsRepository, 'pruneEvents'>) {}

  start(): void {
    this.bootTimer = setTimeout(() => {
      this.prune()
      this.timer = setInterval(() => this.prune(), EVENT_PRUNE_INTERVAL_MS)
      this.timer.unref?.()
    }, EVENT_PRUNE_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /** One retention pass over podium_events. Failures are logged, never thrown —
   *  a broken prune must not take down the timer or the process. */
  private prune(): void {
    try {
      const deleted = this.events.pruneEvents({
        maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
        maxRows: EVENT_RETENTION_MAX_ROWS,
      })
      if (deleted > 0) console.log(`[podium:events] pruned ${deleted} event log rows`)
    } catch (err) {
      console.warn('[podium:events] event log prune failed:', err)
    }
  }
}
