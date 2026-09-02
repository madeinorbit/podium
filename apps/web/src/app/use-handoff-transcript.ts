import {
  pairLatestPromptAndAnswer,
  parseEnvelopeBatch,
  selectLatestPromptSession,
  type HandoffTranscriptPair,
} from '@podium/client-core/viewmodels'
import type { SessionMeta, TranscriptItem } from '@podium/model/browser'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreSelector } from './store'

const INITIAL_LIMIT = 200
const PAGE_LIMIT = 400
const MAX_ITEMS = 2_000

type HandoffTranscriptState =
  | { status: 'empty'; session: SessionMeta | null; pair: null }
  | { status: 'loading'; session: SessionMeta; pair: HandoffTranscriptPair | null }
  | { status: 'ready'; session: SessionMeta; pair: HandoffTranscriptPair }
  | { status: 'error'; session: SessionMeta; pair: null }

const transcriptCache = new Map<string, HandoffTranscriptPair | null>()

function mergeOlder(
  older: readonly TranscriptItem[],
  current: readonly TranscriptItem[],
): TranscriptItem[] {
  const seen = new Set(current.map((item) => item.cursor ?? item.id))
  return [
    ...older.filter((item) => {
      const key = item.cursor ?? item.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    ...current,
  ]
}

export function useHandoffTranscript(
  active: boolean,
  missionSessions: readonly SessionMeta[],
): HandoffTranscriptState & { retry: () => void } {
  const { trpc, replica } = useStoreSelector((store) => ({
    trpc: store.trpc,
    replica: store.replica,
  }))
  const session = useMemo(
    () => (active ? selectLatestPromptSession(missionSessions) : null),
    [active, missionSessions],
  )
  const cacheKey = session ? `${session.sessionId}\n${session.lastActiveAt}` : null
  const [retryKey, setRetryKey] = useState(0)
  const retry = useCallback(() => setRetryKey((key) => key + 1), [])
  const [state, setState] = useState<HandoffTranscriptState>({
    status: 'empty',
    session: null,
    pair: null,
  })

  useEffect(() => {
    if (!active || !session || !cacheKey) {
      setState({ status: 'empty', session: null, pair: null })
      return
    }

    const promptOptions = {
      collapseMachineContext: session.headless === true,
      operatorTextOf: (text: string) => parseEnvelopeBatch(text)?.operatorText,
    }
    const hasCached = transcriptCache.has(cacheKey)
    const cached = transcriptCache.get(cacheKey)
    if (hasCached) {
      setState(
        cached
          ? { status: 'ready', session, pair: cached }
          : { status: 'empty', session, pair: null },
      )
      return
    }
    const replicaItems = replica.transcriptWindow(session.sessionId)?.items ?? []
    const seeded = pairLatestPromptAndAnswer(session.sessionId, replicaItems, promptOptions)
    if (seeded) setState({ status: 'loading', session, pair: seeded })
    else setState({ status: 'loading', session, pair: null })

    let cancelled = false
    void (async () => {
      try {
        let page = await trpc.sessions.transcriptRead.query({
          sessionId: session.sessionId,
          direction: 'before',
          limit: INITIAL_LIMIT,
        })
        let items = page.items as TranscriptItem[]
        let pair = pairLatestPromptAndAnswer(session.sessionId, items, promptOptions)
        while (!pair && page.hasMore && items.length < MAX_ITEMS && page.head) {
          page = await trpc.sessions.transcriptRead.query({
            sessionId: session.sessionId,
            anchor: page.head,
            direction: 'before',
            limit: Math.min(PAGE_LIMIT, MAX_ITEMS - items.length),
          })
          items = mergeOlder(page.items as TranscriptItem[], items)
          pair = pairLatestPromptAndAnswer(session.sessionId, items, promptOptions)
        }
        if (cancelled) return
        transcriptCache.set(cacheKey, pair)
        replica.putTranscriptWindow(session.sessionId, items.slice(-INITIAL_LIMIT))
        setState(
          pair ? { status: 'ready', session, pair } : { status: 'empty', session, pair: null },
        )
      } catch {
        if (cancelled) return
        if (seeded) setState({ status: 'ready', session, pair: seeded })
        else setState({ status: 'error', session, pair: null })
      }
    })()

    return () => {
      cancelled = true
    }
    // `cacheKey` is the transcript read's semantic identity. Replica refreshes
    // may replace an equal SessionMeta object; restarting for that identity-only
    // change would turn each state write above into another read.
    // biome-ignore lint/correctness/useExhaustiveDependencies: session identity is deliberately represented by cacheKey.
  }, [active, cacheKey, replica, retryKey, trpc])

  return { ...state, retry }
}
