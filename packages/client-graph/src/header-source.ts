import { observe, reaction, runInAction } from 'mobx'
import { allResidentSessions } from './enumerate'
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
    runInAction(() => {
      pool.header.apply(records)
      pool.header.order(entity, [...next])
    })
  }
  let previousMachines: Store<TApi>['machines'] | undefined
  let previousRepos: Store<TApi>['repos'] | undefined
  let previousWindow: object | undefined
  function locals(): void {
    const state = runtime.getSnapshot()
    if (state.machines !== previousMachines) {
      previousMachines = state.machines
      replace('machine', state.machines.map((machine) => [machine.id, machine]))
    }
    if (state.repos !== previousRepos) {
      previousRepos = state.repos
      replace('repository', state.repos.map((repo) => [JSON.stringify([repo.machineId ?? '', repo.path]), repo]))
    }
    const window = { view: state.view, paneA: state.paneA, fileTabs: state.fileTabs,
      outboxSize: state.outboxSize }
    if (previousWindow && Object.entries(window).every(([key, value]) => Object.is((previousWindow as Record<string, unknown>)[key], value))) return
    previousWindow = window
    replace('window', [['window', window]])
  }
  function metrics(): void {
    replace('hostMetric', runtime.hostMetrics.getSnapshot().map((metric) => [metric.machineId ?? metric.hostname, metric]))
  }
  function shipping(): void {
    replace('shipOrder', runtime.replica.rows('shipOrders').map((order) => [order.id, order]))
  }
  const api = runtime.getSnapshot().trpc
  let quotaPending = false
  async function quota(): Promise<void> {
    if (quotaPending || disposed) return
    quotaPending = true
    try {
      const rows = await api.quota.summary.query()
      if (disposed) return
      pool.header.received.quotas = rows
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
  shipping()
  replace('connection', [['server', runtime.hub.connectionHealth()]])
  const stops = [offSessions, runtime.replica.subscribeAddressedBatch!((batch) => {
    if (batch.type === 'replace' || batch.rows.some((record) => record.kind === 'shipOrders')) shipping()
  }), runtime.subscribe(locals), runtime.hostMetrics.subscribe(metrics),
    runtime.hub.onConnectionHealth((health) => replace('connection', [['server', health]]))]
  void quota()
  void api.settings.get.query().then((settings) => {
    if (disposed) return
    pool.header.received.lifecycle = settings
    replace('lifecycle', [['hosts', settings]])
  }).catch(() => {})
  // This endpoint is optional on the structural client API; the web supplies it.
  const historyApi = (api.sessions as typeof api.sessions & { concurrencyHistory?: { query(): Promise<import('./header-schema').HeaderRows['history']> } } | undefined)?.concurrencyHistory
  let historyPending = false
  async function history(): Promise<void> {
    if (!historyApi || disposed || historyPending) return
    historyPending = true
    try {
      const reading = await historyApi.query()
      if (disposed) return
      if (reading.buckets.length === 24 && Number.isFinite(reading.bucketMs) && reading.bucketMs > 0 && Number.isInteger(reading.peak) && reading.peak >= 0 && reading.buckets.every((bucket) => Number.isInteger(bucket.count) && bucket.count >= 0 && Number.isFinite(Date.parse(bucket.start)))) {
        pool.header.received.history = reading
        replace('history', [['fleet', reading]])
      }
    } catch {} finally { historyPending = false }
  }
  stops.push(reaction(() => pool.headerViews.working().length, () => { void history() }))
  void history()
  const historyTimer = setInterval(() => { void history() }, 5 * 60_000)
  const timer = setInterval(() => { void quota() }, 60_000)
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    clearInterval(historyTimer)
    for (const stop of stops) stop()
    known.clear()
  }
}
