import { ConversationIndexRecord } from '@podium/model/browser'
import { action, compareShallow, observable } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'

/** Stored fields cite @podium/model's ConversationIndexRecord zod schema,
 * the conversations.search result. Native ids are scoped to their machine. */
export type ConversationIndexRow = ConversationIndexRecord
export const CONVERSATION_SEARCH_SCHEMA = {
  key: 'machineId,id',
  source: 'request:conversations.search',
  model: 'ConversationIndexRecord',
  fields: Object.keys(ConversationIndexRecord.shape) as (keyof ConversationIndexRow)[],
} as const
export const conversationRecordId = (row: Pick<ConversationIndexRow, 'machineId' | 'id'>): string =>
  JSON.stringify([row.machineId ?? '', row.id])

declare module './source-registry' {
  interface PoolSourceRows {
    conversation: ConversationIndexRow
  }
}

export interface ConversationRecord extends ConversationIndexRow {}
export class ConversationRecord {
  constructor(
    readonly key: string,
    private readonly records: ConversationRecords,
  ) {}
  field(name: keyof ConversationIndexRow): unknown {
    return this.records.rows.get(this.key)?.[name]
  }
}
for (const field of CONVERSATION_SEARCH_SCHEMA.fields)
  Object.defineProperty(ConversationRecord.prototype, field, {
    get(this: ConversationRecord) {
      return this.field(field)
    },
  })

/** Pool-owned record table and identity map. Search views retain ids only. */
export class ConversationRecords {
  readonly rows = observable.map<string, ConversationIndexRow>(undefined, { deep: false })
  private readonly models = new Map<string, ConversationRecord>()
  private disposed = false
  @action ingest(rows: readonly ConversationIndexRow[]): string[] {
    if (this.disposed) return []
    return rows.map((row) => {
      const key = conversationRecordId(row)
      const previous = this.rows.get(key)
      if (!previous?.updatedAt || !row.updatedAt || previous.updatedAt <= row.updatedAt)
        this.rows.set(key, row)
      return key
    })
  }
  read(_entity: 'conversation', id: string) {
    return this.rows.get(id)
  }
  model(id: string): ConversationRecord | undefined {
    if (!this.rows.has(id)) return undefined
    let model = this.models.get(id)
    if (!model) {
      model = new ConversationRecord(id, this)
      this.models.set(id, model)
    }
    return model
  }
  @action dispose(): void {
    this.disposed = true
    this.rows.clear()
    this.models.clear()
  }
}
export function conversationRecords(pool: MobxPool): ConversationRecords {
  return pool.sources.view('conversation-records', () => {
    const records = new ConversationRecords()
    pool.sources.register(['conversation'], records)
    return records
  })
}
export interface ConversationSearchInput {
  query?: string
  projectPath?: string
  limit: number
}
export class ConversationSearchView extends RequestAnswer<string[]> {
  constructor(
    readonly pool: MobxPool,
    private readonly query: (input: ConversationSearchInput) => Promise<ConversationIndexRow[]>,
  ) {
    super()
  }
  search(input: ConversationSearchInput): Promise<void> {
    return this.load(
      () => this.query(input),
      false,
      (rows) => conversationRecords(this.pool).ingest(rows),
    )
  }
  @lazy({ equals: compareShallow }) get hits(): ConversationRecord[] {
    return (this.answer ?? []).flatMap((id) => {
      const model = this.pool.model('conversation', id)
      return model ? [model] : []
    })
  }
}
