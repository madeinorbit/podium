import type { PendingInteractionModel } from './message-models'
import { noticeCompanions, type NoticeMessage } from './notice-companions'
import { omitGone } from './lookup'
import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import { isMessageRecordAttention } from '@podium/model'
import type { HeaderRows } from './header-schema'
import type { NoticeRows } from './notice-schema'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

/** All payload and summary reads pass through the pool's one reader. No cold
 * payloads enter the notice indexes; a missing summary returns pending while
 * the pool coalesces its loads. Recovery never consults its target. */
function messageNotice(pool: MobxPool, id: string): { notice?: NoticeMessage; pending: number; labelPending?: boolean } {
  const message = omitGone(pool.model('messageRecord', id))
  if (message === LOADING) return { pending: 1 }
  if (!message || !isMessageRecordAttention(message.status)) return { pending: 0 }
  const notice = noticeCompanions(pool).message(message)
  const labelPending = pool.resident('session', notice.sessionId, 'summary-fields') === 'loading'
  return { notice, pending: labelPending ? 1 : 0, labelPending }
}

export function noticeMessageCount(pool: MobxPool): number {
  const attention = omitGone(pool.row('noticeAttention', 'attention'))
  return attention && attention !== LOADING ? attention.count : 0
}

export function noticeNewestMessage(pool: MobxPool) {
  const attention = omitGone(pool.row('noticeAttention', 'attention'))
  if (!attention || attention === LOADING) return { count: 0, notice: undefined, pending: attention === LOADING ? 1 : 0 }
  const newest = attention.newest ? messageNotice(pool, attention.newest) : { notice: undefined, pending: 0 }
  return { count: attention.count, notice: newest.notice, pending: newest.pending }
}

/** Newest notices a shipped full-log reader may observe per run. The dialog
 * demand stays O(window): the catalog arrives newest-first, so the slice
 * happens before any payload or label read, and the sort covers the window. */
export const NOTICE_MESSAGE_WINDOW = 100

export function noticeMessages(pool: MobxPool, limit = Number.POSITIVE_INFINITY) {
  const catalog = omitGone(pool.row('noticeMessageCatalog', 'catalog'))
  const notices: NoticeMessage[] = [], pendingIds: string[] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.messages.slice(0, limit)) {
    const row = messageNotice(pool, id)
    pending += row.pending
    if (row.labelPending) pendingIds.push(id)
    if (row.notice) notices.push(row.notice)
  }
  notices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { notices, pending, pendingIds }
}

export function noticeInteractions(pool: MobxPool, sessionId: string) {
  const index = omitGone(pool.row('noticeSession', sessionId))
  const rows: PendingInteractionModel[] = []
  let pending = index === LOADING ? 1 : 0
  if (index && index !== LOADING) for (const id of index.interactions) {
    const row = omitGone(pool.model('pendingInteraction', id))
    if (row === LOADING) pending++
    else if (row?.status === 'asked') rows.push(row)
  }
  // Notice cards previously started in ID order; keep that timestamp tie rule
  // while chat/superagent use the declared replica insertion order.
  rows.sort((a, b) => a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const cards: PendingInteractionCard[] = rows.map(row => noticeCompanions(pool).interaction(row))
  return { cards, pending }
}

export function noticeRecovery(pool: MobxPool) {
  const catalog = omitGone(pool.row('noticeRecoveryCatalog', 'catalog'))
  const deadLetters: NoticeRows['outboxDeadLetter'][] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.deadLetters) {
    const row = omitGone(pool.row('outboxDeadLetter', id))
    if (row === LOADING) pending++
    else if (row) deadLetters.push(row)
  }
  return { deadLetters, pending }
}

export function noticeContinuity(pool: MobxPool) {
  const recovery = omitGone(pool.row('noticeRecoveryCatalog', 'catalog'))
  const window = omitGone(pool.row('window', 'window')) as HeaderRows['window'] | undefined
  return { outboxSize: window?.outboxSize ?? 0, deadLetters: recovery && recovery !== LOADING ? recovery.deadLetters.length : 0, pending: recovery === LOADING ? 1 : 0 }
}
