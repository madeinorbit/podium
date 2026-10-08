import { observer } from '@podium/client-graph/react'
import type { SessionId } from '@podium/model/browser'
import type { JSX } from 'react'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { GitStamp } from '@/components/GitStamp'
import { usePaneStampIssue } from './use-session-pane-inputs'

/** Git stamp [POD-98]: has this task committed, and on which branch — always
 * visible for the session you're reading; click opens the Git dock panel.
 * Hidden when the session's issue has no probed state. Reads the stamped
 * issue's own fields, so the session's activity never redraws it. */
export const PaneGitStamp = observer(function PaneGitStamp({
  sessionId,
}: {
  sessionId: SessionId
}): JSX.Element | null {
  const issue = usePaneStampIssue(sessionId)
  if (!issue) return null
  return (
    <GitStamp
      issueBranch={issue.branch}
      git={issue.gitState}
      density="chip"
      className="hidden flex-none md:inline-flex"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'git' }))}
    />
  )
})
