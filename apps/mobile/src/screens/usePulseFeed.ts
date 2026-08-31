import { type MachineCapacityReadings, machineViewsFromWire } from '@podium/client-core/viewmodels'
import type {
  HostMetricsWire,
  MachineId,
  MachineQuotaWire,
  MachineWire,
  QuotaWindowHistoryWire,
  UsageBucketWire,
} from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import {
  DEMO_HOST_METRICS,
  DEMO_MACHINES,
  DEMO_MEMORY_BREAKDOWNS,
  DEMO_QUOTA,
  DEMO_QUOTA_HISTORY,
  DEMO_USAGE_BUCKETS,
  demoEnabled,
} from '../client/demoData'
import { useMobileStore } from '../client/hooks'
import { useServerProfile } from '../client/ServerProfileGate'
import { serverProfileRequestKey } from '../client/server-profiles'
import {
  beginCapacityRefresh,
  CapacityRefreshFence,
  CapacityRefreshScheduler,
  isCapacityAuthenticationFailure,
  selectCapacityRefreshMachineIds,
  settleWithConcurrency,
  settleCapacityRefresh,
} from './capacity-refresh'

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
const CAPACITY_CONCURRENCY = 3

interface PulseCache {
  quota: MachineQuotaWire[]
  buckets: UsageBucketWire[]
  history: QuotaWindowHistoryWire[]
  capacityReadings: MachineCapacityReadings
  loadPerCore: number | null
  fetchedAt: number
}

const cacheByProfile = new Map<string, PulseCache>()

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetPulseCache(): void {
  cacheByProfile.clear()
}

export interface PulseFeed {
  /** Null only until this launch has had an answer: the one cold state. */
  quota: MachineQuotaWire[] | null
  buckets: UsageBucketWire[] | null
  history: QuotaWindowHistoryWire[] | null
  /** Streamed, so never cold in the way the polled pair is. */
  hosts: readonly HostMetricsWire[]
  /** The same per-principal projection the desktop machine surface receives. */
  machines: readonly MachineWire[]
  /** Answers only for machines whose live `use` gate admitted the daemon walk. */
  capacityReadings: MachineCapacityReadings
  /** The auto-park threshold the load meter fills against; null = policy off. */
  loadPerCore: number | null
  /** When the polled pair was taken — and the clock every figure is derived
   *  against. Falls back to launch time while cold so nothing renders NaN. */
  nowMs: number
  fetchedAt: number | null
  /** The last attempt failed. With figures on screen, they are simply older. */
  failed: boolean
  historyFailed: boolean
  reload: () => void
}

export function usePulseFeed(): PulseFeed {
  const store = useMobileStore()
  const { trpc, hostMetrics, machines } = store
  const { profile } = useServerProfile()
  const profileKey = serverProfileRequestKey(profile)
  const cached = cacheByProfile.get(profileKey)
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    profileKey: string
    quota: MachineQuotaWire[] | null
    buckets: UsageBucketWire[] | null
    history: QuotaWindowHistoryWire[] | null
    capacityReadings: MachineCapacityReadings
    loadPerCore: number | null
    fetchedAt: number | null
    failed: boolean
    historyFailed: boolean
  }>(() => ({
    profileKey,
    quota: cached?.quota ?? null,
    buckets: cached?.buckets ?? null,
    history: cached?.history ?? null,
    capacityReadings: cached?.capacityReadings ?? {},
    loadPerCore: cached?.loadPerCore ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
    failed: false,
    historyFailed: false,
  }))
  // A pull-to-refresh asks for ANOTHER READ, not for the poller to be rebuilt.
  // Routing it through the live loader keeps the 60s cadence intact — bumping a
  // counter in the effect's dependency list would tear the interval down and
  // start a fresh one from zero on every pull. Unfocused, there is no loader
  // and the pull is a no-op, which is correct: nothing is on screen to refresh.
  const loadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => loadRef.current(), [])
  const capacityFence = useRef(new CapacityRefreshFence(profileKey)).current
  const capacityScheduler = useRef(new CapacityRefreshScheduler()).current

  // POLLING FOLLOWS FOCUS. A tab navigator keeps every visited tab mounted, so
  // an unconditional interval would keep asking the daemon for quota while the
  // operator is reading a transcript three tabs away — for a screen nobody is
  // looking at, on a phone paying for the radio.
  useFocusEffect(
    useCallback(() => {
      if (demo) return
      let cancelled = false
      const capacityOwner = profileKey
      const updateCache = (patch: Partial<PulseCache>): PulseCache => {
        const prior = cacheByProfile.get(profileKey)
        const next: PulseCache = {
          quota: prior?.quota ?? [],
          buckets: prior?.buckets ?? [],
          history: prior?.history ?? [],
          capacityReadings: prior?.capacityReadings ?? {},
          loadPerCore: prior?.loadPerCore ?? null,
          fetchedAt: prior?.fetchedAt ?? Date.now(),
          ...patch,
        }
        cacheByProfile.set(profileKey, next)
        return next
      }
      const loadReadings = (): void => {
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
            const cached = updateCache({
              quota,
              buckets: usage.buckets,
              loadPerCore,
              fetchedAt: Date.now(),
            })
            if (!cancelled) {
              setAnswer((current) => ({
                ...current,
                profileKey,
                quota: cached.quota,
                buckets: cached.buckets,
                loadPerCore: cached.loadPerCore,
                fetchedAt: cached.fetchedAt,
                failed: false,
              }))
            }
          },
          () => {
            // Whatever is on screen stays; only its currency changed.
            if (!cancelled) setAnswer((a) => ({ ...a, failed: true }))
          },
        )
      }

      const loadHistory = (): void => {
        void trpc.quota.history.query({ days: 42 }).then(
          (history) => {
            updateCache({ history })
            if (!cancelled) {
              setAnswer((current) => ({
                ...current,
                profileKey,
                history,
                historyFailed: false,
              }))
            }
          },
          () => {
            if (!cancelled) setAnswer((current) => ({ ...current, historyFailed: true }))
          },
        )
      }

      const runBreakdowns = (force: boolean): Promise<void> => {
        if (cancelled) return Promise.resolve()
        const views = machineViewsFromWire(machines)
        const retained = views.filter((view) => view.grants.use).map((view) => view.machine)
        const available = views
          .filter((view) => view.grants.use && view.availability === 'available')
          .map((view) => view.machine)
        const current = cacheByProfile.get(profileKey)?.capacityReadings ?? {}
        const targetIds = selectCapacityRefreshMachineIds(
          current,
          available.map((machine) => machine.id),
          Date.now(),
          force,
        )
        const targetsById = new Map(available.map((machine) => [machine.id, machine]))
        const targets = targetIds.flatMap((machineId) => {
          const machine = targetsById.get(machineId)
          return machine ? [machine] : []
        })
        const offlineIds = retained
          .filter((machine) => !targetsById.has(machine.id))
          .map((machine) => machine.id)
        const started = beginCapacityRefresh(
          current,
          retained.map((machine) => machine.id),
          targetIds,
          offlineIds,
        )
        updateCache({ capacityReadings: started })
        if (!cancelled) {
          setAnswer((current) => ({
            ...(current.profileKey === profileKey
              ? current
              : {
                  ...current,
                  profileKey,
                  quota: null,
                  buckets: null,
                  history: null,
                  capacityReadings: {},
                }),
            capacityReadings: started,
          }))
        }
        if (targets.length === 0) return Promise.resolve()
        const token = capacityFence.begin(profileKey)
        const publish = (
          machineId: MachineId,
          result: PromiseSettledResult<HostMemoryBreakdown>,
        ): void => {
          if (cancelled || !capacityFence.accepts(token)) return
          if (result.status === 'rejected' && isCapacityAuthenticationFailure(result.reason)) {
            capacityFence.invalidate(token)
            updateCache({ capacityReadings: {} })
            setAnswer((current) =>
              current.profileKey === profileKey ? { ...current, capacityReadings: {} } : current,
            )
            return
          }
          const settled = settleCapacityRefresh(
            cacheByProfile.get(profileKey)?.capacityReadings ?? started,
            [[machineId, result]],
          )
          updateCache({ capacityReadings: settled })
          setAnswer((current) =>
            current.profileKey === profileKey ? { ...current, capacityReadings: settled } : current,
          )
        }
        return settleWithConcurrency(targets, CAPACITY_CONCURRENCY, async (machine) => {
          if (cancelled || !capacityFence.accepts(token)) {
            throw new Error('capacity refresh superseded')
          }
          try {
            const breakdown = await trpc.hosts.memoryBreakdown.mutate({ machineId: machine.id })
            publish(machine.id, { status: 'fulfilled', value: breakdown })
            return breakdown
          } catch (reason) {
            publish(machine.id, { status: 'rejected', reason })
            throw reason
          }
        }).then(() => undefined)
      }

      const loadBreakdowns = (force: boolean): void => {
        capacityScheduler.schedule(capacityOwner, force, runBreakdowns)
      }

      const load = (forceCapacity = false): void => {
        loadReadings()
        loadHistory()
        loadBreakdowns(forceCapacity)
      }
      loadRef.current = () => load(true)
      load()
      const poll = setInterval(loadReadings, REFRESH_MS)
      return () => {
        cancelled = true
        loadRef.current = () => {}
        clearInterval(poll)
      }
    }, [capacityFence, capacityScheduler, demo, machines, profileKey, trpc]),
  )

  if (demo) {
    return {
      quota: DEMO_QUOTA,
      buckets: DEMO_USAGE_BUCKETS,
      history: DEMO_QUOTA_HISTORY,
      hosts: DEMO_HOST_METRICS,
      machines: DEMO_MACHINES,
      capacityReadings: Object.fromEntries(
        Object.entries(DEMO_MEMORY_BREAKDOWNS).map(([machineId, value]) => [
          machineId,
          { state: 'ready' as const, value },
        ]),
      ) as MachineCapacityReadings,
      loadPerCore: 1.5,
      nowMs: Date.now(),
      fetchedAt: Date.now(),
      failed: false,
      historyFailed: false,
      reload,
    }
  }

  if (answer.profileKey !== profileKey) {
    return {
      quota: null,
      buckets: null,
      history: null,
      hosts: hostMetrics,
      machines,
      capacityReadings: {},
      loadPerCore: null,
      nowMs: Date.now(),
      fetchedAt: null,
      failed: false,
      historyFailed: false,
      reload,
    }
  }

  return {
    ...answer,
    hosts: hostMetrics,
    machines,
    nowMs: answer.fetchedAt ?? Date.now(),
    reload,
  }
}
