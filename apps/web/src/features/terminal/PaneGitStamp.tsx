import { observer } from '@podium/client-graph/react'
import type { SessionId } from '@podium/model/browser'
import { Folder, GitBranch } from 'lucide-react'
import type { JSX } from 'react'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { prettyCwd } from './pretty-cwd'
import { usePaneStampIssue } from './use-session-pane-inputs'

/** The pane's quiet location line (POD-2076, was the git stamp chip [POD-98]):
 * the branch this session works on, mono and muted; click opens the Git dock
 * panel. A session whose issue has no probed branch shows its working
 * directory instead. Reads the stamped issue's own fields, so the session's
 * activity never redraws it. */
export const PaneGitStamp = observer(function PaneGitStamp({
  sessionId,
  cwd,
}: {
  sessionId: SessionId
  cwd?: string | undefined
}): JSX.Element | null {
  const branch = usePaneStampIssue(sessionId)?.branch
  if (branch) {
    return (
      <button
        type="button"
        data-pressable
        data-testid="pane-branch"
        className="pane-branch"
        title={`${branch} — open Git`}
        onClick={() =>
          window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'git' }))
        }
      >
        <GitBranch size={12} aria-hidden="true" className="flex-none" />
        <span className="truncate font-mono">{branch}</span>
      </button>
    )
  }
  if (!cwd) return null
  return (
    <span className="pane-branch" title={cwd}>
      <Folder size={12} aria-hidden="true" className="flex-none" />
      <span className="truncate font-mono">{prettyCwd(cwd)}</span>
    </span>
  )
})
