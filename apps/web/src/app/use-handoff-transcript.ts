import type { SessionView } from '@podium/client-core/session-values'
import {
  useConversation as useOwnedConversation,
  useStoreHandle,
} from '@podium/client-core/react'
import {
  selectLatestPromptSession,
  type HandoffTranscriptPair,
} from '@podium/client-core/values'
import { reaction } from 'mobx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import {
  createWebConversation,
  type WebConversation,
} from '@/features/chat/use-conversation'
import type { Trpc } from './trpc'

type HandoffTranscriptState =
  | { status: 'empty'; session: SessionView | null; pair: null }
  | { status: 'loading'; session: SessionView; pair: HandoffTranscriptPair | null }
  | { status: 'ready'; session: SessionView; pair: HandoffTranscriptPair }
  | { status: 'error'; session: SessionView; pair: null }

/** The handoff reads the session's retained TranscriptLog (POD-5652).
 *
 *  The conversation is the same shared instance the chat surface would hold:
 *  `useOwnedConversation` acquires it from the principal-owned cache, so a
 *  session opened here and in chat shares one log, one read stream and one
 *  maintained prompt/answer pair. The hook never fetches or merges transcript
 *  pages itself; it pages the shared log until the maintained pair resolves.
 */
export function useHandoffTranscript(
  active: boolean,
  missionSessions: readonly SessionView[],
): HandoffTranscriptState & { retry: () => void } {
  const runtime = useStoreHandle<Trpc>()
  const pool = useWorklistPool()
  const session = useMemo(
    () => (active ? selectLatestPromptSession(missionSessions) : null),
    [active, missionSessions],
  )
  const sessionId = session?.sessionId
  const enabled = active && session !== null && pool !== null
  // Same factory the chat surface registers: whoever creates the shared entry
  // first, both readers observe the same retained transcript. Thread views
  // never collide: they acquire under a `sessionId:thread:` cache key.
  const conversation = useOwnedConversation<WebConversation>(
    enabled ? sessionId : undefined,
    () => createWebConversation(runtime, pool!, sessionId!, {}),
    { enabled },
  )
  const transcript = conversation?.transcript
  const [snapshot, setSnapshot] = useState(() => ({
    pair: transcript?.latestHandoffPair ?? null,
    initialLoaded: transcript?.initialLoaded ?? false,
    hasMoreOlder: transcript?.hasMoreOlder ?? false,
    loadingOlder: transcript?.loadingOlder ?? false,
  }))
  // Bridge the shared log's observables into React state. The reaction wakes
  // only when a field it read moves; setting state from it cannot loop.
  useEffect(() => {
    setSnapshot({
      pair: transcript?.latestHandoffPair ?? null,
      initialLoaded: transcript?.initialLoaded ?? false,
      hasMoreOlder: transcript?.hasMoreOlder ?? false,
      loadingOlder: transcript?.loadingOlder ?? false,
    })
    if (!transcript) return
    return reaction(
      () => ({
        pair: transcript.latestHandoffPair ?? null,
        initialLoaded: transcript.initialLoaded,
        hasMoreOlder: transcript.hasMoreOlder,
        loadingOlder: transcript.loadingOlder,
      }),
      (next) => setSnapshot(next),
    )
  }, [transcript])
  const [pageFailed, setPageFailed] = useState(false)
  const failedRef = useRef(false)
  useEffect(() => {
    failedRef.current = false
    setPageFailed(false)
  }, [transcript])

  useEffect(() => {
    if (!active || !transcript || failedRef.current) return
    if (transcript.latestHandoffPair !== null) return
    let cancelled = false
    void (async () => {
      while (
        !cancelled &&
        !failedRef.current &&
        transcript.latestHandoffPair === null &&
        transcript.hasMoreOlder &&
        !transcript.loadingOlder
      ) {
        try {
          await transcript.loadOlder()
        } catch {
          failedRef.current = true
          if (!cancelled) setPageFailed(true)
          return
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    active,
    transcript,
    snapshot.pair,
    snapshot.loadingOlder,
    snapshot.hasMoreOlder,
    pageFailed,
  ])

  const retry = useCallback(() => {
    if (!transcript) return
    failedRef.current = false
    setPageFailed(false)
    void transcript.refresh({ disclose: true }).catch(() => {
      failedRef.current = true
      setPageFailed(true)
    })
  }, [transcript])

  if (!active || !session) return { status: 'empty', session: null, pair: null, retry }
  if (snapshot.pair)
    return { status: 'ready', session, pair: snapshot.pair, retry }
  if (pageFailed) return { status: 'error', session, pair: null, retry }
  if (!snapshot.initialLoaded || snapshot.loadingOlder || snapshot.hasMoreOlder)
    return { status: 'loading', session, pair: null, retry }
  return { status: 'empty', session, pair: null, retry }
}
