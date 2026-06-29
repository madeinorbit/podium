import type { JSX } from 'react'
import { IssueDetail } from './IssueDetail'
import { useStore } from './store'

/** Renders the issue-detail drawer for whichever issue is open in the store, so the
 *  drawer can be triggered from the kanban board or the sidebar Issues tab alike.
 *  Mounted once at the app-body level; renders nothing when no issue is open. */
export function IssueDetailHost(): JSX.Element | null {
  const { issues, openIssueId, setOpenIssueId } = useStore()
  const issue = openIssueId ? (issues.find((i) => i.id === openIssueId) ?? null) : null
  if (!issue) return null
  return <IssueDetail issue={issue} onClose={() => setOpenIssueId(null)} />
}
