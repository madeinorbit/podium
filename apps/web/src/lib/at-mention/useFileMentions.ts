import type { MachineId } from '@podium/model'
import { useEffect, useMemo } from 'react'
import { useObserver } from 'mobx-react-lite'
import { useRuntimeSelector } from '@/app/store'
import type { AtOption } from './at-mention'
import { FileMentionView } from '../search-views'

/**
 * FILE ROWS FOR THE @-MENU (POD-412), scoped to one checkout.
 *
 * Debounced and race-guarded in the shape `useConversationSearch` established:
 * a sequence number drops a slow answer for a query nobody is typing any more,
 * so a fast keystroke can never be overwritten by a stale one.
 *
 * The RANKING is not here. `files.search` reads the checkout's tracked paths
 * through the daemon and returns only the rows the menu shows — the whole point
 * being that a 4,000-file repository is 180 KB of paths that has no business in
 * a browser on every keystroke.
 *
 * Files need a root, and a session that has none (an unattached shell, a
 * superagent thread that is not in a checkout) gets no file rows rather than a
 * guess at which repository it meant.
 */
export function useFileMentions({
  query,
  root,
  machineId,
  enabled = true,
  limit = 6,
  debounceMs = 120,
}: {
  /** The text after the `@`, or null when no mention is open. */
  query: string | null
  root: string | undefined
  machineId?: MachineId | undefined
  enabled?: boolean
  limit?: number
  debounceMs?: number
}): AtOption[] {
  const trpc = useRuntimeSelector((s) => s.trpc)
  const view = useMemo(() => new FileMentionView(trpc), [trpc])
  useEffect(() => {
    if (!enabled || !query || !root || root === '/') { view.close(); return }
    view.prepare()
    const timer = setTimeout(() => { void view.search({ root, query, limit, ...(machineId ? { machineId } : {}) }) }, debounceMs)
    return () => { clearTimeout(timer); view.cancel() }
  }, [view, query, root, machineId, enabled, limit, debounceMs])
  useEffect(() => () => view.close(), [view])
  return useObserver(() => view.options)
}
