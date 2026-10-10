import { lazy } from '@podium/mobx-helpers'
import type { MessageRecordWire } from '@podium/model'
import type { MessageLedgerWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { EntityModel, registerModels, type ModelHost } from './models'
import type { MobxPool } from './pool'
import type { FieldSpec, FieldType, ModelSchema } from './shared/schema'

/** One canonical status, plus the fields carried by either server projection. */
export type MessagePoolRow = Partial<Omit<MessageLedgerWire, 'deliveryStatus'>> & Partial<MessageRecordWire> & {
  id: string; body: string; createdAt: string; status: MessageRecordWire['status']
}
export class MessageModel extends EntityModel {
  @lazy override get row() { return super.row }
  constructor(id: string, host: ModelHost) { super('messageRecord', id, host) }
}
export interface MessageModel extends Readonly<MessagePoolRow> {}

class InteractionModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('pendingInteraction', id, host) }
}
export type PendingInteractionModel = InteractionModel & Readonly<PendingInteractionWire>

function fields(schema: 'MessageRecordWire' | 'MessageLedgerWire' | 'PendingInteractionWire',
  arrivesOn: 'replica:messageRecords' | 'replica:pendingInteractions' | 'request:messages.ledger',
  definitions: Record<string, FieldType>): Record<string, FieldSpec> {
  return Object.fromEntries(Object.entries(definitions).map(([name, type]) => [name, { type, source: { schema, arrivesOn } }]))
}
const schema = {
  messageRecord: {
    key: 'id', why: 'One message shared by chat, notices and requested ledger windows.',
    components: {
      record: { schema: 'MessageRecordWire', arrivesOn: 'replica:messageRecords', joinKey: 'id', precedence: 1, why: 'Current chat delivery projection.' },
      ledger: { schema: 'MessageLedgerWire', arrivesOn: 'request:messages.ledger', joinKey: 'id', precedence: 0, why: 'Requested mail metadata.' },
    },
    fields: {
      // Identity and chat delivery
      ...fields('MessageRecordWire', 'replica:messageRecords', {
        id: 'id', sessionId: 'id', senderUserId: 'id', body: 'string', attachments: 'object',
        createdAt: 'isoDate', status: 'enum', reason: 'string', transcriptItem: 'object',
        retractRequestedAt: 'isoDate', noticeDismissedAt: 'isoDate',
      }),
      // Requested ledger metadata
      ...fields('MessageLedgerWire', 'request:messages.ledger', {
        threadId: 'id', inReplyTo: 'id', from: 'string', to: 'string', kind: 'enum', urgency: 'enum', lifecycle: 'enum',
        queuePosition: 'number', ackedBy: 'id', deliveredAt: 'isoDate', deliveredTo: 'id', expiresAt: 'isoDate',
        clampedFrom: 'string', hop: 'number', readAt: 'isoDate', deadLetteredAt: 'isoDate',
        deliveryDeferredAt: 'isoDate', deliveryDeferredReason: 'string',
      }),
    }, relations: {}, cold: { kind: 'never', why: 'Synced working set and requested ledger records use existing resident tables.' },
  },
  pendingInteraction: {
    key: 'id', why: 'One pending ask shared by chat and aggregate notices.',
    components: { interaction: { schema: 'PendingInteractionWire', arrivesOn: 'replica:pendingInteractions', joinKey: 'id', precedence: 0, why: 'Protocol discriminated interaction wire.' } },
    fields: {
      // Identity and request
      ...fields('PendingInteractionWire', 'replica:pendingInteractions', {
        id: 'id', sessionId: 'id', kind: 'enum', askedAt: 'isoDate', source: 'enum', answerable: 'enum',
        payload: 'object', fingerprint: 'string',
        // Resolution
        status: 'enum', answeredAt: 'isoDate', answeredBy: 'enum', answer: 'object',
      }),
    }, relations: {}, cold: { kind: 'never', why: 'The synced pending ask set stays resident.' },
  },
} satisfies Pick<ModelSchema, 'messageRecord' | 'pendingInteraction'>
registerModels(schema, { messageRecord: MessageModel, pendingInteraction: InteractionModel })

/** Request and replica records enter the same existing tables. No request cache.
 * A record projection replaces optional chat fields too, so stale confirmation
 * references cannot survive a new server answer. Ledger metadata is preserved. */
export function ingestMessageRecords(pool: MobxPool, records: readonly MessageRecordWire[]): void {
  pool.apply({ type: 'update', rows: records.map(record => {
    const row = (pool.tables.messageRecord.get(record.id) as MessagePoolRow | undefined) ?? {}
    return { kind: 'messageRecord', id: record.id, value: { ...row,
      attachments: undefined, reason: undefined, transcriptItem: undefined,
      retractRequestedAt: undefined, noticeDismissedAt: undefined, ...record } }
  }) })
}
export function ingestLedgerMessages(pool: MobxPool, records: readonly MessageLedgerWire[]): void {
  pool.apply({ type: 'update', rows: records.map(({ deliveryStatus, ...record }) => {
    const previous = pool.tables.messageRecord.get(record.id) as MessagePoolRow | undefined
    return { kind: 'messageRecord', id: record.id, value: {
      ...previous, ...record,
      status: deliveryStatus,
    } }
  }) })
}
