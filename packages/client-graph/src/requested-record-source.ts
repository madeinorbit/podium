import './requested-models'
import { here } from './lookup'
import type { MobxPool, PoolRows } from './pool'
import type { PoolSource } from './source-registry'

export type RequestedEntity = 'account' | 'member' | 'device'
declare module './source-registry' {
  interface PoolSourceRows extends Pick<PoolRows, RequestedEntity> {}
}
const ENTITIES = ['account', 'member', 'device'] as const

/** Passive ingestion shared by header samples and requested views. This source
 * keeps records through a core-feed replacement without owning requests. */
export function requestedRecords(pool: MobxPool) {
  return pool.sources.view('requested.records', () => {
    const source: PoolSource<RequestedEntity> = {
      read: (entity, id) => here(pool.row(entity, id)),
      dispose() {},
    }
    pool.sources.register(ENTITIES, source)
    return source
  })
}

export function ingestRequested<E extends RequestedEntity>(
  pool: MobxPool,
  entity: E,
  rows: readonly PoolRows[E][],
  key: (row: PoolRows[E]) => string,
): string[] {
  requestedRecords(pool)
  pool.apply({
    type: 'update',
    rows: rows.map((value) => ({ kind: entity, id: key(value), value })),
  })
  return rows.map(key)
}
