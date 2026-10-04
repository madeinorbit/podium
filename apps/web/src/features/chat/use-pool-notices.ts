import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import { noticeInteractions, noticeMessages, noticeRecovery } from '@podium/client-graph/notice-views'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

const EMPTY_MESSAGES: readonly MessageNotice[] = []
const EMPTY_CARDS: readonly PendingInteractionCard[] = []
const EMPTY_RECOVERY: readonly OutboxDeadLetterEntry[] = []
const messages = (pool: Parameters<typeof noticeMessages>[0]) => noticeMessages(pool).notices
const recovery = (pool: Parameters<typeof noticeRecovery>[0]) => noticeRecovery(pool).deadLetters

export function usePoolMessageNotices(): readonly MessageNotice[] {
  return useWorklistPoolProjection(messages, EMPTY_MESSAGES)
}
export function usePoolInteractionCards(sessionId: string): readonly PendingInteractionCard[] {
  const read = useCallback((pool: Parameters<typeof noticeInteractions>[0]) =>
    noticeInteractions(pool, sessionId).cards.filter(card => card.surface === 'aggregate'), [sessionId])
  return useWorklistPoolProjection(read, EMPTY_CARDS)
}
export function usePoolRecovery(): readonly OutboxDeadLetterEntry[] {
  return useWorklistPoolProjection(recovery, EMPTY_RECOVERY)
}
