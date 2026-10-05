import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import { observe, reaction, runInAction } from 'mobx'
import { allResidentSessions } from './enumerate'
import {
  HEADER_SCHEMA,
  type HeaderEntity,
  type HeaderRecord,
  type HeaderRows,
} from './header-schema'
import type { MobxPool } from './pool'
import { createFieldInputs } from './shared/field-inputs'

/** Read-side bridge owned by the existing StoreProvider attachment. The metric
 * channel never subscribes to snapshots. Polling has one owner per principal,
 * and late replies cannot enter a disposed pool. */
export function attachHeaderSource<TApi extends PodiumClientApi>(
  pool: MobxPool,
  runtime: ClientRuntime<TApi>,
): () => void {
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
  // Keyed (POD-5433): machines and repos arrive by id, with only the rows
  // that changed; the window wakes on its own four locals.
  function keyed(
    entity: 'machine' | 'repository',
    name: 'machines' | 'repos',
    change?: KeyedListChange,
  ): void {
    if (disposed) return
    const ids = change === undefined || change.order ? runtime.listIds(name) : undefined
    const changed = change === undefined ? ids! : [...change.ids]
    const records = changed.map((id) => ({
      kind: entity,
      id,
      value: runtime.listRow(name, id),
    })) as HeaderRecord[]
    runInAction(() => {
      pool.header.apply(records)
      if (ids) pool.header.order(entity, ids)
    })
  }
  const windowKeys = HEADER_SCHEMA.window.fields
  const inputs = createFieldInputs<HeaderRows['window']>(windowKeys, {}, 'headerWindow')
  function locals(changed?: ReadonlySet<string>): void {
    runInAction(() => {
      for (const key of windowKeys)
        if (!changed || changed.has(key)) inputs.set(key, runtime.readLocal(key))
    })
  }
  function metrics(): void {
    replace(
      'hostMetric',
      runtime.hostMetrics
        .getSnapshot()
        .map((metric) => [metric.machineId ?? metric.hostname, metric]),
    )
  }
  function shipping(): void {
    replace(
      'shipOrder',
      runtime.replica.rows('shipOrders').map((order) => [order.id, order]),
    )
  }
  const api = runtime.access.trpc
  let quotaPending = false
  async function quota(): Promise<void> {
    if (quotaPending || disposed) return
    quotaPending = true
    try {
      const rows = await api.quota.summary.query()
      if (disposed) return
      pool.header.received.quotas = rows
      replace(
        'quota',
        rows.map((row) => [row.machineId, row]),
      )
    } catch {
      /* Preserve the last reading, as the legacy indicator does. */
    } finally {
      quotaPending = false
    }
  }
  runInAction(() => {
    for (const [id, row] of allResidentSessions(pool)) pool.header.change('session', id, row)
  })
  const offSessions = observe(pool.tables.session, (change) => {
    pool.header.change(
      'session',
      change.name,
      change.type === 'delete'
        ? undefined
        : (pool.row('session', change.name) as object | undefined),
    )
  })
  keyed('machine', 'machines')
  keyed('repository', 'repos')
  locals()
  replace('window', [['window', inputs.row]])
  metrics()
  shipping()
  replace('connection', [['server', runtime.hub.connectionHealth()]])
  const stops = [
    offSessions,
    runtime.replica.subscribeAddressedBatch!((batch) => {
      if (batch.type === 'replace') {
        shipping()
        return
      }
      const records: HeaderRecord<'shipOrder'>[] = []
      const ids = known.get('shipOrder')!
      for (const record of batch.rows) {
        if (record.kind !== 'shipOrders') continue
        const value = runtime.replica.row!('shipOrders', record.id)
        if (value) ids.add(record.id)
        else ids.delete(record.id)
        records.push({ kind: 'shipOrder', id: record.id, value })
      }
      pool.header.apply(records)
    }),
    runtime.onLocals(windowKeys, locals),
    runtime.onList('machines', (change) => keyed('machine', 'machines', change)),
    runtime.onList('repos', (change) => keyed('repository', 'repos', change)),
    runtime.hostMetrics.subscribe(metrics),
    runtime.hub.onConnectionHealth((health) => replace('connection', [['server', health]])),
  ]
  void quota()
  void api.settings.get
    .query()
    .then((settings) => {
      if (disposed) return
      pool.header.received.lifecycle = settings
      replace('lifecycle', [['hosts', settings]])
    })
    .catch(() => {})
  // This endpoint is optional on the structural client API; the web supplies it.
  const historyApi = (
    api.sessions as
      | (typeof api.sessions & {
          concurrencyHistory?: { query(): Promise<import('./header-schema').HeaderRows['history']> }
        })
      | undefined
  )?.concurrencyHistory
  let historyPending = false
  async function history(): Promise<void> {
    if (!historyApi || disposed || historyPending) return
    historyPending = true
    try {
      const reading = await historyApi.query()
      if (disposed) return
      if (
        reading.buckets.length === 24 &&
        Number.isFinite(reading.bucketMs) &&
        reading.bucketMs > 0 &&
        Number.isInteger(reading.peak) &&
        reading.peak >= 0 &&
        reading.buckets.every(
          (bucket) =>
            Number.isInteger(bucket.count) &&
            bucket.count >= 0 &&
            Number.isFinite(Date.parse(bucket.start)),
        )
      ) {
        pool.header.received.history = reading
        replace('history', [['fleet', reading]])
      }
    } catch {
    } finally {
      historyPending = false
    }
  }
  stops.push(
    reaction(
      () => pool.headerViews.workingCount(),
      () => {
        void history()
      },
    ),
  )
  void history()
  const historyTimer = setInterval(() => {
    void history()
  }, 5 * 60_000)
  const timer = setInterval(() => {
    void quota()
  }, 60_000)
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    clearInterval(historyTimer)
    for (const stop of stops) stop()
    known.clear()
  }
}
