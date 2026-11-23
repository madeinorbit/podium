import { type IssueSharedDetail, issueSharedDetail } from '@podium/client-graph/issue-shared-detail'
import { useEffect } from 'react'
import { demoEnabled } from './demoData'
import { useTrpc } from './hooks'
import { useMobilePool } from './mobile-pool'
import { followPhoneRequest } from './visible-request'

/** Other members' sessions change state without touching the task: re-read
 *  their summaries this often while the page is in front. */
const SUMMARY_REFRESH_MS = 30_000

/**
 * The open task's shared half (POD-6295, on the phone since POD-6297): what
 * the reader may do, the D13 summaries of every session on it, and its
 * collaborators. The same pool store the web page holds.
 *
 * Only on a shared instance (`active`): a one-member instance has no other
 * member's session to summarise, and its task page makes no new reads.
 */
export function useIssueSharedDetail(
  issueId: string,
  active: boolean,
): IssueSharedDetail | undefined {
  const pool = useMobilePool()
  const trpc = useTrpc()
  const detail = pool && active ? issueSharedDetail(pool, issueId) : undefined
  useEffect(() => {
    if (!detail || demoEnabled()) return
    const release = detail.retain({
      get: async (id) => (await trpc.issues.get.query({ id })) ?? null,
      collaborators: async (id) => await trpc.issues.collaborators.query({ id }),
    })
    // `retain` has read once already; the poll takes over from the next tick.
    let first = true
    const stop = followPhoneRequest(() => {
      if (first) first = false
      else detail.refresh()
    }, SUMMARY_REFRESH_MS)
    return () => {
      stop()
      release()
    }
  }, [detail, trpc])
  return detail
}
