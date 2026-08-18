/**
 * THE RELEASE TARGETS REFRESH WHILE THE SERVER RUNS (POD-2100, spec §9.2).
 *
 * Before this, `refreshTarget` was called from exactly three places — boot, a
 * channel change, and a per-machine Apply — so a server that stays up for a
 * month advertised the target it resolved on the day it booted, and a feed that
 * was unreachable during that one boot second stayed "unavailable" for the month.
 * Neither is a bug in any single line; both are the absence of a clock.
 *
 * The cadence is deliberately part of the contract rather than an implementation
 * detail: the checked-at time it stamps is what Settings renders ("checked 2 h
 * ago"), so a user can tell "nothing is published" from "we have not looked".
 *
 * `dev` is NOT refreshed here. Its target is pushed by the source server's
 * publisher when HEAD moves; polling it would either find the same thing or race
 * the publisher.
 */

import type { UpdateChannel } from '@podium/model'

/** The channels a release feed answers for. `dev` is publisher-pushed. */
export const REFRESHABLE_CHANNELS: readonly UpdateChannel[] = ['edge', 'stable']

export const REFRESH_INTERVAL_MS = 24 * 60 * 60_000
/** A publication gap is expected to close in minutes, not at tomorrow's tick. */
export const REFRESH_RETRY_INTERVAL_MS = 2 * 60_000

/**
 * Boot already refreshes, so the first SCHEDULED tick exists to catch a feed
 * that was unreachable in that boot second — a few minutes later, jittered, so a
 * fleet of instances restarted together by one deploy does not arrive at the
 * release host as one wave.
 */
export const REFRESH_INITIAL_MIN_MS = 2 * 60_000
export const REFRESH_INITIAL_JITTER_MS = 5 * 60_000

export interface TargetRefreshDeps {
  /**
   * Resolve one channel's target. False means the feed was incomplete or
   * unavailable and needs the short retry cadence; void keeps test adapters compatible.
   */
  refresh(channel: UpdateChannel): Promise<boolean | void>
  /** True while a wave is in flight on this channel; the tick skips it. */
  operationActive(channel: UpdateChannel): boolean
  /**
   * Schedule ONE callback and return its canceller. Injected rather than calling
   * `setTimeout` directly so tests drive the schedule instead of the clock —
   * a fixed sleep before an assertion is a bug in this repo's unit lane.
   */
  schedule(run: () => void, ms: number): () => void
  channels?: readonly UpdateChannel[]
  intervalMs?: number
  retryIntervalMs?: number
  /** Stated by tests; production jitters it from `random`. */
  initialDelayMs?: number
  random?(): number
}

export interface TargetRefreshHandle {
  stop(): void
}

/** The production scheduler: an unref'd single-shot timer, re-armed per tick. */
export const timerSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function initialRefreshDelayMs(random: () => number = Math.random): number {
  return REFRESH_INITIAL_MIN_MS + Math.floor(random() * REFRESH_INITIAL_JITTER_MS)
}

/**
 * Start the periodic release-target refresh. Returns a handle whose `stop()` is
 * idempotent and must be called on shutdown — an armed timer that outlives the
 * server would refresh a service whose store is closed.
 */
export function startTargetRefresh(deps: TargetRefreshDeps): TargetRefreshHandle {
  const channels = deps.channels ?? REFRESHABLE_CHANNELS
  const intervalMs = deps.intervalMs ?? REFRESH_INTERVAL_MS
  const retryIntervalMs = deps.retryIntervalMs ?? REFRESH_RETRY_INTERVAL_MS
  const firstDelayMs = deps.initialDelayMs ?? initialRefreshDelayMs(deps.random ?? Math.random)
  let cancel: (() => void) | undefined
  let stopped = false

  const arm = (ms: number): void => {
    if (stopped) return
    cancel = deps.schedule(() => {
      void tick()
    }, ms)
  }

  const tick = async (): Promise<void> => {
    let retrySoon = false
    for (const channel of channels) {
      if (stopped) return
      // Skipping is the whole coordination: never yank a target out from under a
      // machine that is mid-grant on it.
      if (deps.operationActive(channel)) {
        retrySoon = true
        continue
      }
      // `refreshTarget` records its own failure as a check outcome, but a rejected
      // promise here would leave the loop unarmed and silently end the schedule —
      // which is the failure mode this module exists to remove.
      try {
        if ((await deps.refresh(channel)) === false) retrySoon = true
      } catch {
        // Deliberately swallowed: the outcome is recorded on the service.
        retrySoon = true
      }
    }
    // A release manifest may lead its companion desktop build by a few minutes.
    // Do not turn that honest temporary rejection into a day-long stale answer.
    arm(retrySoon ? retryIntervalMs : intervalMs)
  }

  arm(firstDelayMs)
  return {
    stop(): void {
      stopped = true
      cancel?.()
      cancel = undefined
    },
  }
}
