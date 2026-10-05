import type { SessionView } from '@podium/client-core/session-values'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import type { MessageRecordWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'

export type NoticeSessionSummary = Partial<Pick<SessionView, 'name' | 'title' | 'cwd' | 'agentKind'>>

export interface NoticeRows {
  messageRecord: MessageRecordWire
  pendingInteraction: PendingInteractionWire
  outboxDeadLetter: OutboxDeadLetterEntry
  noticeCatalog: { messages: readonly string[]; interactions: readonly string[]; deadLetters: readonly string[] }
  noticeMessageCatalog: { messages: readonly string[] }
  noticeAttention: { count: number; newest: string | undefined }
  noticeRecoveryCatalog: { deadLetters: readonly string[] }
  noticeSession: { messages: readonly string[]; interactions: readonly string[] }
}
declare module './source-registry' { interface PoolSourceRows extends NoticeRows {} }
export type NoticeEntity = keyof NoticeRows
export const NOTICE_ENTITIES = ['messageRecord', 'pendingInteraction', 'outboxDeadLetter', 'noticeCatalog',
  'noticeMessageCatalog', 'noticeAttention', 'noticeRecoveryCatalog', 'noticeSession'] as const

/** Session identity/order is declared at attachment and maintained at addressed
 * ingestion. Payloads are borrowed by ID. Aggregate answers exist only during
 * observed demand; an imperative read borrows an answer for that read alone. */
export const NOTICE_SCHEMA = {
  messageRecord: { key: 'id', source: 'replica:messageRecords', residency: 'resident-on-demand' },
  pendingInteraction: { key: 'id', source: 'replica:pendingInteractions', residency: 'resident-on-demand' },
  outboxDeadLetter: { key: 'entry.mutationId', source: 'runtime:outbox', residency: 'resident-on-demand', relations: {} },
  noticeCatalog: { key: 'catalog', source: 'replica:identity', residency: 'while-observed', order: 'id ascending' },
  noticeMessageCatalog: { key: 'catalog', source: 'replica:messageRecords', predicate: 'isMessageRecordAttention(status)', order: 'createdAt descending, id ascending', residency: 'while-observed' },
  noticeAttention: { key: 'attention', source: 'noticeMessageCatalog', fields: ['count', 'newest'], residency: 'while-observed' },
  noticeRecoveryCatalog: { key: 'catalog', source: 'runtime:outbox', order: 'deadLetters order', residency: 'while-observed' },
  noticeSession: { key: 'sessionId', source: 'replica:session-relations', fields: ['id', 'sessionId', 'position'], order: 'replica order at attach/replace; new IDs append; retained IDs keep their position' },
  session: { source: 'pool:session', summary: ['sessionId', 'name', 'title', 'cwd', 'agentKind'] },
  window: { source: 'pool:window', fields: ['outboxSize'] },
} as const
export const NOTICE_SUMMARIES = { session: NOTICE_SCHEMA.session.summary }
export const NOTICE_RELATIONS = [
  { from: 'messageRecord', key: 'sessionId', name: 'session', to: 'session', inverse: 'messages' },
  { from: 'pendingInteraction', key: 'sessionId', name: 'session', to: 'session', inverse: 'interactions' },
] as const
