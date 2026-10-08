import {
  ConversationSearchView,
  type ConversationRecord,
} from '@podium/client-graph/conversation-search'
import { useEffect, useMemo } from 'react'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { useViewFields } from './use-view-fields'

export type ConversationHit = ConversationRecord

const searchFields = (view: ConversationSearchView | null) => [
  view?.hits,
  view?.loading,
  view?.error,
]

/** Debounce and enabled state control when the view asks; its model owns the
 * answer, record ids, loading/error and response fence. */
export function useConversationSearch(opts: {
  query: string
  projectPath?: string
  limit: number
  enabled?: boolean
  debounceMs?: number
}): ConversationSearchView | null {
  const trpc = useRuntimeSelector((s) => s.trpc)
  const pool = useWorklistPool()
  const view = useMemo(
    () =>
      pool
        ? new ConversationSearchView(pool, (input) => trpc.conversations.search.query(input))
        : null,
    [pool, trpc],
  )
  const { query, projectPath, limit, enabled = true, debounceMs = 160 } = opts
  useEffect(() => {
    if (!view) return
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
  useEffect(() => () => view?.close(), [view])
  useViewFields(view, searchFields)
  return view
}
