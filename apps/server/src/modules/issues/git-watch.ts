import type { IssueService } from './service'

// POD-384: a first pass shortly after boot (so a restart re-learns every parent
// tip before the first merge lands against it), then every 30s — the janitor's
// own cadence, and quick enough that a merged branch settles into the sidebar's
// closed fold while the operator is still looking at the row.
const GIT_WATCH_BOOT_DELAY_MS = 20_000
const GIT_WATCH_INTERVAL_MS = 30_000

/**
 * The parent-branch movement watch [POD-384], owned by the issues module: a
 * boot-delay one-shot handing off to an interval, the same shape as
 * {@link IssueAutoArchive}. Both timers unref'd; a broken sweep is logged, never
 * thrown.
 *
 * Deliberately a LOCAL timer, unlike the auto-archive it is shaped after — that
 * one moved to the fenced janitor at POD-925 and this one does not. The fence
 * exists to keep exactly ONE writer against DURABLE state across server
 * generations. This sweep writes no durable state at all: it re-probes git and
 * updates the per-process, ephemeral `gitStates` map (see `IssueStore`). Two
 * generations running it concurrently would each read git and each cache the
 * same answer — there is no mutation to double-apply, so there is nothing to
 * fence, and routing it through the janitor's protocol would buy only ceremony.
 */
export class IssueGitWatch {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false

  constructor(private readonly issues: Pick<IssueService, 'sweepParentBranchMovement'>) {}

  start(): void {
    this.bootTimer = setTimeout(() => {
      void this.sweep()
      this.timer = setInterval(() => void this.sweep(), GIT_WATCH_INTERVAL_MS)
      this.timer.unref?.()
    }, GIT_WATCH_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /** One movement pass. An in-flight sweep suppresses the next tick: the git
   *  calls cross a daemon socket, and an offline machine must leave a queue of
   *  overlapping sweeps behind it, not a backlog. Failures are logged. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.issues.sweepParentBranchMovement()
    } catch (err) {
      console.warn('[podium:issues] parent-branch watch failed:', err)
    } finally {
      this.sweeping = false
    }
  }
}
