import {
  draftIssueLabel,
  isDraftAgentVessel,
  type IssueNavigationModel,
  missionProgress,
  pendingDecisionLabel,
  pendingDecisionTitle,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import type { AgentKind, IssueColorSlot, IssueId, SessionId, SessionMeta } from '@podium/model'
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { AlarmClock, Pin } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useMemo, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { IdSquare } from '@/components/IdSquare'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/lib/issue-labels'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { issueColorHex } from '@/lib/issueColors'
import { PhaseTimer } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { cn } from '@/lib/utils'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { RowProgressMeter } from './row-progress'
import { inlineRenameEditor, useInlineRename } from './use-inline-rename'
import { WorkRowShell } from './WorkRowShell'

/** How many distinct harness tiles a fleet stack shows before the total alone
 *  carries the rest. The approved artifact stacks kinds, not agents — three is
 *  what its widest mission renders. */
const FLEET_KIND_LIMIT = 3

/**
 * The mission's execution presence, in the approved artifact's `fleet-summary`
 * anatomy: a stack of REAL harness-kind tiles, the live agent total once there
 * is more than one, and `×N` for native (in-process Task) children.
 *
 * Kinds, not sessions. A nine-agent mission running three harnesses shows three
 * tiles and a `9`, not nine tiles — the question the stack answers is "who is
 * here", and the number answers "how many". Everything is client-derived from
 * the row's bubbled session set; nothing is stored on the issue.
 */
function FleetSummary({
  sessions,
  unread = false,
}: {
  sessions: SessionMeta[]
  /** An unopened update since last read (POD-293): a single info dot on the
   *  agent identity, not a shouted banner. Bound to the fleet glyph so it reads
   *  as "this agent has something new", never a free-floating third dot. */
  unread?: boolean
}): JSX.Element | null {
  const live = sessions.filter(
    (session) =>
      !session.archived && session.status !== 'exited' && session.status !== 'hibernated',
  )
  if (live.length === 0) return null
  const kinds: AgentKind[] = []
  for (const session of live) {
    if (!kinds.includes(session.agentKind)) kinds.push(session.agentKind)
  }
  const shown = kinds.slice(0, FLEET_KIND_LIMIT)
  const nativeCount = live.reduce(
    (sum, session) => sum + (session.agentState?.nativeSubagentCount ?? 0),
    0,
  )
  // The artifact's tooltip, verbatim in structure: the two facts the stack
  // itself compresses. Leads are not in it — a coordinator is the Flight Deck's
  // fact, and repeating it here spent a third clause on a glyph cluster.
  const label = `${live.length} live agent${live.length === 1 ? '' : 's'}${
    nativeCount > 0 ? ` · ${nativeCount} native children` : ''
  }`
  return (
    <span
      className="ml-0.5 flex flex-none items-center gap-[5px]"
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
    >
      <span className="flex items-center pl-1">
        {shown.map((kind, index) => {
          const AgentIcon = agentIconFor(kind)
          // Per-kind tint (POD-293): Claude wears its clay, other harnesses a
          // quiet navy — solid fills so stacked tiles don't ghost through each
          // other. A table keyed by kind, not a comparison (see @/lib/agent-tone).
          const tileTint = agentFleetTileTint(kind)
          // The row's unopened-update dot rides the corner of the LAST tile (the
          // artifact's `.fleet-tile .dot`): tight to the glyph at -3px, ringed in
          // the row background — "this fleet has something new", not a third
          // free-floating mark.
          const showDot = unread && index === shown.length - 1
          return (
            <span
              key={kind}
              data-agent-kind={kind}
              className={cn(
                'relative flex size-[19px] items-center justify-center rounded-[6px] border',
                tileTint,
                index > 0 && '-ml-[5px]',
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
      </span>
      {live.length > 1 && (
        <span
          className="shell-type-micro font-mono tabular-nums text-muted-foreground"
          data-testid="issue-fleet-total"
        >
          {live.length}
        </span>
      )}
      {nativeCount > 0 && (
        <span
          className="shell-type-micro rounded-[5px] border border-claude/35 bg-claude/12 px-[3px] font-mono text-claude"
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
 * ONE FLAT ROW PER MISSION (POD-516 §1.1, from the approved artifact's
 * `workRow`).
 *
 * The worklist is the human's list of missions, and that is all it is. There is
 * no disclosure twist, no agent roster band, no session rows, no native-subagent
 * rows and no recursion into child issues — the artifact's `renderWork` emits a
 * flat list of mission roots and two group folds, and nothing else. The doctrine
 * behind it: "a session is shown directly beneath the issue it belongs to; its
 * spawn parent and native workers are secondary details, not a competing
 * navigation tree". The tree lives one column right, in the Flight Deck.
 *
 * What a subtree still owes this row is its SUMMARY: attention bubbles up
 * (`rowWaitingCount` counts the whole branch), the status line names the deepest
 * source when the ask is hidden below, and the fleet stack speaks for every
 * descendant session. All of it is derived here from the row's bubbled session
 * set — no stored aggregates.
 *
 * Agent drafts (a draft issue whose only content is agents, no worktree) click
 * straight into their session; real issues select the mission.
 */
export function UnifiedIssueRow({
  row,
  sessions: allSessions,
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
}): JSX.Element {
  const { issue, sessions: mine } = row
  const active = selectedIssueId === issue.id
  const unread = rowUnreadEmphasized(row)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  // The rename lifecycle and its commit policy live in `use-inline-rename.ts`;
  // the row keeps only the slot it renders into.
  const rename = useInlineRename(issue.title, (next) => onRenameIssue(issue.id, next))
  const renameEditor = inlineRenameEditor(rename, ({ onCommit, onCancel }) => (
    <SessionNameEditor value={issue.title} onCommit={onCommit} onCancel={onCancel} />
  ))
  // The row speaks for its whole branch: descendants have no row of their own
  // here, so the fleet stack reads the bubbled aggregate.
  const fleetSessions = row.aggregateSessions ?? mine
  const phase = rowMotionPhase(row)
  // What this row is asking of the human, if anything (POD-279).
  const decision = rowPendingDecision(row)
  const waitingCount = rowWaitingCount(row)
  const timing = rowMotionTiming(row)
  // The row's own progress, at the scope the row speaks for: its whole mission.
  // `missionProgress` is the Flight Deck's derivation, imported rather than
  // restated — the two columns must never disagree about how far a mission is,
  // and it already handles both formal parentId children and agent-started
  // provenance. Memoised on the store's own array identities, so a `now` tick
  // re-renders the row without re-walking the issue graph.
  const progress = useMemo(
    () => missionProgress(issues, allSessions, issue.id),
    [issues, allSessions, issue.id],
  )
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
  const label = issue.draft ? draftIssueLabel(issue, allSessions, allWorktreePaths) : issue.title
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
  return (
    <>
      <WorkRowShell
        testId="unified-issue-row"
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
            // Nothing below this row renders (the mission's tree is the Flight
            // Deck's), so the status line reports at visible depth 0: an ask
            // buried three levels down names its source instead of a bare
            // "needs you" with no visible row to explain it.
            rowStatusLine(row, now, 0)
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
        // The row's baseline progress rule (POD-516 round 3). Renders only where
        // there is a real done/total — a mission of two tasks or more — and the
        // running segment sweeps only while `phase` says an agent on this row is
        // genuinely computing, which is the same gate as the square's spinner.
        meter={<RowProgressMeter progress={progress} working={phase === 'working'} />}
        active={draftAgentOnly ? active && paneA === first?.sessionId : active}
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
            {!draftAgentOnly && <FleetSummary sessions={fleetSessions} unread={unread} />}
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
      />
      {menu}
    </>
  )
}
