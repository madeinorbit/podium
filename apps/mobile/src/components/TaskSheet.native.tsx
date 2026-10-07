import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph/pool'
import { useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'

/** Native task inspection is a real router form sheet, not an in-tree modal. */
export function TaskSheet({
  issue,
  onClose,
}: {
  pool?: MobxPool | null
  issue: IssueViewModel | null
  issues: readonly IssueViewModel[]
  sessions: readonly SessionView[]
  onClose: () => void
  onOpenSession: (session: SessionView) => void
  onOpenIssue?: (issue: IssueViewModel) => void
}) {
  const router = useRouter()
  const presented = useRef<string | null>(null)

  useEffect(() => {
    if (!issue || presented.current === issue.id) return
    presented.current = issue.id
    router.push(`/inspect/${encodeURIComponent(issue.id)}`)
    onClose()
  }, [issue, onClose, router])

  useEffect(() => {
    if (!issue) presented.current = null
  }, [issue])

  return null
}
