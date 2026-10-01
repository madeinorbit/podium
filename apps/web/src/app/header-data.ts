import { useStoreHandle } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/store'
import { measureLegacyHeader } from '@podium/client-core/perf'
import { isAgentConfirmedComputing, type MachineId } from '@podium/model/browser'
import type { MobxPool } from '@podium/client-graph'
import { useMemo } from 'react'
import { headerDataLayer } from '@/lib/header-data-layer'
import { useNow } from '@/lib/useNow'
import { useReplicaIssues, useStoreSelector, type Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'

type HeaderActions = Pick<Store, 'trpc' | 'setView' | 'setSettingsTab'>

/** Stable actions and transport handles stay on the existing mutation owner.
 * No snapshot subscription and no legacy data derivation in the pool branch. */
function usePoolActions() {
  const owner = useStoreHandle<Store['trpc']>()
  return useMemo(() => {
    const state = owner.getSnapshot()
    return { trpc: state.trpc, setView: state.setView, setSettingsTab: state.setSettingsTab }
  }, [owner])
}
function useLegacyActions() {
  return useStoreSelector((state) => ({ trpc: state.trpc, setView: state.setView, setSettingsTab: state.setSettingsTab }), shallowEqual)
}
export function useHeaderActions(): HeaderActions {
  const useRead = headerDataLayer() === 'pool' ? usePoolActions : useLegacyActions
  return useRead()
}

const readStatus = (pool: MobxPool) => ({ workingSessions: pool.headerViews.working(), issue: pool.headerViews.selectedIssue() })
const EMPTY_STATUS = { workingSessions: [], issue: undefined }
function usePoolStatus() { return useWorklistPoolProjection(readStatus, EMPTY_STATUS) }
function useLegacyStatus() {
  const { sessions, selectedIssueId, trpc: owner } = useStoreSelector((state) => ({ sessions: state.sessions, selectedIssueId: state.selectedIssueId, trpc: state.trpc }), shallowEqual)
  const issues = useReplicaIssues()
  const now = useNow(60_000)
  return {
    workingSessions: measureLegacyHeader(owner, 'workingSessions', () => sessions.filter((session) => isAgentConfirmedComputing(session, now))),
    issue: selectedIssueId ? issues.find((issue) => issue.id === selectedIssueId && !issue.deletedAt) : undefined,
  }
}
export function useHeaderStatus() {
  const useRead = headerDataLayer() === 'pool' ? usePoolStatus : useLegacyStatus
  return useRead()
}

const readView = (pool: MobxPool) => pool.headerViews.row('window', 'window')?.view ?? 'workspace'
function usePoolView() { return useWorklistPoolProjection(readView, 'workspace' as Store['view']) }
function useLegacyView() { return useStoreSelector((state) => state.view) }
export function useHeaderView() {
  const useRead = headerDataLayer() === 'pool' ? usePoolView : useLegacyView
  return useRead()
}

const readMetrics = (pool: MobxPool) => pool.headerViews.metrics()
const EMPTY_METRICS: ReturnType<typeof readMetrics> = []
export function usePoolHeaderMetrics() { return useWorklistPoolProjection(readMetrics, EMPTY_METRICS) }
const readQuotas = (pool: MobxPool) => pool.headerViews.quotas()
const EMPTY_QUOTAS: ReturnType<typeof readQuotas> = []
export function usePoolHeaderQuotas() { return useWorklistPoolProjection(readQuotas, EMPTY_QUOTAS) }
const readConnection = (pool: MobxPool) => pool.headerViews.connection()
export function usePoolHeaderConnection() { return useWorklistPoolProjection(readConnection, undefined) }
const readMachineIds = (pool: MobxPool) => pool.headerViews.ids('hostMetric')
const EMPTY_IDS: string[] = []
export function usePoolMetricIds() { return useWorklistPoolProjection(readMachineIds, EMPTY_IDS) }
export function usePoolMetric(id: string) {
  const read = useMemo(() => (pool: MobxPool) => pool.headerViews.row('hostMetric', id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolPanelMetric(machineId: MachineId | undefined) {
  const read = useMemo(() => (pool: MobxPool) => {
    const id = machineId ?? pool.headerViews.ids('hostMetric')[0]
    return id ? pool.headerViews.row('hostMetric', id) : undefined
  }, [machineId])
  return useWorklistPoolProjection(read, undefined)
}
const readMachines = (pool: MobxPool) => pool.headerViews.machines()
const EMPTY_MACHINES: ReturnType<typeof readMachines> = []
export function usePoolMachines() { return useWorklistPoolProjection(readMachines, EMPTY_MACHINES) }
export function usePoolMachine(id: string | undefined) {
  const read = useMemo(() => (pool: MobxPool) => id ? pool.headerViews.row('machine', id) : undefined, [id])
  return useWorklistPoolProjection(read, undefined)
}
export function usePoolHostAggregate(id: MachineId | undefined) {
  const read = useMemo(() => (pool: MobxPool) => pool.headerViews.aggregate(id), [id])
  return useWorklistPoolProjection(read, { count: 0, idleSplit: { idle: 0, parkable: 0, protected: 0 }, phases: { working: 0, idle: 0, waiting: 0, other: 0 } })
}
export function usePoolReclaimCounts(afterDays: number) {
  const read = useMemo(() => (pool: MobxPool) => pool.headerViews.reclaimCounts(afterDays), [afterDays])
  return useWorklistPoolProjection(read, {})
}
const readFolded = (pool: MobxPool) => pool.headerViews.folded()
export function usePoolFolded() {
  return useWorklistPoolProjection(readFolded, { root: undefined, progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }, live: 0, working: 0, needs: 0, loading: true })
}
const readShipping = (pool: MobxPool) => pool.headerViews.shipping()
export function usePoolShipping() { return useWorklistPoolProjection(readShipping, { unfinishedCount: 0, decisionCount: 0 }) }

/** Load-panel session rows are loaded by the one reader in one batch. */
export function usePoolSessionLabels(ids: readonly string[]) {
  const signature = ids.join('\n')
  const read = useMemo(() => (pool: MobxPool) => Object.fromEntries(signature.split('\n').filter(Boolean).map((id) => {
    const value = pool.headerViews.session(id)
    return [id, typeof value === 'object' && value ? value : undefined]
  })), [signature])
  return useWorklistPoolProjection(read, {})
}

const readOffline = (pool: MobxPool) => pool.headerViews.offlineMachines()
export function usePoolOfflineMachines() { return useWorklistPoolProjection(readOffline, EMPTY_MACHINES) }
const readOutbox = (pool: MobxPool) => pool.headerViews.row('window', 'window')?.outboxSize ?? 0
function usePoolOutbox() { return useWorklistPoolProjection(readOutbox, 0) }
function useLegacyOutbox() { return useStoreSelector((state) => state.outboxSize) }
export function useHeaderOutboxSize() {
  const useRead = headerDataLayer() === 'pool' ? usePoolOutbox : useLegacyOutbox
  return useRead()
}

const readHistory = (pool: MobxPool) => pool.headerViews.history()
export function usePoolConcurrencyHistory() { return useWorklistPoolProjection(readHistory, null) }
const readLifecycle = (pool: MobxPool) => {
  const settings = pool.headerViews.row('lifecycle', 'hosts')
  return settings ? { hibernation: settings.hibernation, worktreeGc: settings.worktreeGc } : null
}
export function usePoolLifecycleSettings() { return useWorklistPoolProjection(readLifecycle, null) }
