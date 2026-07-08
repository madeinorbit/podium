import type { IssueService } from './service'

// Read-gated auto-archive sweep (issue #127): first pass shortly after boot (so a
// restart promptly clears issues that crossed the 24h read window while down),
// then hourly. Hourly is ample for a 24h-granularity rule and the sweep is cheap.
const AUTO_ARCHIVE_BOOT_DELAY_MS = 90_000
const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000

/**
 * The read-gated auto-archive timer (issue #127), owned by the issues module:
 * a boot-delay one-shot that hands off to the hourly interval — the same shape
 * as the event-log retention pair. Both timers unref'd; a broken sweep is
 * logged, never thrown.
 */
export class IssueAutoArchive {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly issues: Pick<IssueService, 'sweepAutoArchive'>) {}

  start(): void {
    this.bootTimer = setTimeout(() => {
      this.sweep()
      this.timer = setInterval(() => this.sweep(), AUTO_ARCHIVE_INTERVAL_MS)
      this.timer.unref?.()
    }, AUTO_ARCHIVE_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /** One read-gated auto-archive pass. Failures are logged, never thrown. */
  private sweep(): void {
    try {
      const archived = this.issues.sweepAutoArchive()
      if (archived.length > 0) {
        console.log(`[podium:issues] auto-archived ${archived.length} read+done issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] auto-archive sweep failed:', err)
    }
  }
}
