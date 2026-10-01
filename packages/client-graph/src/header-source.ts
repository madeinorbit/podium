import { observe, runInAction } from 'mobx'
import { allResidentSessions } from './header-enumerate'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { MobxPool } from './pool'
import type { HeaderEntity, HeaderRecord } from './header-schema'

/** Read-side bridge owned by the existing StoreProvider attachment. The metric
 * channel never subscribes to snapshots. Polling has one owner per principal,
 * and late replies cannot enter a disposed pool. */
export function attachHeaderSource<TApi extends PodiumClientApi>(pool: MobxPool, runtime: ClientRuntime<TApi>): () => void {
  let disposed = false
  const known = new Map<HeaderEntity, Set<string>>()
  function replace(entity: HeaderEntity, entries: readonly (readonly [string, object])[]): void {
    if (disposed) return
    const next = new Set(entries.map(([id]) => id))
    const records = entries.map(([id, value]) => ({ kind: entity, id, value })) as HeaderRecord[]
    for (const id of known.get(entity) ?? []) {
      if (!next.has(id)) records.push({ kind: entity, id, value: undefined })
    }
    known.set(entity, next)
    pool.header.apply(records)
  }
  let previousMachines: Store<TApi>['machines'] | undefined
  let previousWindow: object | undefined
  function locals(): void {
    const state = runtime.getSnapshot()
    if (state.machines !== previousMachines) {
      previousMachines = state.machines
      replace('machine', state.machines.map((machine) => [machine.id, machine]))
    }
    const window = { view: state.view, paneA: state.paneA, fileTabs: state.fileTabs,
      outboxSize: state.outboxSize, shipOrders: state.shipOrders }
    if (previousWindow && Object.entries(window).every(([key, value]) => Object.is((previousWindow as Record<string, unknown>)[key], value))) return
    previousWindow = window
    replace('window', [['window', window]])
  }
  function metrics(): void {
    replace('hostMetric', runtime.hostMetrics.getSnapshot().map((metric) => [metric.machineId ?? metric.hostname, metric]))
  }
  const api = runtime.getSnapshot().trpc
  let quotaPending = false
  async function quota(): Promise<void> {
    if (quotaPending || disposed) return
    quotaPending = true
    try {
      const rows = await api.quota.summary.query()
      replace('quota', rows.map((row) => [row.machineId, row]))
    } catch { /* Preserve the last reading, as the legacy indicator does. */ }
    finally { quotaPending = false }
  }
  runInAction(() => {
    for (const [id, row] of allResidentSessions(pool)) pool.header.change('session', id, row)
  })
  const offSessions = observe(pool.tables.session, (change) => {
    pool.header.change('session', change.name, change.type === 'delete' ? undefined : pool.row('session', change.name) as object | undefined)
  })
  locals()
  metrics()
  replace('connection', [['server', runtime.hub.connectionHealth()]])
  const stops = [offSessions, runtime.subscribe(locals), runtime.hostMetrics.subscribe(metrics),
    runtime.hub.onConnectionHealth((health) => replace('connection', [['server', health]]))]
  void quota()
  const timer = setInterval(() => { void quota() }, 60_000)
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    for (const stop of stops) stop()
    known.clear()
  }
}
