import { useRequestClient } from '@podium/client-core/react'
import { type IssueSharedDetail, issueSharedDetail } from '@podium/client-graph/issue-shared-detail'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { useEffect } from 'react'
import { type IssueViewModel } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'

/** Other members' sessions change state without touching the task: re-read
 *  their summaries this often while the page is visible. */
const SUMMARY_REFRESH_MS = 30_000

/**
 * The open task's shared half (POD-6295): what the reader may do, the D13
 * summaries of every session on it, and its collaborators. Every section that
 * shows a part of it holds the one store; the first holder starts the reads.
 */
export function useIssueSharedDetail(issue: IssueViewModel): IssueSharedDetail | undefined {
  const pool = useWorklistPool()
  const trpc = useRequestClient<Trpc>() as Trpc | undefined
  const detail = pool ? issueSharedDetail(pool, issue.id) : undefined
  useEffect(() => {
    if (!detail || !trpc) return
    const release = detail.retain({
      get: async (id) => (await trpc.issues.get.query({ id })) ?? null,
      collaborators: async (id) => await trpc.issues.collaborators.query({ id }),
    })
    if (typeof document === 'undefined') return release
    // `retain` has read once already; the poll takes over from the next tick.
    let first = true
    const stop = followVisibleRequest(
      () => {
        if (first) first = false
        else detail.refresh()
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
      SUMMARY_REFRESH_MS,
    )
    return () => {
      stop()
      release()
    }
  }, [detail, trpc])
  return detail
}
