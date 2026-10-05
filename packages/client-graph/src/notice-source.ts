import type { ClientRuntime } from '@podium/client-core/engine'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import { isMessageRecordAttention, type MessageRecordWire } from '@podium/model'
import { _isComputingDerivation, compareStructural, createAtom, type IAtom, runInAction } from 'mobx'
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
const RECORD_KINDS = { messageRecord: 'messageRecords', pendingInteraction: 'pendingInteractions' } as const
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
  private readonly watched = new Map<string, IAtom>()
  private catalogAnswer: SessionMembers | undefined
  private attentionAnswer: IdAnswer | undefined
  private recoveryAnswer: Recovery | undefined
  private recoveryReaders = 0
  private loaded = false
  private imperativeLoad = false
  private scheduled = false
  private outboxDirty = false
  private disposed = false
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

  /** Display demand, independent of the ingestion identity index. */
  get demand() {
    return { keys: this.watched.size, catalog: !!this.catalogAnswer,
      attention: !!this.attentionAnswer, recovery: !!this.recoveryAnswer }
  }

  read(entity: NoticeEntity, id: string): Loaded<NoticeRows[NoticeEntity]> {
    if (this.disposed) return LOADING
    const tracked = this.watch(entity, id)
    if (!this.loaded) {
      if (!tracked) this.imperativeLoad = true
      this.schedule()
      return LOADING
    }
    if (entity === 'messageRecord' || entity === 'pendingInteraction') {
      this.counts.payloadReads++
      return this.runtime.replica.row!(RECORD_KINDS[entity], id)
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
    if (!_isComputingDerivation()) return false
    const key = `${entity}:${id}`
    let atom = this.watched.get(key)
    if (!atom) {
      const created = createAtom(key, undefined, () => {
        if (this.watched.get(key) !== created) return
        this.watched.delete(key)
        if (entity === 'outboxDeadLetter') this.recoveryReaders--
        this.releaseAnswers()
      })
      atom = created
      this.watched.set(key, atom)
      if (entity === 'outboxDeadLetter') this.recoveryReaders++
    }
    return atom.reportObserved()
  }

  private releaseAnswers(): void {
    if (!this.watched.has(CATALOG)) this.catalogAnswer = undefined
    if (!this.watched.has(ATTENTION) && !this.watched.has(MESSAGES)) this.attentionAnswer = undefined
    if (!this.watched.has(CATALOG) && !this.watched.has(RECOVERY) && !this.recoveryReaders) this.recoveryAnswer = undefined
  }
  private wake(key: string): void { this.watched.get(key)?.reportChanged() }

  private seed(): void {
    this.identities.messageRecord.clear(); this.identities.pendingInteraction.clear(); this.sessions.clear()
    this.positions.messageRecord = 0; this.positions.pendingInteraction = 0
    this.catalogAnswer = undefined; this.attentionAnswer = undefined
    for (const entity of ['messageRecord', 'pendingInteraction'] as const) {
      for (const row of this.runtime.replica.rows(RECORD_KINDS[entity])) this.change(entity, row.id, row)
      this.counts.collectionReads++
    }
  }

  private change(entity: RecordEntity, id: string, next: object | undefined): void {
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
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed || (!this.watched.size && !this.imperativeLoad)) return
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
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    this.watched.clear(); this.sessions.clear(); this.identities.messageRecord.clear(); this.identities.pendingInteraction.clear()
    this.catalogAnswer = undefined; this.attentionAnswer = undefined; this.recoveryAnswer = undefined
  }
}
