import type { PodiumClientApi } from '@podium/client-core/api'

type PodiumSettings = Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>

import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow } from 'mobx'
import { LOADING } from './loading'
import { here } from './lookup'
import type { ModelOf } from './models'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import {
  ingestRequested,
  ingestSettings,
  type RequestedEntity,
  requestedRecords,
  SETTINGS_RECORD_ID,
} from './requested-record-source'

export {
  ingestRequested,
  ingestSettings,
  type RequestedEntity,
  SETTINGS_RECORD_ID,
} from './requested-record-source'

/** Request answers contain membership only; record facts are always pool models.
 * RequestAnswer fences superseded responses before ingestion, as well as on close. */
export class RecordRequest<E extends RequestedEntity> extends RequestAnswer<readonly string[]> {
  constructor(readonly pool: MobxPool, readonly entity: E, private readonly key: (row: PoolRows[E]) => string) {
    super()
    requestedRecords(pool)
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
  @lazy get pending(): boolean {
    return (this.answer ?? []).some(id => this.pool.model(this.entity, id) === LOADING)
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
  constructor(readonly pool: MobxPool) { super(); requestedRecords(pool) }
  @action read(read: () => Promise<PodiumSettings>): Promise<void> {
    return this.load(read, false, settings => { ingestSettings(this.pool, settings); return SETTINGS_RECORD_ID })
  }
  @lazy get model() { return here(this.pool.model('podiumSettings', SETTINGS_RECORD_ID)) }
  dispose() { this.close() }
}
