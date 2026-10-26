import type { SessionView } from '@podium/client-core/session-values'
import { observer } from '@podium/client-graph/react'
import type { WorklistWorktree } from '@podium/client-graph/worklist/worktree'
import { machinePathBasename } from '@podium/model'
import type { JSX } from 'react'
import { AgentRosterBand, StaleSection } from './sidebar-common'

/** Sessions no live issue owns (L6): guests, not issues. The whole worktree
 *  entry renders in the roster grammar — a rail-navy band at its project
 *  group's tail labeled `repo · branch` in machine voice — never as a
 *  pseudo-issue row named "main". A session whose issue is archived or gone
 *  is not a guest; the roster rule keeps it out of this band. */
export const UnifiedWorktreeRow = observer(function UnifiedWorktreeRow({
  model,
  active,
  paneA,
  onSelect,
  renderSession,
}: {
  model: WorklistWorktree
  active: boolean
  paneA: string | null
  onSelect: () => void
  renderSession: (session: SessionView, active: boolean) => JSX.Element
}): JSX.Element {
  const { worktree } = model
  const branch = worktree.branch ?? machinePathBasename(worktree.path)
  const renderRow = (session: SessionView) =>
    renderSession(session, active && paneA === session.sessionId)
  return (
    <AgentRosterBand
      testId="unified-worktree-row"
      label={`${worktree.repoName} · ${branch}`}
      count={model.sessions.length}
      active={active}
      onLabelClick={onSelect}
      labelHint={worktree.path}
    >
      {/* FLAT (POD-516 §1.1): one line per session in the derivation's order,
          never a spawn-parent tree. */}
      {(model.visible as unknown as SessionView[]).map(renderRow)}
      <StaleSection sessions={model.stale as unknown as SessionView[]} render={renderRow} dense />
    </AgentRosterBand>
  )
})
