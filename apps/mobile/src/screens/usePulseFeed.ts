import type { MachineTargetUnavailableReasons } from '@podium/client-core/values'
import { type MachineCapacityReadings, machineViewsFromWire } from '@podium/client-core/values'
import { instancePreferences } from '@podium/client-graph/instance-preferences'
import type { MobxPool } from '@podium/client-graph/pool'
import type { PulseView } from '@podium/client-graph/pulse-view'
import type { MachineFacts, MachineId, MachineQuotaWire, UsageBucketWire } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useRef, useState } from 'react'
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
import { usePulseMachines } from '../client/use-pool-links'
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
import { MachineUpdateReasons, useMachineUpdateReasons } from './machine-update-reasons'

/**
 * The Pulse tab's readings [POD-662], on the pushed values of POD-5798.
 *
 * QUOTA AND USAGE ARE PUSHED and read through the shared `PulseView`, which
 * holds `account.usage` only while the tab is focused; host metrics subscribe
 * in the verdict and machines components. Nothing here polls.
 *
 * WHAT IS STILL ASKED FOR, on focus and on pull-to-refresh: the task-cost rows
 * (again after each fresh usage value, since the usage harvest folds them) and
 * the per-machine memory breakdown (until POD-6645 moves it to a
 * topic). Machine-list changes only re-check capacity. The breakdowns are kept
 * per server profile in this module, never persisted. The load threshold is the
 * synced instance settings (POD-6677): no request.
 */

const CAPACITY_CONCURRENCY = 3

interface PulseCache {
  capacityReadings: MachineCapacityReadings
}

const cacheByProfile = new Map<string, PulseCache>()

const loadThresholdOf = (pool: MobxPool): number | null =>
  instancePreferences(pool)?.loadPerCoreThreshold ?? null

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetPulseCache(): void {
  cacheByProfile.clear()
}

export interface PulseFeed {
  /** Each reading is null until its own first value. */
  quota: MachineQuotaWire[] | null
  buckets: UsageBucketWire[] | null
  /** The same per-principal projection the desktop machine surface receives. */
  machines: readonly MachineFacts[]
  /** Answers only for machines whose live `use` gate admitted the daemon walk. */
  capacityReadings: MachineCapacityReadings
  /** Transient update explanations read only while this tab is visible. */
  targetUnavailableReasons: MachineTargetUnavailableReasons | undefined
  /** The auto-park threshold the load meter fills against; null = policy off. */
  loadPerCore: number | null
  /** When the usage on screen was received, with quota's as a cold fallback:
   *  the clock every figure is derived against. */
  nowMs: number
  fetchedAt: number | null
  /** The connection was lost; the quota on screen is the last value. */
  quotaFailed: boolean
  /** Asks again for what is requested: task costs and capacity. */
  reload: () => void
}

export function usePulseFeed(pulse: PulseView | null): PulseFeed {
  const active = useContentActive()
  const trpc = useTrpc()
  const machines = usePulseMachines()
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const loadPerCore = useMobilePoolProjection(loadThresholdOf, null)
  const { profile } = useServerProfile()
  const profileKey = serverProfileRequestKey(profile)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each profile owns a separate transient request.
  const targetReasons = useMemo(() => new MachineUpdateReasons(), [profileKey])
  useMachineUpdateReasons(targetReasons)
  const readTargetReasons = useCallback(() => targetReasons.answer, [targetReasons])
  const targetUnavailableReasons = useMobilePoolProjection(readTargetReasons, undefined)
  const cached = cacheByProfile.get(profileKey)
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    profileKey: string
    capacityReadings: MachineCapacityReadings
  }>(() => ({
    profileKey,
    capacityReadings: cached?.capacityReadings ?? {},
  }))
  // A pull-to-refresh asks for ANOTHER READ of the request answers. Unfocused,
  // there is no loader and the pull is a no-op, which is correct: nothing is on
  // screen to refresh.
  const loadRef = useRef<() => void>(() => {})
  const capacityLoadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => loadRef.current(), [])
  const capacityFence = useRef(new CapacityRefreshFence(profileKey)).current
  const capacityScheduler = useRef(new CapacityRefreshScheduler()).current
  // A fresh usage value means the harvest ran, and folded the cost rows.
  const usageStamp = pulse?.usageStamp ?? null

  // ASKING FOLLOWS FOCUS. A tab navigator keeps every visited tab mounted; the
  // request answers are asked for when the tab comes into view, never on a timer.
  useFocusEffect(
    useCallback(() => {
      if (!active) return
      if (demo) {
        pulse?.showFixture(DEMO_USAGE_BUCKETS, DEMO_QUOTA)
        void pulse?.refreshCosts(() => Promise.resolve([]))
        return () => pulse?.cancel()
      }
      // Reading usage while focused is what holds `account.usage`.
      pulse?.setActive(true)
      let cancelled = false
      const capacityOwner = profileKey
      const updateCache = (patch: Partial<PulseCache>): PulseCache => {
        const prior = cacheByProfile.get(profileKey)
        const next: PulseCache = {
          capacityReadings: prior?.capacityReadings ?? {},
          ...patch,
        }
        cacheByProfile.set(profileKey, next)
        return next
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

      capacityLoadRef.current = () => loadBreakdowns(false)
      // A pull asks again for everything requested: costs and capacity.
      loadRef.current = () => {
        void pulse?.refreshCosts(() => trpc.cost.tasks.query())
        loadBreakdowns(true)
      }
      loadBreakdowns(false)
      return () => {
        cancelled = true
        loadRef.current = () => {}
        capacityLoadRef.current = () => {}
        pulse?.cancel()
        pulse?.setActive(false)
      }
    }, [active, capacityFence, capacityScheduler, pulse, demo, profileKey, trpc]),
  )

  // TASK COSTS: asked once on focus, and again after each fresh usage value
  // while focused, since that harvest folded the rows (see PulseView).
  useFocusEffect(
    useCallback(() => {
      if (demo) return
      void usageStamp
      void pulse?.refreshCosts(() => trpc.cost.tasks.query())
    }, [demo, pulse, usageStamp, trpc]),
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
      targetUnavailableReasons: undefined,
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

  const fetchedAt = pulse?.usageAt ?? pulse?.quotaAt ?? null
  return {
    quota: pulse?.quota ?? null,
    quotaFailed: pulse?.quotaFailed ?? false,
    buckets: pulse?.buckets ?? null,
    machines,
    targetUnavailableReasons,
    capacityReadings: answer.profileKey === profileKey ? answer.capacityReadings : {},
    loadPerCore,
    nowMs: fetchedAt ?? Date.now(),
    fetchedAt,
    reload,
  }
}
