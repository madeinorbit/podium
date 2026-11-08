/**
 * ANSWERING AN AGENT'S QUESTION FROM THE PHONE (POD-6415), the web's
 * `features/chat/answer-session.ts`.
 *
 * An answer is a `session.answer` effect record: the store creates it at once
 * (`answerSession`, never queued; an answer is online-only), the server
 * delivers it from the record's run, and the delivery's reply is the record's
 * `result`, which this waits for in the pool.
 */

import type { SessionAnswer } from '@podium/client-core/spawn-agent'
import { awaitAnswer } from '@podium/client-graph/write/await-effect'
import type { SessionId } from '@podium/model'
import { useCallback } from 'react'
import { useStoreActions } from '../client/hooks'
import { useMobilePoolNow } from '../client/mobile-pool'
import type { AskQuestionAnswer } from '../components/AskQuestionCard'

export type AnswerSessionReply = { ok: boolean; reason?: string }

/** The card's answer as a live-menu answer: only what the server reads. */
export function menuAnswer(answer: AskQuestionAnswer): SessionAnswer {
  const interactionId =
    answer.interactionId !== undefined ? { interactionId: answer.interactionId } : {}
  return 'skip' in answer
    ? { via: 'menu', ...interactionId, skip: true }
    : {
        via: 'menu',
        ...interactionId,
        choices: answer.choices as unknown as readonly Record<string, unknown>[],
      }
}

/** Answer a session's question, resolving with how the delivery went. */
export function useAnswerSession(): (
  sessionId: SessionId,
  answer: SessionAnswer,
) => Promise<AnswerSessionReply> {
  const { answerSession } = useStoreActions()
  // Read at answer time: the screens that answer do not re-render on the
  // pool's attachment for it.
  const poolNow = useMobilePoolNow()
  return useCallback(
    async (sessionId, answer) => {
      const id = await answerSession(sessionId, answer)
      const pool = poolNow()
      // No pool to follow the record in: the server holds it, and the ask
      // resolving on every device is the answer's own confirmation.
      if (!pool) return { ok: true }
      return await awaitAnswer(pool, id)
    },
    [answerSession, poolNow],
  )
}
