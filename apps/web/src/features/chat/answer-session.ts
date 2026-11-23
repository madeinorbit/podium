import type { Trpc } from '@/app/trpc'
import { useCommands } from '@podium/client-core/react'
/**
 * ANSWERING AN AGENT'S QUESTION FROM THIS DEVICE (POD-6415).
 *
 * An answer is a `session.answer` effect record: the store creates it at once
 * (`answerSession`, never queued), the server delivers it from the record's
 * run, and the delivery's reply is the record's `result`. This waits for that
 * reply in the pool, so a surface can say "not delivered" the way the old
 * routes let it.
 */

import type { SessionAnswer } from '@podium/client-core/spawn-agent'
import { awaitAnswer } from '@podium/client-graph/write/await-effect'
import type { SessionId } from '@podium/model/browser'
import { useCallback } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'

export type AnswerSessionReply = { ok: boolean; reason?: string }

/** Answer a session's question, resolving with how the delivery went. */
export function useAnswerSession(): (
  sessionId: SessionId,
  answer: SessionAnswer,
) => Promise<AnswerSessionReply> {
  const answerSession = useCommands<Trpc>().sessions.answer
  const pool = useWorklistPool()
  return useCallback(
    async (sessionId, answer) => {
      const id = await answerSession(sessionId, answer)
      // No pool to follow the record in: the server holds it, and the ask
      // resolving on every device is the answer's own confirmation.
      if (!pool) return { ok: true }
      return await awaitAnswer(pool, id)
    },
    [answerSession, pool],
  )
}
