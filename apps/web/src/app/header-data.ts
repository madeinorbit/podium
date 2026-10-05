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

const readStatus = (pool: MobxPool) => ({
  workingCount: pool.headerViews.workingCount(),
  issue: pool.headerViews.selectedIssue(),
})
const EMPTY_STATUS = { workingCount: 0, issue: undefined }
export function useHeaderStatus() {
  return useWorklistPoolProjection(readStatus, EMPTY_STATUS)
}

const readWorking = (pool: MobxPool) => pool.headerViews.working()
const EMPTY_WORKING: ReturnType<typeof readWorking> = []
export function usePoolWorkingSessions() {
  return useWorklistPoolProjection(readWorking, EMPTY_WORKING)
}

const readView = (pool: MobxPool) => pool.headerViews.row('window', 'window')?.view ?? 'workspace'
export function useHeaderView() {
  return useWorklistPoolProjection(readView, 'workspace' as Store['view'])
}

const readMetrics = (pool: MobxPool) => pool.headerViews.metrics()
const EMPTY_METRICS: ReturnType<typeof readMetrics> = []
export function usePoolHeaderMetrics() {
  return useWorklistPoolProjection(readMetrics, EMPTY_METRICS)
}
const readQuotas = (pool: MobxPool) => pool.headerViews.quotas()
const EMPTY_QUOTAS: ReturnType<typeof readQuotas> = []
export function usePoolHeaderQuotas() {
  return useWorklistPoolProjection(readQuotas, EMPTY_QUOTAS)
}
const readConnection = (pool: MobxPool) => pool.headerViews.connection()
export function usePoolHeaderConnection() {
  return useWorklistPoolProjection(readConnection, undefined)
}
const readMachineIds = (pool: MobxPool) => pool.headerViews.ids('hostMetric')
const EMPTY_IDS: string[] = []
export function usePoolMetricIds() {
  return useWorklistPoolProjection(readMachineIds, EMPTY_IDS)
}
export function usePoolMetric(id: string) {
  const read = useMemo(() => (pool: MobxPool) => pool.headerViews.row('hostMetric', id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolPanelMetric(machineId: MachineId | undefined) {
  const read = useMemo(
    () => (pool: MobxPool) => pool.headerViews.panelMetric(machineId),
    [machineId],
  )
  return useWorklistPoolProjection(read, undefined)
}
const readMachines = (pool: MobxPool) => pool.headerViews.machines()
const EMPTY_MACHINES: ReturnType<typeof readMachines> = []
export function usePoolMachines() {
  return useWorklistPoolProjection(readMachines, EMPTY_MACHINES)
}
export function usePoolMachine(id: string | undefined) {
  const read = useMemo(
    () => (pool: MobxPool) =>
      id ? (pool.row('machine', id) as MachineWire | undefined) : undefined,
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolHostAggregate(id: MachineId | undefined) {
  const read = useMemo(() => (pool: MobxPool) => pool.headerViews.aggregate(id), [id])
  return useWorklistPoolProjection(read, {
    count: 0,
    idleSplit: { idle: 0, parkable: 0, protected: 0 },
    phases: { working: 0, idle: 0, waiting: 0, other: 0 },
  })
}
export function usePoolReclaimCounts(afterDays: number) {
  const read = useMemo(
    () => (pool: MobxPool) => pool.headerViews.reclaimCounts(afterDays),
    [afterDays],
  )
  return useWorklistPoolProjection(read, {})
}

/** Load-panel session rows are loaded by the one reader in one batch. */
export function usePoolSessionLabels(ids: readonly string[]) {
  const signature = ids.join('\n')
  const read = useMemo(
    () => (pool: MobxPool) =>
      Object.fromEntries(
        signature
          .split('\n')
          .filter(Boolean)
          .map((id) => {
            const value = pool.headerViews.session(id)
            return [id, typeof value === 'object' && value ? value : undefined]
          }),
      ),
    [signature],
  )
  return useWorklistPoolProjection(read, {})
}

const readOffline = (pool: MobxPool) => pool.headerViews.offlineMachines()
export function usePoolOfflineMachines() {
  return useWorklistPoolProjection(readOffline, EMPTY_MACHINES)
}
const readOutbox = (pool: MobxPool) => pool.headerViews.row('window', 'window')?.outboxSize ?? 0
export function useHeaderOutboxSize() {
  return useWorklistPoolProjection(readOutbox, 0)
}

const readHistory = (pool: MobxPool) => pool.headerViews.history()
export function usePoolConcurrencyHistory() {
  return useWorklistPoolProjection(readHistory, null)
}
const readLifecycle = (pool: MobxPool) => {
  const settings = pool.headerViews.row('lifecycle', 'hosts')
  return settings ? { hibernation: settings.hibernation, worktreeGc: settings.worktreeGc } : null
}
export function usePoolLifecycleSettings() {
  return useWorklistPoolProjection(readLifecycle, null)
}
