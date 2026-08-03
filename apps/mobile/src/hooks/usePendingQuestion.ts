import { latestPendingQuestion } from '@podium/client-core/viewmodels'
import type { SessionId, TranscriptItem } from '@podium/model'
import { useEffect, useState } from 'react'
import { readTranscriptPage, useTrpc } from '../client/hooks'

/**
 * One-shot fetch of the session's latest unanswered AskUserQuestion, refetched
 * whenever the caller's `revision` changes (pass agentState.since so a phase
 * change re-checks). Powers inline answering from the Inbox without holding a
 * transcript subscription per card.
 */
export function usePendingQuestion(sessionId: SessionId, enabled: boolean, revision?: string) {
  const trpc = useTrpc()
  const [item, setItem] = useState<TranscriptItem | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` intentionally re-triggers the fetch on phase changes
  useEffect(() => {
    if (!enabled) {
      setItem(null)
      return
    }
    let alive = true
    readTranscriptPage(trpc, sessionId)
      .then((page) => {
        if (alive) setItem(latestPendingQuestion(page.items))
      })
      .catch(() => {
        if (alive) setItem(null)
      })
    return () => {
      alive = false
    }
  }, [trpc, sessionId, enabled, revision])

  return item
}
