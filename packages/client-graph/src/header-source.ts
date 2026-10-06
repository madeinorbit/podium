import { headerEntities } from './header-entities'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime, HeaderInputKey, KeyedListChange } from '@podium/client-core/engine'
import { observe, runInAction } from 'mobx'
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
 * channels never subscribe to snapshots. Network samples arrive from the
 * runtime service; this adapter owns neither network calls nor timers. */
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
    runInAction(() => {
      // A previous apply may have thrown after writing some rows. Reconcile
      // the actual table so its next successful sample removes those leftovers.
      // The keys() read is observable state: it stays inside this action so
      // the strict diagnostic trap (observableRequiresReaction) stays quiet.
      for (const id of headerEntities(pool).tables[entity].keys()) {
        if (!next.has(id)) records.push({ kind: entity, id, value: undefined })
      }
      headerEntities(pool).apply(records)
      headerEntities(pool).order(entity, [...next])
    })
    known.set(entity, next)
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
      // Live machine rows merge under their feed companions (POD-5661);
      // repositories have no companions and apply directly.
      if (entity === 'machine') pool.ingestLiveMachines(records)
      else headerEntities(pool).apply(records)
      if (ids) headerEntities(pool).order(entity, ids)
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
  function sample(key: HeaderInputKey): void {
    if (disposed) return
    try {
      if (key === 'quota') {
        const rows = runtime.headerInputs.read('quota')
        if (!rows) return
        replace('quota', rows.map(row => [row.machineId, row]))
        headerEntities(pool).received.quotas = rows
      } else if (key === 'history') {
        const reading = runtime.headerInputs.read('history')
        if (!reading) return
        replace('history', [['fleet', reading]])
        headerEntities(pool).received.history = reading
      } else {
        const settings = runtime.headerInputs.read('lifecycle')
        if (!settings) return
        replace('lifecycle', [['hosts', settings]])
        headerEntities(pool).received.lifecycle = settings
      }
    } catch (error) {
      pool.diagnostics.report(`header:${key}`, error)
    }
  }
  runInAction(() => {
    for (const [id, row] of allResidentSessions(pool)) headerEntities(pool).change('session', id, row)
  })
  const offSessions = observe(pool.tables.session, (change) => {
    headerEntities(pool).change(
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
      headerEntities(pool).apply(records)
    }),
    runtime.onLocals(windowKeys, locals),
    runtime.onList('machines', (change) => keyed('machine', 'machines', change)),
    runtime.onList('repos', (change) => keyed('repository', 'repos', change)),
    runtime.hostMetrics.subscribe(metrics),
    runtime.hub.onConnectionHealth((health) => replace('connection', [['server', health]])),
  ]
  for (const key of ['quota', 'history', 'lifecycle'] as const) {
    stops.push(runtime.headerInputs.onInput(key, () => sample(key)))
    sample(key)
  }
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops) stop()
    known.clear()
  }
}
