import { latestPendingQuestion } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { useMobileClient } from '../client/MobileClientProvider'

/**
 * One-shot fetch of the session's latest unanswered AskUserQuestion, refetched
 * whenever the caller's `revision` changes (pass agentState.since so a phase
 * change re-checks). Powers inline answering from the Inbox without holding a
 * transcript subscription per card.
 */
export function usePendingQuestion(sessionId: string, enabled: boolean, revision?: string) {
  const { readTranscript } = useMobileClient()
  const [item, setItem] = useState<TranscriptItem | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` intentionally re-triggers the fetch on phase changes
  useEffect(() => {
    if (!enabled) {
      setItem(null)
      return
    }
    let alive = true
    readTranscript(sessionId)
      .then((page) => {
        if (alive) setItem(latestPendingQuestion(page.items))
      })
      .catch(() => {
        if (alive) setItem(null)
      })
    return () => {
      alive = false
    }
  }, [readTranscript, sessionId, enabled, revision])

  return item
}
