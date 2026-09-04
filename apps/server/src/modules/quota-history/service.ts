/**
 * THE QUOTA SAMPLER — the writer the ledger cannot exist without.
 *
 * Before this, nothing on the quota path polled on a schedule. `agentQuotaAll()`
 * ran only when a client asked: the web indicator on a 60-second interval while a
 * tab was open, the mobile Pulse tab while focused, or the CLI. Close everything
 * and sampling stopped dead — so the number that matters most, the reading just
 * before a window resets, was exactly the one most likely to be missed, because
 * windows tend to roll over overnight.
 *
 * WHY THE SERVER AND NOT THE DAEMON. The database is here, so there is no new
 * daemon→server message to invent; and two machines signed into one account
 * report the SAME limits, which converge on one row for free because the fold and
 * its uniqueness constraint live on this side. The daemon's own 120-second memo
 * already bounds what this costs a provider.
 *
 * INTERVAL. Fifteen minutes. The daemon memoises for 120 seconds, so polling
 * faster returns byte-identical payloads and buys nothing — measured: consecutive
 * 60-second pulls were duplicates until the memo turned over. Fifteen minutes
 * still puts ~670 points across a weekly window, far more than a burn curve can
 * draw.
 */

import { createLogger } from '@podium/logger'
import type { MachineQuotaWire } from '@podium/model'
import type { QuotaHistoryRepository } from '../../store/quota-history'
import { samplesFromQuota } from './samples'

const log = createLogger('server:quota-history')

/** See the header: below the daemon's 120 s memo, extra polls return duplicates. */
export const QUOTA_SAMPLE_INTERVAL_MS = 15 * 60 * 1000

/** Let the fleet connect before the first fan-out; an empty poll writes nothing. */
export const QUOTA_SAMPLE_BOOT_DELAY_MS = 30 * 1000

/** Windows that reset longer ago than this are dropped. */
export const QUOTA_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Default lookback for the ledger read — the full retained range. */
export const QUOTA_HISTORY_DEFAULT_DAYS = 90

/**
 * Fold a reading into the ledger, never throwing at the caller.
 *
 * Shared by the timer and by the read path, so an open tab contributes extra
 * resolution for free. Recording is best-effort by design: this is a side effect
 * of serving quota, and a failure to write history must never turn a working
 * `quota.summary` into an error for the person watching the meter.
 */
export function recordQuotaSamples(
  history: QuotaHistoryRepository,
  machines: MachineQuotaWire[],
  intervalMs: number = QUOTA_SAMPLE_INTERVAL_MS,
): { recorded: number; openedWindows: number } {
  let recorded = 0
  let openedWindows = 0
  for (const sample of samplesFromQuota(machines)) {
    try {
      const { openedWindow } = history.record(sample, intervalMs)
      recorded += 1
      if (openedWindow) {
        openedWindows += 1
        // A reset is the one event here worth a log line: it is when a window's
        // number becomes final, and it is what the whole chart is made of.
        log.info('quota window opened', {
          accountKey: sample.accountKey,
          windowKey: sample.windowKey,
          resetsAt: new Date(sample.resetsAtMs).toISOString(),
        })
      }
    } catch (err) {
      log.warn('quota sample not recorded', {
        accountKey: sample.accountKey,
        windowKey: sample.windowKey,
        err: String(err),
      })
    }
  }
  return { recorded, openedWindows }
}

export interface QuotaSamplerOptions {
  intervalMs?: number
  bootDelayMs?: number
  retentionMs?: number
  now?: () => number
}

export class QuotaSampler {
  private bootTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined
  private disposed = false

  private readonly intervalMs: number
  private readonly retentionMs: number
  private readonly bootDelayMs: number
  private readonly now: () => number

  constructor(
    private readonly history: QuotaHistoryRepository,
    private readonly readQuota: () => Promise<MachineQuotaWire[]>,
    options: QuotaSamplerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? QUOTA_SAMPLE_INTERVAL_MS
    this.bootDelayMs = options.bootDelayMs ?? QUOTA_SAMPLE_BOOT_DELAY_MS
    this.retentionMs = options.retentionMs ?? QUOTA_HISTORY_RETENTION_MS
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.bootTimer = setTimeout(() => {
      void this.sampleNow()
      this.timer = setInterval(() => void this.sampleNow(), this.intervalMs)
      this.timer.unref?.()
    }, this.bootDelayMs)
    this.bootTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * One sampling pass.
   *
   * Overlapping TIMER passes share the in-flight one rather than stacking
   * fan-outs. That is the whole of the guarantee, and it deliberately does not
   * extend to `quota.summary`: that path has to fan out anyway to answer the
   * caller, and it folds the payload it already fetched rather than asking for a
   * second one. So a tick landing on an open tab's poll can still produce two
   * concurrent fan-outs — bounded by the daemon's own 120 s memo, which is what
   * keeps the cost off the providers.
   */
  sampleNow(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const flight = this.runPass().finally(() => {
      if (this.inFlight === flight) this.inFlight = undefined
    })
    this.inFlight = flight
    return flight
  }

  private async runPass(): Promise<void> {
    if (this.disposed) return
    let machines: MachineQuotaWire[]
    try {
      machines = await this.readQuota()
    } catch (err) {
      // A provider outage, an offline daemon, or a fan-out timeout. The next tick
      // tries again; a gap in the ledger is the honest outcome and is shown as one.
      log.debug('quota sample failed', { err: String(err) })
      return
    }
    if (this.disposed) return
    recordQuotaSamples(this.history, machines, this.intervalMs)
    this.pruneExpired()
  }

  private pruneExpired(): void {
    try {
      const deleted = this.history.prune(this.now() - this.retentionMs)
      if (deleted > 0) log.debug('pruned quota windows', { deleted })
    } catch (err) {
      log.debug('quota prune failed', { err: String(err) })
    }
  }
}
