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
  noticeSession: { messages: readonly string[]; interactions: readonly string[] }
}
declare module './source-registry' { interface PoolSourceRows extends NoticeRows {} }
export type NoticeEntity = keyof NoticeRows
export const NOTICE_ENTITIES = ['messageRecord', 'pendingInteraction', 'outboxDeadLetter', 'noticeCatalog', 'noticeSession'] as const

/** These small projections are resident after one batched demand. Session
 * indexes contain only resident projection IDs. Recovery never reads a target:
 * its authored input and normalized refusal are the entire recovery record. */
export const NOTICE_SCHEMA = {
  messageRecord: { key: 'id', source: 'replica:messageRecords', residency: 'resident-on-demand' },
  pendingInteraction: { key: 'id', source: 'replica:pendingInteractions', residency: 'resident-on-demand' },
  outboxDeadLetter: { key: 'entry.mutationId', source: 'runtime:outbox', residency: 'resident-on-demand', relations: {} },
  noticeCatalog: { key: 'catalog', source: 'resident:membership', residency: 'on-demand' },
  noticeSession: { key: 'sessionId', source: 'resident:session-relations', residency: 'on-demand' },
  session: { source: 'pool:session', summary: ['sessionId', 'name', 'title', 'cwd', 'agentKind'] },
  window: { source: 'pool:window', fields: ['outboxSize'] },
} as const
export const NOTICE_SUMMARIES = { session: NOTICE_SCHEMA.session.summary }
export const NOTICE_RELATIONS = [
  { from: 'messageRecord', key: 'sessionId', name: 'session', to: 'session', inverse: 'messages' },
  { from: 'pendingInteraction', key: 'sessionId', name: 'session', to: 'session', inverse: 'interactions' },
] as const
