import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import type { PendingInteractionCard } from '@podium/client-core/values'
import {
  noticeContinuity,
  noticeInteractions,
  noticeRecovery,
} from '@podium/client-graph/notice-views'
import { useCallback } from 'react'
import { useMobilePoolProjection } from './mobile-pool'

const EMPTY_CARDS: readonly PendingInteractionCard[] = []
const EMPTY_RECOVERY: readonly OutboxDeadLetterEntry[] = []
const EMPTY_CONTINUITY: ReturnType<typeof noticeContinuity> = {
  outboxSize: 0,
  deadLetters: 0,
  pending: 0,
}
const recovery = (pool: Parameters<typeof noticeRecovery>[0]) => noticeRecovery(pool).deadLetters

export function usePoolInteractionCards(sessionId: string): readonly PendingInteractionCard[] {
  const read = useCallback(
    (pool: Parameters<typeof noticeInteractions>[0]) =>
      noticeInteractions(pool, sessionId).cards.filter((card) => card.surface === 'aggregate'),
    [sessionId],
  )
  return useMobilePoolProjection(read, EMPTY_CARDS)
}

export function usePoolRecovery(): readonly OutboxDeadLetterEntry[] {
  return useMobilePoolProjection(recovery, EMPTY_RECOVERY)
}

export function usePoolContinuity(): ReturnType<typeof noticeContinuity> {
  return useMobilePoolProjection(noticeContinuity, EMPTY_CONTINUITY)
}
