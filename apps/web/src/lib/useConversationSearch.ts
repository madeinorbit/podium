import type { Trpc } from '@/app/trpc'
import { useRequestClient } from '@podium/client-core/react'
import { useEffect, useMemo } from 'react'
import { ConversationSearchView } from './conversation-search-view'
export type { ConversationHit } from './conversation-search-view'

/** Debounce and enabled state control when the view asks; its model owns the
 * answer, loading/error and response fence. */
export function useConversationSearch(opts: {
  query: string
  projectPath?: string
  limit: number
  enabled?: boolean
  debounceMs?: number
}): ConversationSearchView {
  const trpc = useRequestClient<Trpc>()
  const view = useMemo(
    () => new ConversationSearchView((input) => trpc.conversations.search.query(input)),
    [trpc],
  )
  const { query, projectPath, limit, enabled = true, debounceMs = 160 } = opts
  useEffect(() => {
    if (!enabled) {
      view.close()
      return
    }
    view.prepare()
    const timer = setTimeout(() => {
      void view.search({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(projectPath ? { projectPath } : {}),
        limit,
      })
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      view.cancel()
    }
  }, [view, query, projectPath, limit, enabled, debounceMs])
  useEffect(() => () => view.close(), [view])
  return view
}
