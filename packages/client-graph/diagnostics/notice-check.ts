/** Opt-in differential, following sidebar-check. Values stay in memory;
 * reports contain only counts and positions. No diagnostic is on a normal
 * enabled reader path, and recovery compares only parked author input. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { messageNotices, pendingInteractionCards } from '@podium/client-core/viewmodels'
import type { MobxPool } from '../src/pool'
import { noticeContinuity, noticeInteractions, noticeMessages, noticeRecovery } from '../src/notice-views'
import { compareSidebarSnapshots, type CheckSection } from './sidebar-check'

export function checkNotices(pool: MobxPool, state: Pick<Store, 'messageRecords' | 'sessions' | 'pendingInteractions' | 'outboxDeadLetters' | 'outboxSize'>, sessionIds: readonly string[]) {
  const messages = noticeMessages(pool), recovery = noticeRecovery(pool), continuity = noticeContinuity(pool)
  const expected: CheckSection[] = [{ key: 'messages', fields: {}, rows: messageNotices(state.messageRecords ?? [], state.sessions ?? []).map(row => ({ id: row.messageId, fields: { ...row } })) }]
  const actual: CheckSection[] = [{ key: 'messages', fields: {}, rows: messages.notices.map(row => ({ id: row.messageId, pending: messages.pendingIds.includes(row.messageId), fields: { ...row } })) }]
  let pending = messages.pending + recovery.pending
  for (const sessionId of sessionIds) {
    const asks = noticeInteractions(pool, sessionId)
    pending += asks.pending
    expected.push({ key: `asks:${sessionId}`, fields: {}, rows: pendingInteractionCards(state.pendingInteractions ?? [], sessionId).map(row => ({ id: row.id, fields: { ...row } })) })
    actual.push({ key: `asks:${sessionId}`, fields: {}, rows: asks.cards.map(row => ({ id: row.id, fields: { ...row } })) })
  }
  expected.push({ key: 'recovery', fields: { outboxSize: state.outboxSize }, rows: state.outboxDeadLetters.map(row => ({ id: row.entry.mutationId, fields: { ...row } })) })
  actual.push({ key: 'recovery', fields: { outboxSize: continuity.outboxSize }, rows: recovery.deadLetters.map(row => ({ id: row.entry.mutationId, fields: { ...row } })) })
  const result = compareSidebarSnapshots({ sections: expected, pending: 0 }, { sections: actual, pending })
  return { differences: result.differences, pending: result.pending, positions: result.rows,
    first: result.first ? { sectionIndex: result.first.sectionIndex, rowIndex: result.first.rowIndex, field: result.first.field } : null }
}

export function installNoticeCheck(pool: MobxPool, runtime: ClientRuntime): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => {
    const state = runtime.getSnapshot()
    return checkNotices(pool, state, [...new Set(state.pendingInteractions.map(row => row.sessionId))])
  }
  Object.assign(window, { __noticeCheck: check })
  return () => { if (Reflect.get(window, '__noticeCheck') === check) Reflect.deleteProperty(window, '__noticeCheck') }
}
