import { useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { AtOption } from './at-mention'
import { fileMentions } from './mention-sources'

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
  machineId?: string | undefined
  enabled?: boolean
  limit?: number
  debounceMs?: number
}): AtOption[] {
  const trpc = useStoreSelector((s) => s.trpc)
  const [options, setOptions] = useState<AtOption[]>([])
  const seq = useRef(0)

  useEffect(() => {
    // A bare `@` offers no files. With nothing typed there is no such thing as a
    // relevant path — the shallowest six files in a repository are `LICENSE` and
    // friends, which is noise sitting on top of the issues, which ARE meaningful
    // unqueried (the ones touched most recently). One character in, files earn
    // their place.
    const active = enabled && !!query && !!root && root !== '/'
    if (!active) {
      setOptions([])
      return
    }
    const mySeq = ++seq.current
    const timer = setTimeout(() => {
      trpc.files.search
        .query({ root, query, limit, ...(machineId ? { machineId } : {}) })
        .then((result) => {
          if (seq.current === mySeq) setOptions(fileMentions(result.paths))
        })
        // A picker is a convenience: a checkout that cannot be read (offline
        // machine, not a git repository) offers no file rows and says nothing.
        // The issue rows beside them are unaffected.
        .catch(() => {
          if (seq.current === mySeq) setOptions([])
        })
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [trpc, query, root, machineId, enabled, limit, debounceMs])

  return options
}
