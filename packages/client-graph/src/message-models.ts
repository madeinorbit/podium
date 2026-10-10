import { messageRecordRowId, readDeliveryStatus, type MessageRecordWire } from '@podium/model'
import type { ClientRuntime } from '@podium/client-core/engine'
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
  constructor(id: string, host: ModelHost) { super('messageRecord', id, host) }
}
export interface MessageModel extends Readonly<MessagePoolRow> {}

class InteractionModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('pendingInteraction', id, host) }
}
export type PendingInteractionModel = InteractionModel & Readonly<PendingInteractionWire>

function fields(schema: 'MessageRecordWire' | 'MessageLedgerWire' | 'PendingInteractionWire',
  arrivesOn: 'replica:messageRecords' | 'replica:pendingInteractions' | 'request:messages.ledger',
  definitions: Record<string, FieldType>,
  options: { optional?: readonly string[]; nullable?: readonly string[] } = {}): Record<string, FieldSpec> {
  return Object.fromEntries(Object.entries(definitions).map(([name, type]) => [name, {
    type, source: { schema, arrivesOn },
    ...(options.optional?.includes(name) ? { optional: true } : {}),
    ...(options.nullable?.includes(name) ? { nullable: true } : {}),
  }]))
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
      }, { optional: ['sessionId', 'senderUserId', 'attachments', 'reason', 'transcriptItem', 'retractRequestedAt', 'noticeDismissedAt'] }),
      // Requested ledger metadata
      ...fields('MessageLedgerWire', 'request:messages.ledger', {
        threadId: 'id', inReplyTo: 'id', from: 'string', to: 'string', kind: 'enum', urgency: 'enum', lifecycle: 'enum',
        queuePosition: 'number', ackedBy: 'id', deliveredAt: 'isoDate', deliveredTo: 'id', expiresAt: 'isoDate',
        clampedFrom: 'string', hop: 'number', readAt: 'isoDate', deadLetteredAt: 'isoDate',
        deliveryDeferredAt: 'isoDate', deliveryDeferredReason: 'string',
      }, {
        optional: ['threadId', 'inReplyTo', 'from', 'to', 'kind', 'urgency', 'lifecycle', 'queuePosition', 'ackedBy',
          'deliveredAt', 'deliveredTo', 'expiresAt', 'clampedFrom', 'hop', 'readAt', 'deadLetteredAt', 'deliveryDeferredAt', 'deliveryDeferredReason'],
        nullable: ['inReplyTo', 'ackedBy', 'deliveredAt', 'deliveredTo', 'expiresAt', 'clampedFrom', 'readAt', 'deadLetteredAt', 'deliveryDeferredAt', 'deliveryDeferredReason'],
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
        payload: 'object', fingerprint: 'string', policyVerdict: 'enum', expiresAt: 'isoDate',
        // Resolution
        status: 'enum', answeredAt: 'isoDate', answeredBy: 'enum', answer: 'object', deliveredVia: 'enum', expiredAt: 'isoDate',
      }, { optional: ['policyVerdict', 'expiresAt', 'answeredAt', 'answeredBy', 'answer', 'deliveredVia', 'expiredAt'] }),
    }, relations: {}, cold: { kind: 'never', why: 'The synced pending ask set stays resident.' },
  },
} satisfies Pick<ModelSchema, 'messageRecord' | 'pendingInteraction'>
registerModels(schema, { messageRecord: MessageModel, pendingInteraction: InteractionModel })

/** Request and replica records enter the same existing tables. No request cache.
 * A record projection replaces optional chat fields too, so stale confirmation
 * references cannot survive a new server answer. Ledger metadata is preserved.
 * Request callers provide the current replica row: a late response cannot
 * overwrite an authoritative pushed record (the declared component precedence). */
export type CurrentMessageRecord = (id: string) => MessageRecordWire | undefined
const CHAT_OPTIONAL = ['attachments', 'reason', 'transcriptItem', 'retractRequestedAt', 'noticeDismissedAt'] as const
const LEDGER_OPTIONAL = ['queuePosition', 'readAt', 'deadLetteredAt', 'deliveryDeferredAt', 'deliveryDeferredReason'] as const
function replaceChatFields(previous: Partial<MessagePoolRow>, record: MessageRecordWire): MessagePoolRow {
  const next = { ...previous }
  for (const field of CHAT_OPTIONAL) delete next[field]
  // Apply the same tolerant wire decoding as Sends; there is one status in the table.
  return { ...next, ...record, status: readDeliveryStatus(record.status) }
}
export function ingestMessageRecords(pool: MobxPool, records: readonly MessageRecordWire[], current?: CurrentMessageRecord): void {
  pool.apply({ type: 'update', rows: records.map(record => {
    const previous = (pool.tables.messageRecord.get(record.id) as MessagePoolRow | undefined) ?? {}
    return { kind: 'messageRecord', id: record.id, value: replaceChatFields(previous, current?.(record.id) ?? record) }
  }) })
}
export function ingestLedgerMessages(pool: MobxPool, records: readonly MessageLedgerWire[], current?: CurrentMessageRecord): void {
  pool.apply({ type: 'update', rows: records.map(({ deliveryStatus, ...record }) => {
    const previous = { ...pool.tables.messageRecord.get(record.id) } as Partial<MessagePoolRow>
    for (const field of LEDGER_OPTIONAL) delete previous[field]
    const next: MessagePoolRow = { ...previous, ...record, status: readDeliveryStatus(deliveryStatus) }
    const synced = current?.(record.id)
    return { kind: 'messageRecord', id: record.id, value: synced ? replaceChatFields(next, synced) : next }
  }) })
}


/** The replica addresses messages by session/sender/message, while pool readers
 * use the message ID. Identity fields already in the table provide that join. */
export function currentMessageRecord(pool: MobxPool, replica: ClientRuntime['replica'], id: string): MessageRecordWire | undefined {
  const row = pool.tables.messageRecord.get(id) as MessagePoolRow | undefined
  return row?.sessionId && row.senderUserId ? replica.row?.('messageRecords', messageRecordRowId({
    sessionId: row.sessionId, senderUserId: row.senderUserId, messageId: id,
  })) : undefined
}
