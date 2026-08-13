import {
  draftIssueLabel,
  type IssueNavigationModel,
  isDraftAgentVessel,
  issueContinuation,
  missionProgress,
  pendingDecisionLabel,
  pendingDecisionTitle,
  rowHasWorkingSession,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import {
  asSessionId,
  type IssueColorSlot,
  type IssueId,
  type SessionId,
  type SessionMeta,
} from '@podium/model/browser'
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { AlarmClock, Pin } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useMemo, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { IdSquare } from '@/components/IdSquare'
import { IssueFleetSummary } from '@/components/IssueFleetSummary'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/lib/issue-labels'
import { issueColorHex } from '@/lib/issueColors'
import { BrailleSpinner, PhaseTimer } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { RowProgressMeter } from './row-progress'
import { inlineRenameEditor, useInlineRename } from './use-inline-rename'
import { WorkRowShell } from './WorkRowShell'

/** Lineage flash (POD-85): briefly outline another issue's row — provenance as
 *  a gesture when a spin-off is selected, not persistent chrome. DOM-level on
 *  purpose: the origin row is a sibling React branch, and a one-shot class
 *  beats threading transient state through the whole list. */
function flashLineage(issueId: IssueId): void {
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
  shortcutDigit,
}: {
  row: UnifiedIssueRowView
  sessions: SessionMeta[]
  /** Whole issue list — the context menu's label pool / duplicate targets. */
  issues: IssueNavigationModel[]
  allWorktreePaths: string[]
  selectedIssueId: IssueId | null
  paneA: string | null
  now: number
  onSelectIssue: (issue: IssueNavigationModel) => void
  onSelectPanelForIssue: (issue: IssueNavigationModel, sessionId: SessionId) => void
  /** Open the issue PAGE (the context menu's "Open"). */
  onOpenIssue: (id: IssueId) => void
  onRenameIssue: (id: string, title: string) => void
  onColorChangeIssue: (id: string, color: IssueColorSlot | null) => unknown
  /** Manual-sort drag start (POD-168); absent = row not draggable. */
  onGripDown?: (e: ReactPointerEvent, issueId: IssueId) => void
  /** Dismiss a finished row into the Closed fold (POD-293); absent = not a
   *  tuckable done row, so the control is hidden. */
  onTuck?: () => void
  /** This row's ⌘-hold digit (POD-790); absent unless Command is down. */
  shortcutDigit?: number
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
  // Is an agent on this mission computing right now? NOT the same question as
  // the phase, which an ask outranks — and the row is the mission's only line
  // here, so the phase alone left a running fleet reading as stillness
  // (POD-703). This is the predicate every working texture below gates on.
  const working = rowHasWorkingSession(row)
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
  const issueById = useMemo(
    () => new Map(issues.map((candidate) => [candidate.id as string, candidate])),
    [issues],
  )
  const hex = issueColorHex(issue.color)
  const square = (
    <IdSquare
      issue={issue}
      state={phase}
      selected={active}
      size={30}
      // The corner badge punches out of the ROW's own ground, not the card tier
      // it used to assume — a white ring around the dot was visible on every
      // paper row. `--row-bg` is set by the tinted-row case in WorkRowShell; the
      // fallback covers plain and selected rows, whose ground is the column.
      ringColor="var(--row-bg, var(--sidebar))"
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
  // A closed handoff points FORWARD. That answer outranks the provenance tick:
  // an old row saying only "done ⤷ 766" explains its ancestry but gives no
  // route to the task where the work actually continued.
  const continuation = issueContinuation(issue, issueById)
  const continuationStatus = continuation
    ? continuation.full.charAt(0).toLowerCase() + continuation.full.slice(1)
    : null
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
      issues={[{ ...issue, memberSessionIds: issue.memberSessionIds?.map(asSessionId) }]}
      allIssues={issues.map((candidate) => ({
        ...candidate,
        memberSessionIds: candidate.memberSessionIds?.map(asSessionId),
      }))}
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
        shortcutDigit={shortcutDigit}
        label={label}
        onTuck={onTuck}
        statusLine={
          <>
            {/* THE ONE WORKING MARK ON A ROW THAT IS ALSO ASKING (POD-703). The
                square's corner belongs to the ask (The Signal Rule), so when
                both are true the spinner comes back to line 2 — the place
                POD-293 moved it away from precisely because the square already
                carried it. There is no duplication here: the square is amber,
                so this is the row's only "an agent is computing" mark, in the
                motion grammar's own device and its calm blue. */}
            {working && phase !== 'working' && (
              // `.spb` already paints itself `--motion-working`, so the glyph
              // stays calm blue inside a dim waiting lockup without a prop.
              <BrailleSpinner size={9} className="mr-1" />
            )}
            {decision !== null ? (
              // The one word that answers "what is being asked of me here" — a
              // merge states its commit count so the row is a fact, not a mood
              // (POD-279). It is the row's single amber voice (POD-293): plain
              // weighted text, no box, no icon — the boxed chip made every
              // review row shout. The git stamp's own "N commits ahead" is
              // suppressed below: one voice per region (DESIGN.md, The Signal
              // Rule).
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
              (continuationStatus ?? rowStatusLine(row, now, 0))
            )}
          </>
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
            // One phrase, one size (POD-783). "needs review · 8h ago" is a single
            // mono sentence on line 2, so the timer matches the status word it
            // follows rather than setting its own — it was 11px when POD-450
            // pinned the row, then drifted to 10px against a 12px status line.
            size={12}
            showSpinner={false}
            plainLanguage
            leadingSeparator
            mutedWaiting
            className="flex-none"
          />
        }
        // The row's baseline progress rule (POD-516 round 3). Renders only where
        // there is a real done/total — a mission of two tasks or more — and the
        // running segment sweeps only while an agent on this row is genuinely
        // computing. That predicate is `rowHasWorkingSession`, which is what
        // DESIGN.md §Motion sanctions this sweep on; gating it on the row's
        // PHASE instead meant a concurrent ask froze the meter of a mission that
        // was still running (POD-703).
        meter={<RowProgressMeter progress={progress} working={working} />}
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
          origin &&
          !continuation && (
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
            {/* One rule, no exceptions: an agent on this issue or anywhere in its
                subtree shows here. Drafts used to be carved out on the grounds
                that their row already WAS the agent — true when the sidebar was
                the only column, but the Flight Deck owns the tree now and the
                draft row kept nothing but an issue square, so the one row that
                is purely an agent was the one row that never named one. */}
            <IssueFleetSummary sessions={fleetSessions} className="ml-0.5" />
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
