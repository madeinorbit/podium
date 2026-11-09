import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import { observe, runInAction } from 'mobx'
import { allResidentSessions } from './enumerate'
import { headerEntities } from './header-entities'
import { attachHeaderRequests, type HeaderRequestsApi } from './header-requests'
import { type HeaderEntity, type HeaderRecord, type HeaderRows } from './header-schema'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'

/** Read-side bridge owned by the existing StoreProvider attachment. Live
 * readings (metrics, quota, connection) are not copied here: they are
 * LiveStore conditions (POD-5798). The header's two request answers belong to
 * {@link HeaderRequests}, which only a mounted header retains. */
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
      // Live machine rows win over their feed companions (POD-5661, POD-5704);
      // repositories have no companions and apply directly.
      if (entity === 'machine') pool.ingestLiveMachines(records)
      else headerEntities(pool).apply(records)
      if (ids) headerEntities(pool).order(entity, ids)
    })
  }
  const window = Object.defineProperties(
    {},
    {
      view: { enumerable: true, get: () => runtime.ui.view },
      paneA: { enumerable: true, get: () => runtime.ui.paneA },
      fileTabs: { enumerable: true, get: () => runtime.ui.fileTabList },
    },
  ) as HeaderRows['window']
  function shipping(): void {
    replace(
      'shipOrder',
      runtime.replica.rows('shipOrders').map((order) => [order.id, order]),
    )
  }
  runInAction(() => {
    for (const [id, row] of allResidentSessions(pool))
      headerEntities(pool).change('session', id, row)
  })
  const offSessions = observe(pool.tables.session, (change) => {
    headerEntities(pool).change(
      'session',
      change.name,
      change.type === 'delete'
        ? undefined
        : (omitGone(pool.row('session', change.name)) as object | undefined),
    )
  })
  keyed('machine', 'machines')
  keyed('repository', 'repos')
  replace('window', [['window', window]])
  shipping()
  attachHeaderRequests(pool, runtime.access.trpc as unknown as HeaderRequestsApi)
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
    runtime.onList('machines', (change) => keyed('machine', 'machines', change)),
    runtime.onList('repos', (change) => keyed('repository', 'repos', change)),
  ]
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops) stop()
    known.clear()
  }
}
