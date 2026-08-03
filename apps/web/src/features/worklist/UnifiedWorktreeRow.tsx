import {
  type IssueNavigationModel,
  partitionStaleSessions,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX } from 'react'
import { AgentRosterBand, GroupedSessionRows, PanelRow, StaleSection } from './sidebar-common'

/** Provenance whisper for an orphaned session (L6): a session whose issue was
 *  deleted or archived names its origin — `from POD-32 · deleted` — instead of
 *  silently pooling into an anonymous branch row. Presentation only; the
 *  data-layer orphan fix is POD-135. */
function orphanProvenance(
  session: SessionMeta,
  issues: IssueNavigationModel[],
): { text: string; hint: string } | null {
  if (!session.issueId) return null
  const issue = issues.find((i) => i.id === session.issueId)
  if (issue && !issue.archived && !issue.deletedAt) return null
  // Birth displayRef (POD-13-A) carries the issue ref even when the issue row
  // is gone from the wire entirely.
  const ref = issue ? issueDisplayRef(issue) : (session.displayRef?.replace(/-[A-Z]+$/, '') ?? null)
  const cause = issue ? (issue.deletedAt ? 'deleted' : 'archived') : 'deleted'
  return {
    text: ref ? `from ${ref} · ${cause}` : `issue ${cause}`,
    hint: `This session's issue was ${cause}; it decays on its own session clock.`,
  }
}

/** Sessions no live issue owns (L6): guests, not issues. The whole worktree
 *  entry renders in the roster grammar — a rail-navy band at its project
 *  group's tail labeled `repo · branch` in machine voice — never as a
 *  pseudo-issue row named "main". */
export function UnifiedWorktreeRow({
  row,
  issues,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'worktree' }>
  issues: IssueNavigationModel[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: SessionId) => void
}): JSX.Element {
  const { worktree } = row
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const branch = worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path
  const renderRow = (session: SessionMeta) => {
    const orphan = orphanProvenance(session, issues)
    const attachedIssueDisplayRef = session.issueId
      ? issues.find((issue) => issue.id === session.issueId)?.displayRef
      : undefined
    return (
      <PanelRow
        key={session.sessionId}
        session={session}
        active={active && paneA === session.sessionId}
        onSelect={() => onSelectPanel(session.sessionId)}
        dotRight
        roster
        issueDisplayRef={attachedIssueDisplayRef}
        trailingMeta={
          orphan ? (
            <span
              className="flex-none font-mono text-[8.5px] text-[#525c78]"
              data-testid="orphan-provenance"
              title={orphan.hint}
            >
              {orphan.text}
            </span>
          ) : undefined
        }
      />
    )
  }
  return (
    <AgentRosterBand
      testId="unified-worktree-row"
      label={`${worktree.repoName} · ${branch}`}
      count={worktree.sessions.length}
      active={active}
      onLabelClick={onSelect}
      labelHint={worktree.path}
    >
      <GroupedSessionRows sessions={visible} render={renderRow} dense />
      <StaleSection sessions={stale} render={renderRow} dense />
    </AgentRosterBand>
  )
}
