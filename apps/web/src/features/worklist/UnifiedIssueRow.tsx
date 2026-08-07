import {
  branchRollup,
  draftIssueLabel,
  type IssueNavigationModel,
  isCoordinatorSession,
  isDraftAgentVessel,
  partitionStaleSessions,
  pendingDecisionLabel,
  pendingDecisionTitle,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  sessionsNeedChildRows,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import type { IssueColorSlot, IssueId, SessionId, SessionMeta } from '@podium/model'
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { AlarmClock, Pin } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useMemo, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { IdSquare } from '@/components/IdSquare'
import { missionIssueIds } from '@/lib/mission'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/features/issues/issue-card'
import { agentFleetTileTint } from '@/lib/agent-tone'
import { issueColorHex } from '@/lib/issueColors'
import { PhaseTimer } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { cn } from '@/lib/utils'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { agentIconFor } from './agent-icon'
import { issueRowFoldKey } from './fold-keys'
import {
  AgentRosterBand,
  GroupedSessionRows,
  PanelRow,
  StaleSection,
  useCollapsed,
} from './sidebar-common'
import { inlineRenameEditor, useInlineRename } from './use-inline-rename'
import { WorkRowShell } from './WorkRowShell'

/** Compact execution presence that survives a collapsed issue row. The full
 * roster remains below the row; this summary answers "who is here?" without
 * making the operator keep every fleet expanded. */
function IssueFleetSummary({
  sessions,
  leadCount = 0,
  unread = false,
}: {
  sessions: SessionMeta[]
  leadCount?: number
  /** An unopened update since last read (POD-293): a single info dot on the
   *  agent identity, not a shouted banner. Bound to the fleet glyph so it reads
   *  as "this agent has something new", never a free-floating third dot. */
  unread?: boolean
}): JSX.Element | null {
  const live = sessions.filter(
    (session) => !session.archived && session.status !== 'exited' && session.status !== 'hibernated',
  )
  if (live.length === 0) return null
  const shown = live.slice(0, 3)
  const overflow = Math.max(0, live.length - shown.length)
  const nativeCount = live.reduce(
    (sum, session) => sum + (session.agentState?.nativeSubagentCount ?? 0),
    0,
  )
  const label = [
    `${live.length} live agent${live.length === 1 ? '' : 's'}`,
    leadCount > 0 ? `${leadCount} lead${leadCount === 1 ? '' : 's'}` : null,
    nativeCount > 0 ? `${nativeCount} native subagent${nativeCount === 1 ? '' : 's'}` : null,
    unread ? 'new update' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className="ml-0.5 flex flex-none items-center"
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
    >
      {shown.map((session, index) => {
        const AgentIcon = agentIconFor(session.agentKind)
        // Per-kind tint (POD-293): Claude wears its clay, other harnesses a quiet
        // navy — solid fills so stacked tiles don't ghost through each other. A
        // table keyed by kind, not a comparison (see @/lib/agent-tone).
        const tileTint = agentFleetTileTint(session.agentKind)
        // The row's unopened-update dot rides the corner of the LAST tile (the
        // concept's `.av .unreaddot`): tight to the glyph at -3px, ringed in the
        // row background — reads as "this fleet has something new", not a third
        // free-floating mark.
        const showDot = unread && index === shown.length - 1
        return (
          <span
            key={session.sessionId}
            data-agent-kind={session.agentKind}
            className={cn(
              'relative flex size-[19px] items-center justify-center rounded-[6px] border',
              tileTint,
              index > 0 && '-ml-1',
            )}
            style={{ zIndex: index + 1 }}
          >
            {AgentIcon ? <AgentIcon size={12} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
            {showDot && (
              <span
                className="absolute -top-[3px] -right-[3px] z-[1] size-[7px] rounded-full border-[1.5px] border-[var(--row-bg,var(--sidebar))] bg-info"
                data-testid="row-unread-dot"
                aria-hidden="true"
              />
            )}
          </span>
        )
      })}
      {overflow > 0 && (
        <span
          className="shell-type-micro -ml-1 flex h-[21px] min-w-[21px] items-center justify-center rounded-[6px] border border-border-strong bg-chip px-0.5 font-mono text-muted-foreground"
          style={{ zIndex: shown.length + 1 }}
        >
          +{overflow}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className="shell-type-micro -mt-2 -ml-1 rounded-[4px] border border-claude/35 bg-claude/12 px-[3px] font-mono text-claude"
          style={{ zIndex: shown.length + 2 }}
          data-testid="issue-fleet-subagent-count"
        >
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}

/** Lineage flash (POD-85): briefly outline another issue's row — provenance as
 *  a gesture when a spin-off is selected, not persistent chrome. DOM-level on
 *  purpose: the origin row is a sibling React branch, and a one-shot class
 *  beats threading transient state through the whole list. */
function flashLineage(issueId: string): void {
  const el = document.querySelector(`[data-issue-row="${CSS.escape(issueId)}"]`)
  if (!(el instanceof HTMLElement)) return
  el.classList.remove('morph-lineage')
  void el.offsetWidth
  el.classList.add('morph-lineage')
  window.setTimeout(() => el.classList.remove('morph-lineage'), 1700)
}

/**
 * One issue row in the work list. Agent drafts (draft issue whose only content
 * is agents, no worktree) click straight into their session. Real issues show
 * the ID square and expand (default expanded) to their member sessions from 2
 * agents up.
 */
export function UnifiedIssueRow({
  row,
  sessions: _all,
  issues,
  allWorktreePaths,
  selectedIssueId,
  paneA,
  now,
  onSelectIssue,
  onSelectPanelForIssue,
  onOpenIssue,
  onRenameIssue,
  onColorChangeIssue,
  onGripDown,
  onTuck,
  /** Visual nesting depth for started-by children (0 = top-level). */
  startedByDepth = 0,
}: {
  row: UnifiedIssueRowView
  sessions: SessionMeta[]
  /** Whole issue list — the context menu's label pool / duplicate targets. */
  issues: IssueNavigationModel[]
  allWorktreePaths: string[]
  selectedIssueId: string | null
  paneA: string | null
  now: number
  onSelectIssue: (issue: IssueNavigationModel) => void
  onSelectPanelForIssue: (issue: IssueNavigationModel, sessionId: SessionId) => void
  /** Open the issue PAGE (the context menu's "Open"). */
  onOpenIssue: (id: IssueId) => void
  onRenameIssue: (id: string, title: string) => void
  onColorChangeIssue: (id: string, color: IssueColorSlot | null) => unknown
  /** Manual-sort drag start (POD-168); absent = row not draggable. */
  onGripDown?: (e: ReactPointerEvent, issueId: string) => void
  /** Dismiss a finished row into the Closed fold (POD-293); absent = not a
   *  tuckable done row, so the control is hidden. */
  onTuck?: () => void
  startedByDepth?: number
}): JSX.Element {
  const { issue, sessions: mine, startedByChildren = [] } = row
  const active = selectedIssueId === issue.id
  const unread = rowUnreadEmphasized(row)
  // Agents are a count, not always-on rows (POD-293): a non-pinned issue folds
  // its roster/subtask detail by default, so the list reads as one calm line per
  // task with the fleet glyph carrying "N agents". Pinned issues — the ones you
  // chose to watch — stay expanded. Per-issue toggles still persist and win.
  const [collapsed, toggle] = useCollapsed(issueRowFoldKey(issue.id), !issue.pinned)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  // The rename lifecycle and its commit policy live in `use-inline-rename.ts`;
  // the row keeps only the slot it renders into.
  const rename = useInlineRename(issue.title, (next) => onRenameIssue(issue.id, next))
  const renameEditor = inlineRenameEditor(rename, ({ onCommit, onCancel }) => (
    <SessionNameEditor value={issue.title} onCommit={onCommit} onCancel={onCancel} />
  ))
  // Sessions earning visibility (multi-agent / remote spawn / native subagents)
  // render in the ADJACENT roster band (L2), never inside the issue tree. The
  // issue disclosure folds all detail while the compact fleet summary remains.
  // A LONE driver never earns a band (POD-267) — it fuses into the row as the
  // fleet-summary glyph, nested subtasks or not; boxing one agent alongside plan
  // structure spent a whole tone tier on a single icon.
  const showSessions = sessionsNeedChildRows(mine)
  const hasStartedBy = startedByChildren.length > 0
  // Depth cap (L4): the sidebar renders parent + children, then numbers. A
  // depth-1 row never recurses — its whole subtree compresses into the quiet
  // roll-up line, counted over ALL descendants (parentId edges) so done
  // children that already decayed out of rows still show up in the k/m (L5).
  const capped = startedByDepth >= 1
  const rollup = capped ? branchRollup(issues, issue.id) : null
  const showRollup = rollup !== null && rollup.total > 0
  const fleetSessions = row.aggregateSessions ?? mine
  // How many of this row's agents are leads/coordinators — counted over the
  // whole mission subtree, since a lead usually sits on a child task. The
  // subtree projection is the Flight Deck's, so the sidebar and the deck can
  // never disagree about what belongs to a mission. Memoized: this is the
  // sidebar's hot render path and the walk is over every issue.
  const leadCount = useMemo(() => {
    const missionIds = missionIssueIds(issues, issue.id)
    const leadIds = new Set(
      issues
        .filter((candidate) => missionIds.has(candidate.id))
        .map((candidate) => candidate.coordinatorSessionId)
        .filter((id): id is SessionId => Boolean(id)),
    )
    return fleetSessions.filter((session) => leadIds.has(session.sessionId)).length
  }, [issues, issue.id, fleetSessions])
  const missionProgress = !issue.parentId ? branchRollup(issues, issue.id) : null
  const { visible, stale } = partitionStaleSessions(mine, now)
  const phase = rowMotionPhase(row)
  // What this row is asking of the human, if anything (POD-279).
  const decision = rowPendingDecision(row)
  const waitingCount = rowWaitingCount(row)
  const timing = rowMotionTiming(row)
  const hex = issueColorHex(issue.color)
  const square = (
    <IdSquare
      issue={issue}
      state={phase}
      selected={active}
      size={30}
      // The ask wins the corner (amber dot); otherwise a working row shows the
      // blue spinner badge on the square itself (POD-293), not beside line 2.
      badge={waitingCount > 0 ? { kind: 'dot' } : phase === 'working' ? { kind: 'spinner' } : null}
      onColorChange={(color) => onColorChangeIssue(issue.id, color)}
    />
  )
  // Spin-off provenance (POD-85): an outgoing discovered-from edge names the
  // issue this one was spun off from. One quiet ⤷ tick on line 2; selecting
  // the row flashes the origin.
  const originDep = issue.deps.find((d) => d.type === 'discovered-from')
  const origin = originDep ? issues.find((i) => i.id === originDep.id) : undefined
  // Draft vessel whose only content is agents → clicking opens the session.
  // Shared with the nesting rule so structure and rendering agree (POD-282).
  const draftAgentOnly = isDraftAgentVessel(issue, mine)
  const first = mine[0]
  const label = issue.draft ? draftIssueLabel(issue, _all, allWorktreePaths) : issue.title
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    setMenuAnchor({ x: e.clientX, y: e.clientY })
  }
  // The right-click menu (mirrors the board / SessionContextMenu pattern):
  // cursor-anchored portal, acts on this one issue, rendered alongside the row.
  const menu = menuAnchor ? (
    <IssueContextMenu
      issues={[issue]}
      allIssues={issues}
      surface="sidebar"
      anchor={menuAnchor}
      onClose={() => setMenuAnchor(null)}
      onOpen={(id) => {
        setMenuAnchor(null)
        onOpenIssue(id)
      }}
      onRename={() => {
        setMenuAnchor(null)
        rename.begin()
      }}
    />
  ) : null
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanelForIssue(issue, session.sessionId)}
      dotRight
      roster
      stub
      coordinator={isCoordinatorSession(issue, session.sessionId)}
      issueDisplayRef={issue.displayRef}
    />
  )
  // The rail-navy roster band (L2): AGENTS · N, adjacent to the row.
  const band =
    !draftAgentOnly && showSessions ? (
      <AgentRosterBand
        label="Agents"
        count={mine.length}
        variant="rail"
        className="mt-0.5 mb-[3px] ml-8"
      >
        <GroupedSessionRows sessions={visible} render={renderRow} dense />
        <StaleSection sessions={stale} render={renderRow} dense />
      </AgentRosterBand>
    ) : undefined
  return (
    <>
      <WorkRowShell
        testId={startedByDepth > 0 ? 'unified-issue-row-started-by' : 'unified-issue-row'}
        deemphasized={issue.audience === 'agent'}
        square={square}
        label={label}
        onTuck={onTuck}
        statusLine={
          decision !== null ? (
            // The one word that answers "what is being asked of me here" — a
            // merge states its commit count so the row is a fact, not a mood
            // (POD-279). It is the row's single amber voice (POD-293): plain
            // weighted text, no box, no icon — the boxed chip made every review
            // row shout. The git stamp's own "N commits ahead" is suppressed
            // below: one voice per region (DESIGN.md, The Signal Rule).
            <span
              data-testid={decision === 'merge' ? 'awaiting-merge-status' : 'needs-review-status'}
              data-decision={decision}
              title={pendingDecisionTitle(issue, decision)}
              className="flex-none font-semibold text-attention"
            >
              {pendingDecisionLabel(issue, decision)}
            </span>
          ) : (
            rowStatusLine(row, now, capped ? 0 : 1)
          )
        }
        hex={hex}
        phase={phase}
        waitingCount={waitingCount}
        // Suppress the amber pill when the row already states its ask in words
        // (needs review / ready to merge) — one amber voice per region (POD-293).
        showWaitingPill={decision === null}
        timeMeta={
          <PhaseTimer
            phase={timing.phase}
            sinceMs={timing.sinceMs}
            baseMs={timing.baseMs ?? 0}
            totalMs={timing.totalMs}
            size={11}
            showSpinner={false}
            plainLanguage
            leadingSeparator
            mutedWaiting
            className="flex-none"
          />
        }
        active={draftAgentOnly ? active && paneA === first?.sessionId : active}
        // The chevron folds the agent ROSTER only (POD-293) — subtasks are
        // always-visible rows, so a subtask-only issue needs no toggle.
        gitStamp={
          issue.gitState && (
            <GitStamp
              issueBranch={issue.branch}
              git={issue.gitState}
              density="stamp"
              suppressAhead={decision === 'merge'}
              className="flex-none"
            />
          )
        }
        unread={unread}
        expandable={!draftAgentOnly && showSessions}
        collapsed={draftAgentOnly ? true : collapsed}
        onToggle={toggle}
        band={band}
        hasTreeChildren={showRollup || (!capped && hasStartedBy)}
        // A draft is just its agent — clicking the row opens the session itself.
        onSelect={
          draftAgentOnly && first
            ? () => onSelectPanelForIssue(issue, first.sessionId)
            : () => {
                if (origin) flashLineage(origin.id)
                onSelectIssue(issue)
              }
        }
        domMark={issue.id}
        onGripDown={
          onGripDown && !isIssueDeferred(issue, now) ? (e) => onGripDown(e, issue.id) : undefined
        }
        childDragScope={!capped && hasStartedBy ? `children:${issue.id}` : undefined}
        childrenTestId={!capped && hasStartedBy ? 'started-by-children' : undefined}
        statusExtra={
          origin && (
            <span
              className="shell-type-micro flex-none font-mono tabular-nums"
              data-testid="spinoff-origin-tick"
              title={`Spun off from ${issueDisplayRef(origin)} · ${origin.title}`}
            >
              ⤷ {origin.seq}
            </span>
          )
        }
        onContextMenu={onContextMenu}
        onDoubleClick={() => rename.begin()}
        editor={renameEditor}
        titleHint={issueIdTitle(issue)}
        extras={
          <>
            {/* The row's ref lives in the identity square alone (POD-85) — the
                muted repeat here doubled every row's ID for no added signal.
                Hover still surfaces the full ref via titleHint. */}
            {issue.audience === 'agent' && (
              <span
                className="shell-type-micro flex-none rounded border border-slate-500/40 px-1 uppercase tracking-wide text-slate-500"
                data-testid="internal-issue-badge"
              >
                internal
              </span>
            )}
            {!draftAgentOnly && (
              <IssueFleetSummary
                sessions={fleetSessions}
                leadCount={leadCount}
                unread={unread}
              />
            )}
            {/* No started-by/epic jargon chips (POD-85): the dashed provenance
                nest and the expand chevron already say it visually. */}
            {issue.pinned && (
              <Pin size={10} className="flex-none text-muted-foreground" aria-hidden="true" />
            )}
            {isIssueDeferred(issue, now) && (
              <AlarmClock
                size={10}
                className="flex-none text-muted-foreground"
                aria-label="Snoozed"
              />
            )}
            {issueReturnedFromDefer(issue, now) && (
              <span
                className="shell-type-micro flex-none rounded border border-amber-500/40 px-1 font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                title="Snooze ended — back in your queue"
              >
                Unsnoozed
              </span>
            )}
          </>
        }
      >
        {missionProgress && missionProgress.total > 0 && (
          <div
            className="mb-1 ml-10 flex items-center gap-2 pr-3"
            data-testid="mission-subtree-progress"
            aria-label={`${missionProgress.done} of ${missionProgress.total} subtree tasks done`}
          >
            {/* Same datum, same treatment as the Flight Deck's mission meter
                (FlightDeck's ProgressBar): Accent Blue data on the secondary
                surface. Two colours for one number one column apart would read
                as two different facts. */}
            <div className="h-[3.5px] flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-info"
                style={{ width: `${(missionProgress.done / missionProgress.total) * 100}%` }}
              />
            </div>
            <span className="shell-type-micro font-mono tabular-nums text-text-faint">
              {missionProgress.done}/{missionProgress.total}
            </span>
            {waitingCount > 0 && (
              <span className="shell-type-micro font-mono font-semibold text-attention">
                {waitingCount} need you
              </span>
            )}
          </div>
        )}
        {showRollup && rollup && (
          // Roll-up line (L4): depth beyond two levels becomes numbers. Mono,
          // faint, still; hover surfaces the affordance; click deep-links to
          // the issue page's subtask tree — no third indent, no camera modes.
          <button
            data-pressable
            type="button"
            data-testid="subtree-rollup"
            className="shell-type-micro group/rollup mb-0.5 ml-6 flex w-[calc(100%-2rem)] cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-left font-mono text-muted-foreground/70 hover:bg-white/[.04] hover:text-muted-foreground"
            title={`Open ${issueIdTitle(issue)} subtask tree`}
            onClick={() => onOpenIssue(issue.id)}
          >
            └ {rollup.total} deeper · {rollup.done}/{rollup.total} done
            <span
              data-hover-reveal
              className="shell-type-micro ml-auto flex-none opacity-0 transition-opacity duration-150 group-hover/rollup:opacity-100"
              aria-hidden="true"
            >
              open tree ↗
            </span>
          </button>
        )}
        {!draftAgentOnly &&
          !capped &&
          hasStartedBy &&
          startedByChildren.map((child) => (
            <div
              key={`issue:${child.issue.id}`}
              className="ml-5 min-w-0"
              {...(!isIssueDeferred(child.issue, now) ? { 'data-drag-key': child.issue.id } : {})}
            >
              <UnifiedIssueRow
                row={child}
                allWorktreePaths={allWorktreePaths}
                sessions={_all}
                issues={issues}
                selectedIssueId={selectedIssueId}
                paneA={paneA}
                now={now}
                onSelectIssue={onSelectIssue}
                onSelectPanelForIssue={onSelectPanelForIssue}
                onOpenIssue={onOpenIssue}
                onRenameIssue={onRenameIssue}
                onColorChangeIssue={onColorChangeIssue}
                onGripDown={onGripDown}
                startedByDepth={startedByDepth + 1}
              />
            </div>
          ))}
      </WorkRowShell>
      {menu}
    </>
  )
}

/** Provenance whisper for an orphaned session (L6): a session whose issue was
 *  deleted or archived names its origin — `from POD-32 · deleted` — instead of
 *  silently pooling into an anonymous branch row. Presentation only; the
 *  data-layer orphan fix is POD-135. */
