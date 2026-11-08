import { type MachineCapacityReadings, machineViewsFromWire } from '@podium/client-core/values'
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
import { useTrpc } from '../client/hooks'
import { useServerProfile } from '../client/server-profile-context'
import { serverProfileRequestKey } from '../client/server-profiles'
import { usePulseLive } from '../client/use-inbox-data'
import {
  beginCapacityRefresh,
  CapacityRefreshFence,
  CapacityRefreshScheduler,
  isCapacityAuthenticationFailure,
  selectCapacityRefreshMachineIds,
  settleCapacityRefresh,
  settleWithConcurrency,
} from './capacity-refresh'

/**
 * The Pulse tab's readings [POD-662].
 *
 * QUOTA, USAGE AND HOST METRICS ARE PUSHED (POD-5798). The server sends this
 * account's quota on `account.quota` (held for the app's life), its usage on
 * `account.usage` (held while Pulse is mounted), and each machine's samples on
 * `machine.metrics`; the LiveStore holds them, so the tab paints the newest
 * figures it has on its first frame and nothing here polls them.
 *
 * WHAT IS STILL ASKED FOR, on focus and on pull-to-refresh only: the quota
 * history (a request answer), the per-machine memory breakdown (until
 * POD-6645 moves it to a topic) and the load threshold from settings. Those
 * answers are kept per server profile in this module, never persisted.
 *
 * `nowMs` IS THE READING'S CLOCK, NOT THE RENDER'S. Every derived figure on the
 * screen — the reset countdown, the rolling windows, the day slots — is
 * evaluated against the moment the payload was taken, so the whole screen
 * describes one instant instead of mixing a fresh clock with stale buckets.
 */

const CAPACITY_CONCURRENCY = 3

interface PulseCache {
  history: QuotaWindowHistoryWire[]
  capacityReadings: MachineCapacityReadings
  loadPerCore: number | null
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
  /** When the quota and usage reading was taken — and the clock every figure
   *  is derived against. Falls back to now while unknown so nothing renders NaN. */
  nowMs: number
  fetchedAt: number | null
  /** The figures on screen are not current: the connection was lost. */
  failed: boolean
  historyFailed: boolean
  reload: () => void
}

export function usePulseFeed(): PulseFeed {
  // Subscribe only to the three live values Pulse paints. A whole-store
  // subscription would re-render this tab for unrelated replica publishes.
  const trpc = useTrpc()
  const { hosts: hostMetrics, machines, quota: quotaReading, usage: usageReading } = usePulseLive()
  const { profile } = useServerProfile()
  const profileKey = serverProfileRequestKey(profile)
  const cached = cacheByProfile.get(profileKey)
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    profileKey: string
    history: QuotaWindowHistoryWire[] | null
    capacityReadings: MachineCapacityReadings
    loadPerCore: number | null
    historyFailed: boolean
  }>(() => ({
    profileKey,
    history: cached?.history ?? null,
    capacityReadings: cached?.capacityReadings ?? {},
    loadPerCore: cached?.loadPerCore ?? null,
    historyFailed: false,
  }))
  // A pull-to-refresh asks for ANOTHER READ of the request answers. Unfocused,
  // there is no loader and the pull is a no-op, which is correct: nothing is on
  // screen to refresh.
  const loadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => loadRef.current(), [])
  const capacityFence = useRef(new CapacityRefreshFence(profileKey)).current
  const capacityScheduler = useRef(new CapacityRefreshScheduler()).current

  // ASKING FOLLOWS FOCUS. A tab navigator keeps every visited tab mounted; the
  // request answers are asked for when the tab comes into view, never on a timer.
  useFocusEffect(
    useCallback(() => {
      if (demo) return
      let cancelled = false
      const capacityOwner = profileKey
      const updateCache = (patch: Partial<PulseCache>): PulseCache => {
        const prior = cacheByProfile.get(profileKey)
        const next: PulseCache = {
          history: prior?.history ?? [],
          capacityReadings: prior?.capacityReadings ?? {},
          loadPerCore: prior?.loadPerCore ?? null,
          ...patch,
        }
        cacheByProfile.set(profileKey, next)
        return next
      }
      // The threshold the load meter means anything against. Best-effort:
      // without it the meter falls back to the documented default rather than
      // disappearing.
      const loadThreshold = (): void => {
        void trpc.settings.get
          .query()
          .then(
            (s) => (s.hibernation.enabled ? s.hibernation.loadPerCore : null),
            () => null,
          )
          .then((loadPerCore) => {
            updateCache({ loadPerCore })
            if (!cancelled) {
              setAnswer((current) => ({ ...current, profileKey, loadPerCore }))
            }
          })
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
        loadThreshold()
        loadHistory()
        loadBreakdowns(forceCapacity)
      }
      loadRef.current = () => load(true)
      load()
      return () => {
        cancelled = true
        loadRef.current = () => {}
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

  // Quota and usage are two readings (POD-5798); the screen's clock is quota's.
  const reading = quotaReading
  const value = reading ? (reading.known ? reading.value : reading.last) : undefined
  const usage = usageReading
    ? usageReading.known
      ? usageReading.value
      : usageReading.last
    : undefined
  const fetchedAt = reading?.known ? reading.at : value ? (reading?.since ?? null) : null
  const live = {
    quota: value?.machines ?? null,
    buckets: usage === undefined ? null : (usage?.buckets ?? []),
    fetchedAt,
    failed:
      (value !== undefined && reading?.known !== true) ||
      (usage !== undefined && usageReading?.known !== true),
  }

  if (answer.profileKey !== profileKey) {
    return {
      ...live,
      history: null,
      hosts: hostMetrics,
      machines,
      capacityReadings: {},
      loadPerCore: null,
      nowMs: live.fetchedAt ?? Date.now(),
      historyFailed: false,
      reload,
    }
  }

  return {
    ...answer,
    ...live,
    hosts: hostMetrics,
    machines,
    nowMs: live.fetchedAt ?? Date.now(),
    reload,
  }
}
