/**
 * THE BACKGROUND HARNESS UPDATER (POD-7281, docs/design/harness-managed-installs.md §5.5).
 *
 * When each Podium-installed harness on this machine is checked for a newer
 * stable release:
 *
 *  - once, shortly after the daemon starts. A timer, never awaited by anything
 *    on the connection path: a slow vendor host cannot delay a reconnect;
 *  - every six hours while the daemon runs, plus 0 to 30 minutes of random
 *    delay, so a fleet does not arrive at a vendor host together;
 *  - when a person asks ("Check now", {@link HarnessUpdater.checkNow}).
 *
 * One check per harness at a time: a "Check now" that arrives while that
 * harness is being checked joins the running check instead of starting a
 * second. A check in another program (the CLI) meets this one at the ledger's
 * install lock. What a check decides and installs is `checkForUpdate`'s
 * (`@podium/harness/inventory`); this module only says when, and asks the
 * inventory to report again afterwards so the server sees the new state.
 *
 * Which harnesses are checked is read from the ledger at each check: only the
 * ones Podium manages here. A machine Podium never installed on has no ledger,
 * and the updater creates none.
 */

import {
  type CheckForUpdateOptions,
  type CheckForUpdateResult,
  checkForUpdate,
  type GoBackResult,
  goBackRelease,
  readManagedInstalls,
  type SetUpdatesPausedResult,
  setUpdatesPaused,
} from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import type { BuiltinHarnessKind } from '@podium/model'

const log = createLogger('daemon:installs')

/** The first check, this long after the daemon starts. */
export const UPDATE_CHECK_START_DELAY_MS = 2 * 60_000
/** Between scheduled checks. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** Up to this much random delay is added to each scheduled check. */
export const UPDATE_CHECK_JITTER_MS = 30 * 60_000

export interface HarnessUpdaterOptions {
  /** `<state>/harnesses`. */
  harnessesDir: string
  /** The machine command environment the vendor is asked and the installer runs in. */
  commandEnv: () => Promise<Readonly<Record<string, string>>>
  /**
   * The release folder of `kind` whose probe failed in the inventory's last
   * wave (`install.managed.currentFailed.release`), if any (§5.6).
   */
  currentFailed?: (kind: BuiltinHarnessKind) => Promise<number | undefined>
  /** Ask the inventory to look again and report. Called once after each round of checks. */
  report?: () => unknown
  startDelayMs?: number
  intervalMs?: number
  jitterMs?: number
  /** 0 ≤ n < 1. Default `Math.random`. */
  random?: () => number
  /** @internal The kinds to check instead of the ledger's. */
  managedKinds?: () => BuiltinHarnessKind[]
  /** @internal Test seam for one check. */
  check?: (
    kind: BuiltinHarnessKind,
    options: CheckForUpdateOptions,
  ) => Promise<CheckForUpdateResult>
}

export class HarnessUpdater {
  private readonly inFlight = new Map<BuiltinHarnessKind, Promise<CheckForUpdateResult>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly options: HarnessUpdaterOptions) {}

  /** Schedule the first check after the start delay, then the six-hourly ones. */
  start(): void {
    if (this.stopped || this.timer) return
    this.schedule(this.options.startDelayMs ?? UPDATE_CHECK_START_DELAY_MS)
  }

  /** Stop scheduling. A check already running finishes; nothing new starts on its own. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** The delay before the next scheduled check: six hours and up to thirty minutes. */
  nextDelayMs(): number {
    const interval = this.options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
    const jitter = this.options.jitterMs ?? UPDATE_CHECK_JITTER_MS
    return interval + Math.floor((this.options.random ?? Math.random)() * jitter)
  }

  /**
   * Check now: `kind`, or every harness Podium manages here. Joins a check of
   * the same harness that is already running. Never rejects for a vendor,
   * release or disk failure; each result says what happened.
   */
  async checkNow(kind?: BuiltinHarnessKind): Promise<CheckForUpdateResult[]> {
    const kinds = kind ? [kind] : this.managedKinds()
    const results: CheckForUpdateResult[] = []
    // One harness after another: two installs would meet at the install lock anyway.
    for (const each of kinds) results.push(await this.checkOne(each))
    if (results.some((result) => result.outcome !== 'not-managed')) this.report()
    return results
  }

  /**
   * A person goes back to the previous release (§5.6): it becomes current and
   * the newer one goes on the rejected list. `busy` while an install holds the
   * lock. Reports the inventory when the record moved.
   */
  async goBack(kind: BuiltinHarnessKind): Promise<GoBackResult> {
    const result = await goBackRelease(kind, {
      harnessesDir: this.options.harnessesDir,
      lockLabel: `go back ${kind} (daemon)`,
      note: (message) => log.warn(message, { kind }),
    })
    if (result.outcome === 'went-back') {
      log.info('harness went back', {
        kind,
        version: result.version,
        ...(result.rejected ? { rejected: result.rejected } : {}),
      })
      this.report()
    }
    return result
  }

  /** A person pauses or resumes updates for `kind`; kept in the ledger. */
  setPaused(kind: BuiltinHarnessKind, paused: boolean): SetUpdatesPausedResult {
    const result = setUpdatesPaused(kind, paused, { harnessesDir: this.options.harnessesDir })
    if (result.outcome === 'set') this.report()
    return result
  }

  private checkOne(kind: BuiltinHarnessKind): Promise<CheckForUpdateResult> {
    const running = this.inFlight.get(kind)
    if (running) return running
    const started = this.runCheck(kind).finally(() => {
      if (this.inFlight.get(kind) === started) this.inFlight.delete(kind)
    })
    this.inFlight.set(kind, started)
    return started
  }

  private async runCheck(kind: BuiltinHarnessKind): Promise<CheckForUpdateResult> {
    try {
      const [commandEnv, currentFailed] = await Promise.all([
        this.options.commandEnv(),
        this.options.currentFailed?.(kind) ?? Promise.resolve(undefined),
      ])
      const result = await (this.options.check ?? checkForUpdate)(kind, {
        harnessesDir: this.options.harnessesDir,
        commandEnv,
        ...(currentFailed !== undefined ? { currentFailed } : {}),
        lockLabel: `update ${kind} (daemon)`,
        note: (message) => log.warn(message, { kind }),
      })
      logResult(result)
      return result
    } catch (err) {
      // The ledger could not be opened, or a seam threw. The next check tries again.
      log.warn('harness update check failed', { kind, err })
      return {
        outcome: 'check-failed',
        kind,
        error: err instanceof Error ? err.message : String(err),
        swept: [],
      }
    }
  }

  private managedKinds(): BuiltinHarnessKind[] {
    if (this.options.managedKinds) return this.options.managedKinds()
    try {
      return [...readManagedInstalls(this.options.harnessesDir).harnesses.keys()]
    } catch (err) {
      log.warn('could not read the install ledger for update checks', { err })
      return []
    }
  }

  private report(): void {
    try {
      void Promise.resolve(this.options.report?.()).catch((err: unknown) =>
        log.warn('inventory report after an update check failed', { err }),
      )
    } catch (err) {
      log.warn('inventory report after an update check failed', { err })
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.checkNow()
        .catch((err: unknown) => log.warn('scheduled harness update check failed', { err }))
        .finally(() => this.schedule(this.nextDelayMs()))
    }, delayMs)
    this.timer.unref?.()
  }
}

function logResult(result: CheckForUpdateResult): void {
  switch (result.outcome) {
    case 'installed':
      log.info('harness updated', {
        kind: result.kind,
        version: result.version,
        release: result.number,
      })
      return
    case 'failed':
      log.warn('harness update failed', {
        kind: result.kind,
        version: result.version,
        step: result.step,
        rejected: result.rejected,
        error: result.error,
      })
      return
    case 'check-failed':
      log.warn('harness update check could not reach the vendor', {
        kind: result.kind,
        error: result.error,
      })
      return
    default:
      return
  }
}
