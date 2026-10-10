import './requested-models'
import type { PodiumClientApi } from '@podium/client-core/api'
type PodiumSettings = Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>
import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow } from 'mobx'
import type { ModelOf } from './models'
import { here } from './lookup'
import { LOADING } from './loading'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import type { PoolSource } from './source-registry'

export type RequestedEntity = 'account' | 'member' | 'device' | 'podiumSettings'
declare module './source-registry' {
  interface PoolSourceRows extends Pick<PoolRows, RequestedEntity> {}
}
const ENTITIES = ['account', 'member', 'device', 'podiumSettings'] as const
/** Marks independently requested rows as owned through a core-feed replacement.
 * All payloads live in the generic tables; this owner keeps no record mirror. */
function records(pool: MobxPool) {
  return pool.sources.view('requested.records', () => {
    const source: PoolSource<RequestedEntity> = {
      read: (entity, id) => here(pool.row(entity, id)), dispose() {},
    }
    pool.sources.register(ENTITIES, source)
    return source
  })
}
export function ingestRequested<E extends RequestedEntity>(pool: MobxPool, entity: E,
  rows: readonly PoolRows[E][], key: (row: PoolRows[E]) => string): string[] {
  records(pool)
  pool.apply({ type: 'update', rows: rows.map(value => ({ kind: entity, id: key(value), value })) })
  return rows.map(key)
}
export const SETTINGS_RECORD_ID = 'viewer'
export function ingestSettings(pool: MobxPool, settings: PodiumSettings): void {
  records(pool)
  pool.apply({ type: 'update', rows: [{ kind: 'podiumSettings', id: SETTINGS_RECORD_ID, value: settings }] })
}

/** Request answers contain membership only; record facts are always pool models.
 * RequestAnswer fences superseded responses before ingestion, as well as on close. */
export class RecordRequest<E extends RequestedEntity> extends RequestAnswer<readonly string[]> {
  constructor(readonly pool: MobxPool, readonly entity: E, private readonly key: (row: PoolRows[E]) => string) {
    super()
    records(pool)
  }
  @action read(read: () => Promise<readonly PoolRows[E][]>): Promise<void> {
    return this.load(read, false, rows => {
      const ids = ingestRequested(this.pool, this.entity, rows, this.key)
      const present = new Set(ids)
      const removed = (this.answer ?? []).filter(id => !present.has(id))
      if (removed.length) this.pool.apply({ type: 'update', rows: removed.map(id => ({ kind: this.entity, id, value: undefined })) })
      return ids
    })
  }
  @lazy({ equals: compareShallow }) get models(): ModelOf[E][] {
    return (this.answer ?? []).flatMap(id => {
      const answer = this.pool.model(this.entity, id)
      // A requested list omits gone records, and keeps its pending state separate.
      return answer === LOADING ? [] : here(answer) ?? []
    })
  }
  dispose() { this.close() }
}

export class SettingsRecordRequest extends RequestAnswer<string> {
  constructor(readonly pool: MobxPool) { super(); records(pool) }
  @action read(read: () => Promise<PodiumSettings>): Promise<void> {
    return this.load(read, false, settings => { ingestSettings(this.pool, settings); return SETTINGS_RECORD_ID })
  }
  @lazy get model() { return here(this.pool.model('podiumSettings', SETTINGS_RECORD_ID)) }
  dispose() { this.close() }
}
