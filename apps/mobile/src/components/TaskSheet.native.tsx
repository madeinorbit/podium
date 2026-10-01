import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionMeta } from '@podium/model'
import { useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'

/** Native task inspection is a real router form sheet, not an in-tree modal. */
export function TaskSheet({
  issue,
  onClose,
}: {
  issue: IssueViewModel | null
  issues: readonly IssueViewModel[]
  sessions: readonly SessionMeta[]
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
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
