import { createLogger } from '@podium/logger'
import { type SystemCommandPrincipal, systemPrincipal } from '../../command-principal'
import type { IssueService } from './service'

const log = createLogger('server:issues')

// Read-gated auto-archive sweep (issue #127): first pass shortly after boot (so a
// restart promptly clears issues that crossed the 7-day read window while down),
// then hourly. Hourly is ample for a seven-day-granularity rule and the sweep is cheap.
export const AUTO_ARCHIVE_BOOT_DELAY_MS = 90_000
export const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000

/**
 * The read-gated auto-archive timer (issue #127), owned by the issues module:
 * a boot-delay one-shot that hands off to the hourly interval — the same shape
 * as the event-log retention pair. Both timers unref'd; a broken sweep is
 * logged, never thrown.
 */
export class IssueAutoArchive {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  /** True while a pass is running — see {@link IssueAutoArchive.sweep}. */
  private sweeping = false

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
    // SINGLE-FLIGHT (POD-3258), the same fence its sibling {@link IssueGitWatch}
    // already carries. `sweepAutoArchive` selects the read+done issues and
    // archives them in one pass; an overlapping pass would select the same rows
    // before the first had archived them and re-archive each one, doubling the
    // ledger entries a person sees. Skipped, not queued: the selection is a
    // standing query over durable state, so the next hourly tick sees whatever
    // this one did not.
    if (this.sweeping) return
    this.sweeping = true
    try {
      const archived = this.issues.sweepAutoArchive(undefined, systemPrincipal('expiry'))
      if (archived.length > 0) {
        log.info('auto-archived read+done issues', { archived: archived.length })
      }
    } catch (err) {
      log.warn('auto-archive sweep failed', { err })
    } finally {
      this.sweeping = false
    }
  }
}
