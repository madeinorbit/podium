import { machineFacts } from '@podium/client-graph/machine-facts'
import type { MachineModel } from '@podium/client-graph'
import { useRequestClient, useUi } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { headerModel } from '@podium/client-graph/header-companion'
import { headerRequests } from '@podium/client-graph/header-requests'
import { headerView } from '@podium/client-graph/header-views'
import { here } from '@podium/client-graph/lookup'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { CheckoutRepository, MachineId, MachineFacts } from '@podium/model/browser'
import { useEffect, useMemo } from 'react'
import type { Store } from './store'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

/** Stable actions and transport handles stay on the existing mutation owner.
 * No snapshot subscription and no legacy data derivation in the pool branch. */
export function useHeaderActions() {
  const requestClient = useRequestClient<import('@/app/trpc').Trpc>()
  const screenUi = useUi()

  return useMemo(() => {
    return {
      trpc: requestClient,
      setView: screenUi.setView,
      setSettingsTab: screenUi.setSettingsTab,
    }
  }, [requestClient, screenUi])
}

const readWorkingCount = (pool: MobxPool) => headerView(pool).workingCount()
export function useHeaderWorkingCount() {
  return useWorklistPoolProjection(readWorkingCount, 0)
}
/** Compatibility for count-only callers; selection has its own subscription. */
export function useHeaderStatus() {
  const workingCount = useHeaderWorkingCount()
  return useMemo(() => ({ workingCount }), [workingCount])
}

const readSelectedIssue = (pool: MobxPool) => headerModel(pool).selectedIssue
export function useHeaderSelectedIssue() {
  return useWorklistPoolProjection(readSelectedIssue, undefined)
}
const readWorkingIds = (pool: MobxPool) => headerView(pool).workingIds()
const EMPTY_IDS: readonly string[] = []
export function usePoolWorkingSessionIds() {
  return useWorklistPoolProjection(readWorkingIds, EMPTY_IDS)
}

/** Each displayed leaf requests its shared session, including a declared cold summary. */
export function usePoolHeaderSession(id: string) {
  const read = useMemo(
    () => (pool: MobxPool) => {
      const session = pool.sessionObject(id)
      try {
        return session.exists ? headerModel(pool).session(session) : undefined
      } catch (error) {
        if (error === LOADING) return undefined
        throw error
      }
    },
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}

const readView = (pool: MobxPool) => headerView(pool).row('window', 'window')?.view ?? 'workspace'
export function useHeaderView() {
  return useWorklistPoolProjection(readView, 'workspace' as Store['view'])
}

const readMetrics = (pool: MobxPool) => headerView(pool).metrics()
const EMPTY_METRICS: ReturnType<typeof readMetrics> = []
export function usePoolHeaderMetrics() {
  return useWorklistPoolProjection(readMetrics, EMPTY_METRICS)
}
const readIdleCapUnmet = (pool: MobxPool) => headerView(pool).idleCapUnmetCount()
export function usePoolIdleCapUnmetCount() {
  return useWorklistPoolProjection(readIdleCapUnmet, 0)
}
const readQuotas = (pool: MobxPool) => headerView(pool).quotas()
const EMPTY_QUOTAS: ReturnType<typeof readQuotas> = []
export function usePoolHeaderQuotas() {
  return useWorklistPoolProjection(readQuotas, EMPTY_QUOTAS)
}
const readConnection = (pool: MobxPool) => headerView(pool).connection()
export function usePoolHeaderConnection() {
  return useWorklistPoolProjection(readConnection, undefined)
}
const readMachineIds = (pool: MobxPool) => headerView(pool).metricIds()
export function usePoolMetricIds() {
  return useWorklistPoolProjection(readMachineIds, EMPTY_IDS)
}
/** One machine's live sample: the machine model's `metrics` field (POD-5798). */
export function usePoolMetric(id: string) {
  const read = useMemo(() => (pool: MobxPool) => headerView(pool).metric(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolPanelMetric(machineId: MachineId | undefined) {
  const read = useMemo(
    () => (pool: MobxPool) => headerView(pool).panelMetric(machineId),
    [machineId],
  )
  return useWorklistPoolProjection(read, undefined)
}
/** My fleet as plain values for React code: a new array when any machine's
 *  facts move (POD-6644). Observer screens read the models directly. */
const readMachines = (pool: MobxPool): MachineFacts[] => headerView(pool).machines().map(machineFacts)
const EMPTY_MACHINES: MachineFacts[] = []
export function usePoolMachines(): MachineFacts[] {
  return useWorklistPoolProjection(readMachines, EMPTY_MACHINES)
}
/** One machine's facts (online and presence are the LiveStore's), as a value
 *  that changes when one of them does (POD-6644). */
export function usePoolMachine(id: string | undefined) {
  const read = useMemo(
    () => (pool: MobxPool): MachineFacts | undefined => {
      const model = id ? here(pool.model('machine', id)) : undefined
      return model ? machineFacts(model as MachineModel) : undefined
    },
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}
/** The registered repositories and their worktrees, from the `checkout`
 *  records (POD-6644). */
const readRepositories = (pool: MobxPool): CheckoutRepository[] =>
  headerView(pool)
    .ids('repository')
    .flatMap((id) => {
      const repo = headerView(pool).row('repository', id)
      return repo ? [repo as CheckoutRepository] : []
    })
const EMPTY_REPOSITORIES: CheckoutRepository[] = []
export function usePoolRepositories(): CheckoutRepository[] {
  return useWorklistPoolProjection(readRepositories, EMPTY_REPOSITORIES)
}
export function usePoolHostAggregate(id: MachineId | undefined) {
  const read = useMemo(() => (pool: MobxPool) => headerView(pool).aggregate(id), [id])
  return useWorklistPoolProjection(read, {
    count: 0,
    idleSplit: { idle: 0, parkable: 0, protected: 0 },
    phases: { working: 0, idle: 0, waiting: 0, other: 0 },
  })
}

const readOffline = (pool: MobxPool) => headerView(pool).offlineMachines()
export function usePoolOfflineMachines() {
  return useWorklistPoolProjection(readOffline, EMPTY_MACHINES)
}
/** This device's unsent writes: a LiveStore condition (POD-5798). */
const readOutbox = (pool: MobxPool) => pool.live?.outbox.pending ?? 0
export function useHeaderOutboxSize() {
  return useWorklistPoolProjection(readOutbox, 0)
}

const readHistory = (pool: MobxPool) => headerView(pool).history()
export function usePoolConcurrencyHistory() {
  return useWorklistPoolProjection(readHistory, null)
}
const readLifecycle = (pool: MobxPool) => headerView(pool).lifecycle()
export function usePoolLifecycleSettings() {
  return useWorklistPoolProjection(readLifecycle, null)
}

/**
 * Only a mounted, visible header asks for its request answers (the concurrency
 * history and the lifecycle settings). Quota and usage are pushed (POD-5798).
 */
export function useHeaderRequests(visible: boolean): void {
  const pool = useWorklistPool()
  useEffect(() => (visible && pool ? headerRequests(pool)?.retain() : undefined), [pool, visible])
}
