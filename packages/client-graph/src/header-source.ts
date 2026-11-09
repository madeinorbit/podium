import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { observe, runInAction } from 'mobx'
import { allResidentSessions } from './enumerate'
import { headerEntities } from './header-entities'
import { attachHeaderRequests, type HeaderRequestsApi } from './header-requests'
import type { HeaderEntity, HeaderRecord, HeaderRows } from './header-schema'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'
import { bindCheckoutRecords, checkoutRepositoryId } from './shared/checkout-repositories'

/** Read-side bridge owned by the existing StoreProvider attachment. Live
 * readings (metrics, quota, connection) are not copied here: they are
 * LiveStore conditions (POD-5798). The header's two request answers belong to
 * {@link HeaderRequests}, which only a mounted header retains. */
export function attachHeaderSource<TApi extends PodiumClientApi>(
  pool: MobxPool,
  runtime: ClientRuntime<TApi>,
): () => void {
  bindCheckoutRecords(pool, runtime.replica)
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
  // Machines are feed records (the row source installs them). Repositories
  // are derived from the `checkout` records (POD-6644).
  let repositoriesFrom: unknown
  const written = new Map<string, string>()
  function repositories(): void {
    const rows = runtime.replica.rows('checkouts')
    if (rows === repositoriesFrom) return
    repositoriesFrom = rows
    pool.checkoutRecordsChanged()
    // One derivation pass per checkout change (they are rare: a worktree made
    // or removed, a branch checked out), but only the repositories whose facts
    // moved are written, so one change redraws one repository row.
    const next = pool.checkoutRepositories
    const keep = new Set<string>()
    const records: HeaderRecord[] = []
    for (const repo of next) {
      const id = checkoutRepositoryId(repo)
      const shape = JSON.stringify(repo)
      keep.add(id)
      if (written.get(id) === shape && headerEntities(pool).tables.repository.has(id)) continue
      written.set(id, shape)
      records.push({ kind: 'repository', id, value: repo } as HeaderRecord)
    }
    if (disposed) return
    runInAction(() => {
      // Also reconcile the table itself: an earlier apply may have thrown.
      for (const id of headerEntities(pool).tables.repository.keys())
        if (!keep.has(id))
          records.push({ kind: 'repository', id, value: undefined } as HeaderRecord)
      for (const id of [...written.keys()]) if (!keep.has(id)) written.delete(id)
      if (records.length) headerEntities(pool).apply(records)
      headerEntities(pool).order('repository', [...keep])
    })
    known.set('repository', keep)
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
      runtime.root.replica.rows('shipOrders').map((order) => [order.id, order]),
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
  repositories()
  replace('window', [['window', window]])
  shipping()
  attachHeaderRequests(pool, runtime.root.api as unknown as HeaderRequestsApi)
  const stops = [
    offSessions,
    runtime.root.replica.subscribeAddressedBatch!((batch) => {
      if (batch.type === 'replace') {
        shipping()
        repositories()
        return
      }
      if (batch.rows.some((record) => record.kind === 'checkouts')) repositories()
      const records: HeaderRecord<'shipOrder'>[] = []
      const ids = known.get('shipOrder')!
      for (const record of batch.rows) {
        if (record.kind !== 'shipOrders') continue
        const value = runtime.root.replica.row!('shipOrders', record.id)
        if (value) ids.add(record.id)
        else ids.delete(record.id)
        records.push({ kind: 'shipOrder', id: record.id, value })
      }
      headerEntities(pool).apply(records)
    }),
  ]
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops) stop()
    known.clear()
  }
}
