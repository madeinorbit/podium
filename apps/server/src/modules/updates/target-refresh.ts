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
 * `dev` IS refreshed here now (spec §1, disposition 19/20). It used to be
 * excluded because its target was pushed by the source server's publisher when
 * HEAD moved, so polling would either find the same thing or race the push.
 * The publisher writes a real manifest into a feed the ordinary resolver pulls,
 * so the race is gone and the exclusion with it: dev is refreshed on the same
 * clock, skipped by the same operation-active rule, and retried on the same
 * short cadence when its feed is momentarily incomplete.
 *
 * The publisher still NUDGES a refresh in-process the moment it has published,
 * because it shares the process with the updater on the source host and a
 * twenty-four-hour tick is not the latency an operator watching a release wants.
 * That nudge is the same `refresh` this tick calls, so the two coalesce.
 */

import type { UpdateChannel } from '@podium/model'

/** Every channel resolves through a feed, so every channel is refreshable. */
export const REFRESHABLE_CHANNELS: readonly UpdateChannel[] = ['dev', 'edge', 'stable']

export const REFRESH_INTERVAL_MS = 24 * 60 * 60_000
/** A publication gap is expected to close in minutes, not at tomorrow's tick. */
export const REFRESH_RETRY_INTERVAL_MS = 2 * 60_000
export const REFRESH_FAILURE_INTERVALS_MS = [2 * 60_000, 10 * 60_000, 60 * 60_000] as const

/** False is a failing feed; only an incomplete publication keeps the short retry. */
export type TargetRefreshResult = boolean | void | 'incomplete'

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
   * Resolve one channel's target. Void keeps test adapters compatible.
   */
  refresh(channel: UpdateChannel): Promise<TargetRefreshResult>
  /** True while a wave is in flight on this channel; the tick skips it. */
  operationActive(channel: UpdateChannel): Promise<boolean>
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
  now?(): number
  /** Results of the immediate boot check, so a healthy feed waits a full day. */
  initialResults?: Partial<Record<UpdateChannel, TargetRefreshResult>>
  enabled?: boolean
}

export interface TargetRefreshHandle {
  stop(): void
}

/**
 * Resolve every release authority once during boot, before the server reports
 * healthy and before the delayed refresh clock is armed.
 *
 * This shares the scheduler's channel list deliberately. `dev` used to be
 * absent from the composition root's hand-written boot list even after it
 * became a pulled feed, leaving a restarted source blind until the first
 * jittered tick. A caller may state channels only for an armed negative control.
 */
export async function refreshTargetsOnBoot(deps: {
  refresh(channel: UpdateChannel): Promise<TargetRefreshResult>
  channels?: readonly UpdateChannel[]
  enabled?: boolean
}): Promise<Partial<Record<UpdateChannel, TargetRefreshResult>>> {
  const results: Partial<Record<UpdateChannel, TargetRefreshResult>> = {}
  if (deps.enabled === false) return results
  const channels = deps.channels ?? REFRESHABLE_CHANNELS
  await Promise.all(
    channels.map(async (channel) => {
      try {
        results[channel] = await deps.refresh(channel)
      } catch {
        results[channel] = false
        // The update service records the channel-specific outcome. One feed
        // being unavailable must not make the rest of the server unbootable.
      }
    }),
  )
  return results
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
  if (deps.enabled === false) return { stop() {} }
  const channels = deps.channels ?? REFRESHABLE_CHANNELS
  const intervalMs = deps.intervalMs ?? REFRESH_INTERVAL_MS
  const retryIntervalMs = deps.retryIntervalMs ?? REFRESH_RETRY_INTERVAL_MS
  const firstDelayMs = deps.initialDelayMs ?? initialRefreshDelayMs(deps.random ?? Math.random)
  const now = deps.now ?? Date.now
  const failures = new Map<UpdateChannel, number>()
  const due = new Map<UpdateChannel, number>()
  const delayFor = (channel: UpdateChannel, result: TargetRefreshResult): number => {
    if (result === false) {
      const count = (failures.get(channel) ?? 0) + 1
      failures.set(channel, count)
      return (
        REFRESH_FAILURE_INTERVALS_MS[
          Math.min(count - 1, REFRESH_FAILURE_INTERVALS_MS.length - 1)
        ] ?? 60 * 60_000
      )
    }
    failures.delete(channel)
    return result === 'incomplete' ? retryIntervalMs : intervalMs
  }
  const startedAt = now()
  for (const channel of channels) {
    const hasBootResult = deps.initialResults && channel in deps.initialResults
    const delay = hasBootResult ? delayFor(channel, deps.initialResults?.[channel]) : firstDelayMs
    due.set(
      channel,
      startedAt + (hasBootResult && delay < intervalMs ? Math.max(delay, firstDelayMs) : delay),
    )
  }
  let cancel: (() => void) | undefined
  let stopped = false

  const arm = (ms: number): void => {
    if (stopped) return
    cancel = deps.schedule(() => {
      void tick()
    }, ms)
  }

  const tick = async (): Promise<void> => {
    for (const channel of channels) {
      if (stopped) return
      if ((due.get(channel) ?? Infinity) > now()) continue
      // Skipping is the whole coordination: never yank a target out from under a
      // machine that is mid-grant on it.
      // AWAITED: a bare call here is a truthy promise, so every channel would
      // look mid-grant and no target would ever refresh.
      if (await deps.operationActive(channel)) {
        due.set(channel, now() + retryIntervalMs)
        continue
      }
      // `refreshTarget` records its own failure as a check outcome, but a rejected
      // promise here would leave the loop unarmed and silently end the schedule —
      // which is the failure mode this module exists to remove.
      let result: TargetRefreshResult
      try {
        result = await deps.refresh(channel)
      } catch {
        // Deliberately swallowed: the outcome is recorded on the service.
        result = false
      }
      due.set(channel, now() + delayFor(channel, result))
    }
    // A release manifest may lead its companion desktop build by a few minutes.
    // Do not turn that honest temporary rejection into a day-long stale answer.
    armNext()
  }

  const armNext = (): void => {
    if (due.size > 0) arm(Math.max(0, Math.min(...due.values()) - now()))
  }
  armNext()
  return {
    stop(): void {
      stopped = true
      cancel?.()
      cancel = undefined
    },
  }
}
