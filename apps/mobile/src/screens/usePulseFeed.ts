import { type MachineCapacityReadings, machineViewsFromWire } from '@podium/client-core/values'
import { headerView } from '@podium/client-graph/header-views'
import type { PulseView } from '@podium/client-graph/pulse-view'
import type { MachineId, MachineQuotaWire, MachineWire, UsageBucketWire } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import {
  DEMO_MACHINES,
  DEMO_MEMORY_BREAKDOWNS,
  DEMO_QUOTA,
  DEMO_USAGE_BUCKETS,
  demoEnabled,
} from '../client/demoData'
import { useTrpc } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { useServerProfile } from '../client/server-profile-context'
import { serverProfileRequestKey } from '../client/server-profiles'
import { useContentActive } from '../lib/visible-content'
import {
  beginCapacityRefresh,
  CapacityRefreshFence,
  CapacityRefreshScheduler,
  isCapacityAuthenticationFailure,
  selectCapacityRefreshMachineIds,
  settleCapacityRefresh,
  settleWithConcurrency,
} from './capacity-refresh'

/** Capacity keeps its existing profile-scoped readings.
 * Quota, usage and task costs belong to the shared Pulse opening. Host metrics
 * subscribe in the verdict and machines components.
 * Polls run only while focused; machine-list changes affect capacity reads,
 * never the usage/cost refresh cadence.
 */

const REFRESH_MS = 60_000
const CAPACITY_CONCURRENCY = 3

interface PulseCache {
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
  /** Each reading is null until its own first successful answer. */
  quota: MachineQuotaWire[] | null
  buckets: UsageBucketWire[] | null
  /** The same per-principal projection the desktop machine surface receives. */
  machines: readonly MachineWire[]
  /** Answers only for machines whose live `use` gate admitted the daemon walk. */
  capacityReadings: MachineCapacityReadings
  /** The auto-park threshold the load meter fills against; null = policy off. */
  loadPerCore: number | null
  /** Usage harvest time, with the policy reading time as a cold fallback. */
  nowMs: number
  fetchedAt: number | null
  /** The last attempt failed. With figures on screen, they are simply older. */
  quotaFailed: boolean
  reload: (reading?: 'usage' | 'quota') => void
}

const EMPTY_MACHINES: readonly MachineWire[] = []
const readMachines = (pool: Parameters<typeof headerView>[0]) => headerView(pool).machines()

export function usePulseFeed(pulse: PulseView | null): PulseFeed {
  const active = useContentActive()
  // Subscribe only to the three live values Pulse paints. A whole-store
  // subscription would re-render this tab for unrelated replica publishes.
  const trpc = useTrpc()
  const machines = useMobilePoolProjection(readMachines, EMPTY_MACHINES)
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const { profile } = useServerProfile()
  const profileKey = serverProfileRequestKey(profile)
  const cached = cacheByProfile.get(profileKey)
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    profileKey: string
    capacityReadings: MachineCapacityReadings
    loadPerCore: number | null
    fetchedAt: number | null
  }>(() => ({
    profileKey,
    capacityReadings: cached?.capacityReadings ?? {},
    loadPerCore: cached?.loadPerCore ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
  }))
  // A pull-to-refresh asks for ANOTHER READ, not for the poller to be rebuilt.
  // Routing it through the live loader keeps the 60s cadence intact — bumping a
  // counter in the effect's dependency list would tear the interval down and
  // start a fresh one from zero on every pull. Unfocused, there is no loader
  // and the pull is a no-op, which is correct: nothing is on screen to refresh.
  const loadRef = useRef<(reading?: 'usage' | 'quota') => void>(() => {})
  const capacityLoadRef = useRef<() => void>(() => {})
  const reload = useCallback((reading?: 'usage' | 'quota') => loadRef.current(reading), [])
  const capacityFence = useRef(new CapacityRefreshFence(profileKey)).current
  const capacityScheduler = useRef(new CapacityRefreshScheduler()).current

  // POLLING FOLLOWS FOCUS. A tab navigator keeps every visited tab mounted, so
  // an unconditional interval would keep asking the daemon for quota while the
  // operator is reading a transcript three tabs away — for a screen nobody is
  // looking at, on a phone paying for the radio.
  useFocusEffect(
    useCallback(() => {
      if (!active) return
      if (demo) {
        void pulse?.refresh(
          () => Promise.resolve({ buckets: DEMO_USAGE_BUCKETS }),
          () => Promise.resolve([]),
          () => Promise.resolve(DEMO_QUOTA),
        )
        return () => pulse?.cancel()
      }
      let cancelled = false
      const capacityOwner = profileKey
      const updateCache = (patch: Partial<PulseCache>): PulseCache => {
        const prior = cacheByProfile.get(profileKey)
        const next: PulseCache = {
          capacityReadings: prior?.capacityReadings ?? {},
          loadPerCore: prior?.loadPerCore ?? null,
          fetchedAt: prior?.fetchedAt ?? Date.now(),
          ...patch,
        }
        cacheByProfile.set(profileKey, next)
        return next
      }
      const loadReadings = (reading?: 'usage' | 'quota'): void => {
        if (reading === 'quota') {
          void pulse?.refreshQuota(() => trpc.quota.summary.query())
          return
        }
        if (reading === 'usage') {
          void pulse?.refreshUsage(
            () => trpc.usage.summary.query(),
            () => trpc.cost.tasks.query(),
          )
          return
        }
        void pulse?.refresh(
          () => trpc.usage.summary.query(),
          () => trpc.cost.tasks.query(),
          () => trpc.quota.summary.query(),
        )
        // This optional policy reading does not gate any Pulse telemetry.
        void trpc.settings.get.query().then(
          (settings) => {
            if (cancelled) return
            const cached = updateCache({
              loadPerCore: settings.hibernation.enabled ? settings.hibernation.loadPerCore : null,
              fetchedAt: Date.now(),
            })
            setAnswer((current) => ({
              ...current,
              profileKey,
              loadPerCore: cached.loadPerCore,
              fetchedAt: cached.fetchedAt,
            }))
          },
          () => {},
        )
      }

      const runBreakdowns = (force: boolean): Promise<void> => {
        if (cancelled) return Promise.resolve()
        const views = machineViewsFromWire(machinesRef.current)
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
        loadBreakdowns(forceCapacity)
      }
      capacityLoadRef.current = () => loadBreakdowns(false)
      loadRef.current = (reading) => (reading ? loadReadings(reading) : load(true))
      load()
      const poll = setInterval(() => {
        loadReadings()
      }, REFRESH_MS)
      return () => {
        cancelled = true
        loadRef.current = () => {}
        capacityLoadRef.current = () => {}
        clearInterval(poll)
        pulse?.cancel()
      }
    }, [active, capacityFence, capacityScheduler, pulse, demo, profileKey, trpc]),
  )

  useFocusEffect(
    useCallback(() => {
      if (!active) return
      machinesRef.current = machines
      capacityLoadRef.current()
    }, [machines, active]),
  )

  if (demo) {
    return {
      quota: DEMO_QUOTA,
      buckets: DEMO_USAGE_BUCKETS,
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
      quotaFailed: false,
      reload,
    }
  }

  if (answer.profileKey !== profileKey) {
    return {
      quota: null,
      buckets: null,
      machines,
      capacityReadings: {},
      loadPerCore: null,
      nowMs: Date.now(),
      fetchedAt: null,
      quotaFailed: false,
      reload,
    }
  }

  return {
    ...answer,
    quota: pulse?.quota.answer ?? null,
    quotaFailed: pulse?.quota.error != null,
    buckets: pulse?.answer?.buckets ?? null,
    machines,
    nowMs: pulse?.answer?.nowMs ?? answer.fetchedAt ?? Date.now(),
    reload,
  }
}
