import { omitGone } from '@podium/client-graph/lookup'
import { headerModel } from '@podium/client-graph/header-companion'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { headerView } from '@podium/client-graph/header-views'
import { useStoreHandle } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import type { MachineId, MachineWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'

/** Stable actions and transport handles stay on the existing mutation owner.
 * No snapshot subscription and no legacy data derivation in the pool branch. */
export function useHeaderActions() {
  const owner = useStoreHandle<Store['trpc']>()
  return useMemo(() => {
    const state = owner.access
    return { trpc: state.trpc, setView: state.setView, setSettingsTab: state.setSettingsTab }
  }, [owner])
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
  const read = useMemo(() => (pool: MobxPool) => {
    const session = pool.sessionObject(id)
    try { return session.exists ? headerModel(pool).session(session) : undefined }
    catch (error) { if (error === LOADING) return undefined; throw error }
  }, [id])
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
const readMachineIds = (pool: MobxPool) => headerView(pool).ids('hostMetric')
export function usePoolMetricIds() {
  return useWorklistPoolProjection(readMachineIds, EMPTY_IDS)
}
export function usePoolMetric(id: string) {
  const read = useMemo(() => (pool: MobxPool) => headerView(pool).row('hostMetric', id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolPanelMetric(machineId: MachineId | undefined) {
  const read = useMemo(
    () => (pool: MobxPool) => headerView(pool).panelMetric(machineId),
    [machineId],
  )
  return useWorklistPoolProjection(read, undefined)
}
const readMachines = (pool: MobxPool) => headerView(pool).machines()
const EMPTY_MACHINES: ReturnType<typeof readMachines> = []
export function usePoolMachines() {
  return useWorklistPoolProjection(readMachines, EMPTY_MACHINES)
}
export function usePoolMachine(id: string | undefined) {
  const read = useMemo(
    () => (pool: MobxPool) =>
      id ? (omitGone(pool.row('machine', id)) as MachineWire | undefined) : undefined,
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
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
const readOutbox = (pool: MobxPool) => headerView(pool).row('window', 'window')?.outboxSize ?? 0
export function useHeaderOutboxSize() {
  return useWorklistPoolProjection(readOutbox, 0)
}

const readHistory = (pool: MobxPool) => headerView(pool).history()
export function usePoolConcurrencyHistory() {
  return useWorklistPoolProjection(readHistory, null)
}
const readLifecycle = (pool: MobxPool) => {
  const settings = headerView(pool).row('lifecycle', 'hosts')
  return settings ? { hibernation: settings.hibernation, worktreeGc: settings.worktreeGc } : null
}
export function usePoolLifecycleSettings() {
  return useWorklistPoolProjection(readLifecycle, null)
}
