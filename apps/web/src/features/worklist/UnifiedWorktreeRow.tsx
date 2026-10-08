import type { WorklistWorktree } from '@podium/client-graph/worklist/worktree'
import { observer } from '@podium/client-graph/react'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type IssueNavigationModel,
  partitionStaleSessions,
  type UnifiedWorkRow,
} from '@podium/client-core/values'
import { machinePathBasename } from '@podium/model'
import type { SessionId} from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX, ReactNode } from 'react'
import { AgentRosterBand, PanelRow, StaleSection } from './sidebar-common'

/** Provenance whisper for an orphaned session (L6): a session whose issue was
 *  deleted or archived names its origin — `from POD-32 · deleted` — instead of
 *  silently pooling into an anonymous branch row. Presentation only; the
 *  data-layer orphan fix is POD-135. */
function orphanProvenance(
  session: SessionView,
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
export const UnifiedWorktreeRow = observer(function UnifiedWorktreeRow({
  model,
  row,
  issues: suppliedIssues,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
  partition,
  renderSession,
}: {
  model?: WorklistWorktree
  row?: Extract<UnifiedWorkRow, { kind: 'worktree' }>
  issues?: IssueNavigationModel[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: SessionId) => void
  partition?: { visible: SessionView[]; stale: SessionView[] }
  renderSession?: (
    session: SessionView,
    active: boolean,
    issueDisplayRef: string | undefined,
    trailingMeta: ReactNode,
  ) => JSX.Element
}): JSX.Element {
  const worktree = model?.worktree ?? row!.worktree
  const sessions = model ? model.sessions as unknown as SessionView[] : row!.worktree.sessions
  const issues = model ? model.issues as unknown as IssueNavigationModel[] : suppliedIssues ?? []
  const visible = model ? model.visible as unknown as SessionView[] : (partition ?? partitionStaleSessions(sessions, now)).visible
  const stale = model ? model.stale as unknown as SessionView[] : (partition ?? partitionStaleSessions(sessions, now)).stale
  const branch = worktree.branch ?? machinePathBasename(worktree.path)
  const renderRow = (session: SessionView) => {
    const orphan = orphanProvenance(session, issues)
    const attachedIssueDisplayRef = session.issueId
      ? issues.find((issue) => issue.id === session.issueId)?.displayRef
      : undefined
    const trailingMeta = orphan ? (
      <span
        className="shell-type-micro flex-none font-mono text-text-faint"
        data-testid="orphan-provenance"
        title={orphan.hint}
      >
        {orphan.text}
      </span>
    ) : undefined
    if (renderSession)
      return renderSession(
        session,
        active && paneA === session.sessionId,
        attachedIssueDisplayRef,
        trailingMeta,
      )
    return (
      <PanelRow
        key={session.sessionId}
        session={session}
        active={active && paneA === session.sessionId}
        onSelect={() => onSelectPanel(session.sessionId)}
        dotRight
        roster
        issueDisplayRef={attachedIssueDisplayRef}
        trailingMeta={trailingMeta}
      />
    )
  }
  return (
    <AgentRosterBand
      testId="unified-worktree-row"
      label={`${worktree.repoName} · ${branch}`}
      count={sessions.length}
      active={active}
      onLabelClick={onSelect}
      labelHint={worktree.path}
    >
      {/* FLAT (POD-516 §1.1). These sessions used to render through a
          spawn-parent tree — a session nested under whichever other session
          happened to have spawned it. The doctrine is explicit that spawn
          parentage is not the tree ("its spawn parent and native workers are
          secondary details, not a competing navigation tree"), so the guests
          list is one line per session, in the order the derivation put them. */}
      {visible.map(renderRow)}
      <StaleSection sessions={stale} render={renderRow} dense />
    </AgentRosterBand>
  )
})
