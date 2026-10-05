import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import { deadLetterDeliveryLine, isMessageRecordAttention } from '@podium/model'
import type { MobxPool } from './pool'
import { pendingInteractionCard } from './notice-card'
import type { HeaderRows } from './header-schema'
import type { NoticeRows, NoticeSessionSummary } from './notice-schema'
import { LOADING } from './worklist/rollup'

/** All payload and summary reads pass through the pool's one reader. No cold
 * payloads enter the notice indexes; a missing summary returns pending while
 * the pool coalesces its loads. Recovery never consults its target. */
function messageNotice(pool: MobxPool, id: string): { notice?: MessageNotice; pending: number; labelPending?: boolean } {
  const record = pool.row('messageRecord', id)
  if (record === LOADING) return { pending: 1 }
  if (!record || !isMessageRecordAttention(record.status)) return { pending: 0 }
  const session = pool.row('session', record.sessionId, 'summary') as NoticeSessionSummary | typeof LOADING | undefined
  const label = !session ? 'a closed session' : session === LOADING ? 'Loading session…'
    : session.name?.trim() || session.title?.trim() || session.cwd?.split('/').filter(Boolean).pop() || session.agentKind
  const first = record.body.trim().split('\n')[0] ?? ''
  return { pending: session === LOADING ? 1 : 0, labelPending: session === LOADING, notice: {
    messageId: record.id, sessionId: record.sessionId, sessionLabel: label ?? 'a closed session',
    excerpt: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    status: record.status as MessageNotice['status'], createdAt: record.createdAt,
    line: record.status === 'unknown' ? 'not confirmed — it may or may not have arrived'
      : record.status === 'expired' ? 'not delivered · it waited too long' : deadLetterDeliveryLine(record.reason),
  } }
}

export function noticeMessageCount(pool: MobxPool): number {
  const attention = pool.row('noticeAttention', 'attention')
  return attention && attention !== LOADING ? attention.count : 0
}

export function noticeNewestMessage(pool: MobxPool) {
  const attention = pool.row('noticeAttention', 'attention')
  if (!attention || attention === LOADING) return { count: 0, notice: undefined, pending: attention === LOADING ? 1 : 0 }
  const newest = attention.newest ? messageNotice(pool, attention.newest) : { notice: undefined, pending: 0 }
  return { count: attention.count, notice: newest.notice, pending: newest.pending }
}

export function noticeMessages(pool: MobxPool) {
  const catalog = pool.row('noticeMessageCatalog', 'catalog')
  const notices: MessageNotice[] = [], pendingIds: string[] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.messages) {
    const row = messageNotice(pool, id)
    pending += row.pending
    if (row.labelPending) pendingIds.push(id)
    if (row.notice) notices.push(row.notice)
  }
  notices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { notices, pending, pendingIds }
}

export function noticeInteractions(pool: MobxPool, sessionId: string) {
  const index = pool.row('noticeSession', sessionId)
  const rows: NoticeRows['pendingInteraction'][] = []
  let pending = index === LOADING ? 1 : 0
  if (index && index !== LOADING) for (const id of index.interactions) {
    const row = pool.row('pendingInteraction', id)
    if (row === LOADING) pending++
    else if (row?.status === 'asked') rows.push(row)
  }
  // Notice cards previously started in ID order; keep that timestamp tie rule
  // while chat/superagent use the declared replica insertion order.
  rows.sort((a, b) => a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const cards: PendingInteractionCard[] = rows.map(pendingInteractionCard)
  return { cards, pending }
}

export function noticeRecovery(pool: MobxPool) {
  const catalog = pool.row('noticeRecoveryCatalog', 'catalog')
  const deadLetters: NoticeRows['outboxDeadLetter'][] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.deadLetters) {
    const row = pool.row('outboxDeadLetter', id)
    if (row === LOADING) pending++
    else if (row) deadLetters.push(row)
  }
  return { deadLetters, pending }
}

export function noticeContinuity(pool: MobxPool) {
  const recovery = pool.row('noticeRecoveryCatalog', 'catalog')
  const window = pool.row('window', 'window') as HeaderRows['window'] | undefined
  return { outboxSize: window?.outboxSize ?? 0, deadLetters: recovery && recovery !== LOADING ? recovery.deadLetters.length : 0, pending: recovery === LOADING ? 1 : 0 }
}
