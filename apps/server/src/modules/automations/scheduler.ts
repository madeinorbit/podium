import type { AutomationsService } from './service'

// Cron has minute granularity, so a 30s tick bounds lateness at ~30s. The boot
// one-shot (like the retention/auto-archive pair) runs a first pass shortly after
// startup, so a restart promptly picks up an occurrence that came due while the
// server was down — within the grace window, at most one late fire [spec:SP-17db].
const AUTOMATIONS_BOOT_DELAY_MS = 20_000
const AUTOMATIONS_INTERVAL_MS = 30_000

/**
 * The automations tick (#470) [spec:SP-17db], owned by the automations module:
 * a boot-delay one-shot that hands off to the 30s interval — the same shape as
 * IssueAutoArchive and EventLogRetention.
 *
 * Deliberately NOT gated behind `settings.steward.enabled`: cron is a separate
 * concern from event dispatch, and the scheduler is inert until an enabled
 * automation exists, so it is safe to ship on. Both timers unref'd; a broken pass
 * is logged, never thrown.
 */
export class AutomationScheduler {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly automations: Pick<AutomationsService, 'tick'>) {}

  start(): void {
    this.bootTimer = setTimeout(() => {
      this.tick()
      this.timer = setInterval(() => this.tick(), AUTOMATIONS_INTERVAL_MS)
      this.timer.unref?.()
    }, AUTOMATIONS_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /** One scheduler pass. Failures are logged, never thrown — a broken tick must not
   *  take down the timer or the process. */
  private tick(): void {
    try {
      this.automations.tick()
    } catch (err) {
      console.warn('[podium:automations] scheduler tick failed:', err)
    }
  }
}
