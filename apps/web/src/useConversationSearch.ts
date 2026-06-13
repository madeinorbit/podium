import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import type { Trpc } from './trpc'

/**
 * One conversation-search hit. Derived from the server's procedure return type
 * (not re-declared), so the shape can't silently drift from the index row — a
 * renamed/added column is a compile error at every use site.
 */
export type ConversationHit = Awaited<ReturnType<Trpc['conversations']['search']['query']>>[number]

/**
 * Debounced, race-guarded conversation search shared by the search modal, the
 * new-panel resume picker, and the superagent @-menu. The seq ref drops a slow
 * response for a stale query so it can't overwrite the current results.
 */
export function useConversationSearch(opts: {
  query: string
  projectPath?: string
  limit: number
  /** When false, the hook does nothing and returns no hits (e.g. @-menu closed). */
  enabled?: boolean
  debounceMs?: number
}): { hits: ConversationHit[]; busy: boolean } {
  const { trpc } = useStore()
  const { query, projectPath, limit, enabled = true, debounceMs = 160 } = opts
  const [hits, setHits] = useState<ConversationHit[]>([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setHits([])
      setBusy(false)
      return
    }
    const mySeq = ++seq.current
    setBusy(true)
    const t = setTimeout(() => {
      trpc.conversations.search
        .query({
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(projectPath ? { projectPath } : {}),
          limit,
        })
        .then((rows) => {
          if (seq.current === mySeq) setHits(rows)
        })
        .catch(() => {})
        .finally(() => {
          if (seq.current === mySeq) setBusy(false)
        })
    }, debounceMs)
    return () => clearTimeout(t)
  }, [trpc, query, projectPath, limit, enabled, debounceMs])

  return { hits, busy }
}
