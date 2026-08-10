import type { HostMetricsWire, MachineQuotaWire, UsageBucketWire } from '@podium/model'
import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { DEMO_HOST_METRICS, DEMO_QUOTA, DEMO_USAGE_BUCKETS, demoEnabled } from '../client/demoData'
import { useMobileStore } from '../client/hooks'

/**
 * The Pulse tab's three readings [POD-662].
 *
 * TWO OF THEM ARE POLLED, ONE IS ALREADY LIVE. Quota comes from each provider's
 * own endpoint and usage from a transcript harvest — both are daemon-side reads
 * with no push channel, so they are fetched. Host metrics already stream into
 * the store, so nothing here fetches them; the hook only hands them along, and
 * they update at their own (faster) rate.
 *
 * CACHE-FIRST, like the desktop usage sheet. The tab stays mounted once
 * visited, but a cold app launch would otherwise open on an empty instrument,
 * and switching to Pulse to check one number is the most common thing this
 * screen is for. The last answer survives in the module so the second visit
 * paints real figures on the first frame; the fetch behind it is a refresh.
 *
 * MODULE-LOCAL, NOT PERSISTED — same reasoning as the web feed: these are the
 * operator's own consumption figures, and a store that outlives the session
 * would have to be bound to a principal to hold them honestly.
 *
 * `nowMs` IS THE READING'S CLOCK, NOT THE RENDER'S. Every derived figure on the
 * screen — the reset countdown, the rolling windows, the day slots — is
 * evaluated against the moment the payload was taken, so the whole screen
 * describes one instant instead of mixing a fresh clock with stale buckets.
 */

const REFRESH_MS = 60_000

let cached: {
  quota: MachineQuotaWire[]
  buckets: UsageBucketWire[]
  loadPerCore: number | null
  fetchedAt: number
} | null = null

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetPulseCache(): void {
  cached = null
}

export interface PulseFeed {
  /** Null only until this launch has had an answer: the one cold state. */
  quota: MachineQuotaWire[] | null
  buckets: UsageBucketWire[] | null
  /** Streamed, so never cold in the way the polled pair is. */
  hosts: readonly HostMetricsWire[]
  /** The auto-park threshold the load meter fills against; null = policy off. */
  loadPerCore: number | null
  /** When the polled pair was taken — and the clock every figure is derived
   *  against. Falls back to launch time while cold so nothing renders NaN. */
  nowMs: number
  fetchedAt: number | null
  /** The last attempt failed. With figures on screen, they are simply older. */
  failed: boolean
  reload: () => void
}

export function usePulseFeed(): PulseFeed {
  const store = useMobileStore()
  const { trpc, hostMetrics } = store
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    quota: MachineQuotaWire[] | null
    buckets: UsageBucketWire[] | null
    loadPerCore: number | null
    fetchedAt: number | null
    failed: boolean
  }>(() => ({
    quota: cached?.quota ?? null,
    buckets: cached?.buckets ?? null,
    loadPerCore: cached?.loadPerCore ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
    failed: false,
  }))
  // A pull-to-refresh asks for ANOTHER READ, not for the poller to be rebuilt.
  // Routing it through the live loader keeps the 60s cadence intact — bumping a
  // counter in the effect's dependency list would tear the interval down and
  // start a fresh one from zero on every pull. Unfocused, there is no loader
  // and the pull is a no-op, which is correct: nothing is on screen to refresh.
  const loadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => loadRef.current(), [])

  // POLLING FOLLOWS FOCUS. A tab navigator keeps every visited tab mounted, so
  // an unconditional interval would keep asking the daemon for quota while the
  // operator is reading a transcript three tabs away — for a screen nobody is
  // looking at, on a phone paying for the radio.
  useFocusEffect(
    useCallback(() => {
      if (demo) return
      let cancelled = false
      const load = (): void => {
        Promise.all([
          trpc.quota.summary.query(),
          trpc.usage.summary.query(),
          // The threshold the load meter means anything against. Best-effort:
          // without it the meter falls back to the documented default rather
          // than disappearing.
          trpc.settings.get.query().then(
            (s) => (s.hibernation.enabled ? s.hibernation.loadPerCore : null),
            () => null,
          ),
        ]).then(
          ([quota, usage, loadPerCore]) => {
            cached = { quota, buckets: usage.buckets, loadPerCore, fetchedAt: Date.now() }
            if (!cancelled) {
              setAnswer({
                quota,
                buckets: usage.buckets,
                loadPerCore,
                fetchedAt: cached.fetchedAt,
                failed: false,
              })
            }
          },
          () => {
            // Whatever is on screen stays; only its currency changed.
            if (!cancelled) setAnswer((a) => ({ ...a, failed: true }))
          },
        )
      }
      loadRef.current = load
      load()
      const poll = setInterval(load, REFRESH_MS)
      return () => {
        cancelled = true
        loadRef.current = () => {}
        clearInterval(poll)
      }
    }, [trpc, demo]),
  )

  if (demo) {
    return {
      quota: DEMO_QUOTA,
      buckets: DEMO_USAGE_BUCKETS,
      hosts: DEMO_HOST_METRICS,
      loadPerCore: 1.5,
      nowMs: Date.now(),
      fetchedAt: Date.now(),
      failed: false,
      reload,
    }
  }

  return {
    ...answer,
    hosts: hostMetrics,
    nowMs: answer.fetchedAt ?? Date.now(),
    reload,
  }
}
