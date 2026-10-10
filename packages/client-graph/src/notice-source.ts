import './message-models'
import { ingestMessageRecords } from './message-models'
import { MobxPool } from './pool'
import { omitGone } from './lookup'
import type { RowRecord } from './shared/source'
import { defineSource } from './source-registry'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import { isMessageRecordAttention, type MessageRecordWire } from '@podium/model'
import { createDemandAtoms } from '@podium/mobx-helpers'
import { compareStructural, runInAction } from 'mobx'
import { NOTICE_RELATIONS, type NoticeEntity, type NoticeRows } from './notice-schema'
import { createKeyedAnswer } from './query-result'
import { LOADING, type Loaded } from './worklist/rollup'

export const NOTICE_SOURCE_KEY = 'notices'
type NoticeRuntime = Pick<ClientRuntime, 'replica' | 'outbox'>
type RecordEntity = 'messageRecord' | 'pendingInteraction'
type IdAnswer = ReturnType<typeof createKeyedAnswer<string>>
type SessionMembers = { messages: IdAnswer; interactions: IdAnswer }
interface Identity { sessionId: string | undefined; order: string; attentionAt: string | undefined }
interface Recovery { ids: readonly string[]; rows: Map<string, OutboxDeadLetterEntry> }
const CATALOG = 'noticeCatalog:catalog', ATTENTION = 'noticeAttention:attention'
const MESSAGES = 'noticeMessageCatalog:catalog', RECOVERY = 'noticeRecoveryCatalog:catalog'

// Reverse the timestamp key for the existing ascending identity tree. The end
// marker reverses prefix order too. Equal timestamps retain ID order.
function newestOrder(value: string): string {
  let key = ''
  for (let index = 0; index < value.length; index++) key += String.fromCharCode(0xffff - value.charCodeAt(index))
  return `${key}\uffff`
}

/** Declared session membership over the existing replica, not another row
 * store. Attachment/replacement index identities once; a delta indexes only
 * its addresses. Payloads are borrowed by ID. Atoms and aggregate identity
 * answers release with their last observer. */
export class NoticeSource {
  private readonly identities = { messageRecord: new Map<string, Identity>(), pendingInteraction: new Map<string, Identity>() }
  private readonly positions = { messageRecord: 0, pendingInteraction: 0 }
  private readonly sessions = new Map<string, SessionMembers>()
  private readonly watched = createDemandAtoms<string>((key) => key, {
    onObserved: (key) => {
      if (key.startsWith('outboxDeadLetter:')) this.recoveryReaders++
    },
    onUnobserved: (key) => {
      if (key.startsWith('outboxDeadLetter:')) this.recoveryReaders--
      this.releaseAnswers()
    },
  })
  private catalogAnswer: SessionMembers | undefined
  private attentionAnswer: IdAnswer | undefined
  private recoveryAnswer: Recovery | undefined
  private recoveryReaders = 0
  private pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  private ownsPool = true
  private loaded = false
  private imperativeLoad = false
  private outboxDirty = false
  private readonly source = defineSource({
    readById: this.readById.bind(this),
    refresh: this.refresh.bind(this),
    release: this.release.bind(this),
  })
  private get disposed(): boolean { return this.source.disposed }
  private readonly stops: (() => void)[]
  readonly counts = { batches: 0, collectionReads: 0, addressedRows: 0, payloadReads: 0,
    outboxReads: 0, catalogBuilds: 0, catalogUpdates: 0, attentionBuilds: 0, attentionUpdates: 0 }

  constructor(private readonly runtime: NoticeRuntime) {
    const { replica, outbox } = runtime
    if (!replica.row || !replica.subscribeAddressedBatch) throw new Error('Notices require the existing addressed replica')
    this.seed()
    this.stops = [replica.subscribeAddressedBatch(batch => {
      if (this.disposed) return
      runInAction(() => {
        if (batch.type === 'replace') {
          this.seed()
          this.loaded = false
          for (const atom of this.watched.values()) atom.reportChanged()
          if (this.watched.size) this.schedule()
          return
        }
        for (const address of batch.rows) {
          if (address.kind !== 'messageRecords' && address.kind !== 'pendingInteractions') continue
          const entity = address.kind === 'messageRecords' ? 'messageRecord' : 'pendingInteraction'
          this.change(entity, address.id, replica.row!(address.kind, address.id))
          this.counts.addressedRows++
          this.wake(`${entity}:${address.id}`)
        }
      })
    }), outbox.subscribe(() => {
      if (this.disposed || !this.recoveryAnswer) return
      this.outboxDirty = true
      this.schedule()
    })]
  }

  attach(pool: MobxPool): void {
    if (pool === this.pool) return
    const rows: RowRecord[] = []
    for (const [entity, kind] of [['messageRecord', 'messageRecord'], ['pendingInteraction', 'pendingInteraction']] as const)
      for (const id of this.identities[entity].keys())
        rows.push({ kind, id, value: omitGone(this.pool.row(kind, id)) as RowRecord['value'] })
    pool.apply({ type: 'update', rows })
    if (this.ownsPool) this.pool.dispose()
    this.pool = pool
    this.ownsPool = false
  }

  /** Display demand, independent of the ingestion identity index. */
  get demand() {
    return { keys: this.watched.size, catalog: !!this.catalogAnswer,
      attention: !!this.attentionAnswer, recovery: !!this.recoveryAnswer }
  }

  read(entity: NoticeEntity, id: string): Loaded<NoticeRows[NoticeEntity]> {
    return this.source.read(entity, id) as Loaded<NoticeRows[NoticeEntity]>
  }

  private readById(entity: NoticeEntity, id: string): Loaded<NoticeRows[NoticeEntity]> {
    if ((entity === 'noticeAttention' && id !== 'attention') ||
      ((entity === 'noticeCatalog' || entity === 'noticeMessageCatalog' || entity === 'noticeRecoveryCatalog') && id !== 'catalog')) return undefined
    const tracked = this.watch(entity, id)
    if (!this.loaded) {
      if (!tracked) this.imperativeLoad = true
      this.schedule()
      return LOADING
    }
    if (entity === 'messageRecord' || entity === 'pendingInteraction') {
      this.counts.payloadReads++
      return omitGone(this.pool.row(entity, id)) as Loaded<NoticeRows[NoticeEntity]>
    }
    if (entity === 'noticeSession') {
      const members = this.sessions.get(id)
      return members ? { messages: members.messages.snapshot(), interactions: members.interactions.snapshot() } : undefined
    }
    if (entity === 'noticeAttention') {
      const ids = this.attention().snapshot()
      return { count: ids.length, newest: ids[0] }
    }
    if (entity === 'noticeMessageCatalog') return { messages: this.attention().snapshot() }
    if (entity === 'noticeRecoveryCatalog') return { deadLetters: this.recovery().ids }
    if (entity === 'outboxDeadLetter') return this.recovery().rows.get(id)
    const catalog = this.catalog()
    return { messages: catalog.messages.snapshot(), interactions: catalog.interactions.snapshot(), deadLetters: this.recovery().ids }
  }

  private watch(entity: NoticeEntity, id: string): boolean {
    return this.watched.observe(`${entity}:${id}`)
  }

  private releaseAnswers(): void {
    if (!this.watched.has(CATALOG)) this.catalogAnswer = undefined
    if (!this.watched.has(ATTENTION) && !this.watched.has(MESSAGES)) this.attentionAnswer = undefined
    if (!this.watched.has(CATALOG) && !this.watched.has(RECOVERY) && !this.recoveryReaders) this.recoveryAnswer = undefined
  }
  private wake(key: string): void { this.watched.get(key)?.reportChanged() }

  private seed(): void {
    // A replacement publishes new facts without replacing retained identities.
    // Only IDs actually absent from the new replica lose their shared model.
    const messages = this.runtime.replica.rows('messageRecords')
    const interactions = this.runtime.replica.rows('pendingInteractions')
    this.counts.collectionReads += 2
    const replacement = { messageRecord: messages, pendingInteraction: interactions }
    const removed: RowRecord[] = []
    for (const entity of ['messageRecord', 'pendingInteraction'] as const) {
      const retained = new Set(replacement[entity].map(row => row.id))
      for (const id of this.identities[entity].keys())
        if (!retained.has(id)) removed.push({ kind: entity, id, value: undefined })
    }
    this.pool.apply({ type: 'update', rows: removed })
    this.identities.messageRecord.clear(); this.identities.pendingInteraction.clear(); this.sessions.clear()
    this.positions.messageRecord = 0; this.positions.pendingInteraction = 0
    this.catalogAnswer = undefined; this.attentionAnswer = undefined
    for (const entity of ['messageRecord', 'pendingInteraction'] as const)
      for (const row of replacement[entity]) this.change(entity, row.id, row)
  }

  private change(entity: RecordEntity, id: string, next: object | undefined): void {
    if (entity === 'messageRecord' && next) ingestMessageRecords(this.pool, [next as MessageRecordWire])
    else this.pool.apply({ type: 'update', rows: [{ kind: entity, id, value: next as RowRecord['value'] }] })
    const identities = this.identities[entity], previous = identities.get(id)
    if (!next && !previous) return
    const relation = NOTICE_RELATIONS.find(relation => relation.from === entity)!
    const target = next && Reflect.get(next, relation.key)
    const sessionId = typeof target === 'string' && target ? target : undefined
    const attentionAt = entity === 'messageRecord' && next && isMessageRecordAttention((next as MessageRecordWire).status)
      ? (next as MessageRecordWire).createdAt : undefined
    const current: Identity | undefined = next ? { sessionId, attentionAt,
      order: previous?.order ?? String(this.positions[entity]++).padStart(16, '0') } : undefined
    if (current) identities.set(id, current)
    else identities.delete(id)
    if (previous?.sessionId !== sessionId) {
      if (previous?.sessionId) {
        const members = this.sessions.get(previous.sessionId)!
        members[relation.inverse].delete(id)
        if (!members.messages.snapshot().length && !members.interactions.snapshot().length) this.sessions.delete(previous.sessionId)
        this.wake(`noticeSession:${previous.sessionId}`)
      }
      if (current?.sessionId) {
        let members = this.sessions.get(current.sessionId)
        if (!members) {
          members = { messages: createKeyedAnswer<string>(), interactions: createKeyedAnswer<string>() }
          this.sessions.set(current.sessionId, members)
        }
        members[relation.inverse].set(id, current.order, id)
        this.wake(`noticeSession:${current.sessionId}`)
      }
    }
    if (!!previous !== !!current && this.catalogAnswer) {
      const answer = this.catalogAnswer[relation.inverse]
      if (current) answer.set(id, id, id)
      else answer.delete(id)
      this.counts.catalogUpdates++
      this.wake(CATALOG)
    }
    if (previous?.attentionAt !== attentionAt && this.attentionAnswer) {
      const before = this.attentionAnswer.snapshot(), count = before.length, newest = before[0]
      if (attentionAt !== undefined) this.attentionAnswer.set(id, newestOrder(attentionAt), id)
      else this.attentionAnswer.delete(id)
      this.counts.attentionUpdates++
      const after = this.attentionAnswer.snapshot()
      if (count !== after.length || newest !== after[0]) this.wake(ATTENTION)
      this.wake(MESSAGES)
    }
  }

  private catalog(): SessionMembers {
    if (this.catalogAnswer) return this.catalogAnswer
    const answer = { messages: createKeyedAnswer<string>(), interactions: createKeyedAnswer<string>() }
    for (const relation of NOTICE_RELATIONS) for (const id of this.identities[relation.from].keys()) answer[relation.inverse].set(id, id, id)
    this.counts.catalogBuilds++
    if (this.watched.has(CATALOG)) this.catalogAnswer = answer
    return answer
  }

  private attention(): IdAnswer {
    if (this.attentionAnswer) return this.attentionAnswer
    const answer = createKeyedAnswer<string>()
    for (const [id, row] of this.identities.messageRecord) if (row.attentionAt !== undefined) answer.set(id, newestOrder(row.attentionAt), id)
    this.counts.attentionBuilds++
    if (this.watched.has(ATTENTION) || this.watched.has(MESSAGES)) this.attentionAnswer = answer
    return answer
  }

  private recovery(): Recovery {
    if (this.recoveryAnswer) return this.recoveryAnswer
    const parked = this.runtime.outbox.deadLetters()
    this.counts.outboxReads++
    const answer = { ids: parked.map(row => row.entry.mutationId), rows: new Map(parked.map(row => [row.entry.mutationId, row])) }
    if (this.watched.has(CATALOG) || this.watched.has(RECOVERY) || this.recoveryReaders) this.recoveryAnswer = answer
    return answer
  }

  private schedule(): void {
    this.source.schedule()
  }

  private refresh(): void {
    if (!this.watched.size && !this.imperativeLoad) return
    this.imperativeLoad = false
    runInAction(() => {
      if (this.outboxDirty && this.recoveryAnswer) {
        const previous = this.recoveryAnswer
        this.recoveryAnswer = undefined
        const next = this.recovery()
        if (!compareStructural(previous.ids, next.ids)) { this.wake(RECOVERY); this.wake(CATALOG) }
        for (const id of new Set([...previous.ids, ...next.ids])) {
          if (!compareStructural(previous.rows.get(id), next.rows.get(id))) this.wake(`outboxDeadLetter:${id}`)
        }
      }
      this.outboxDirty = false
      if (!this.loaded) {
        this.loaded = true
        for (const atom of this.watched.values()) atom.reportChanged()
      }
      this.counts.batches++
    })
  }

  dispose(): void {
    this.source.dispose()
  }

  private release(): void {
    for (const stop of this.stops) stop()
    if (this.ownsPool) this.pool.dispose()
    this.watched.clear(); this.sessions.clear(); this.identities.messageRecord.clear(); this.identities.pendingInteraction.clear()
    this.catalogAnswer = undefined; this.attentionAnswer = undefined; this.recoveryAnswer = undefined
  }
}
