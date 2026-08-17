import {
  draftIssueLabel,
  type IssueNavigationModel,
  isDraftAgentVessel,
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
  type IssueId,
  isIssueDeferred,
  issueReturnedFromDefer,
  type SessionId,
  type SessionMeta,
} from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { idSquareLabel } from '@/components/IdSquare'
import { IssueFleetSummary } from '@/components/IssueFleetSummary'
import { issueIdTitle } from '@/lib/issue-labels'
import { issueColorHex } from '@/lib/issueColors'
import { PhaseTimer, WorkingMark } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { RowProgressMeter } from './row-progress'
import { inlineRenameEditor, useInlineRename } from './use-inline-rename'
import { WorkRowShell } from './WorkRowShell'

// Deferred for the same reason `SessionContextMenu` is (sidebar-common): the
// menu exists only after a right-click, and it drags the whole issue-lifecycle
// vocabulary — stage moves, dependency edits, spin-off — behind it. Every row in
// the work list rendered it eagerly, so the first paint paid for a gesture no
// one had made yet.
const IssueContextMenu = lazy(() =>
  import('@/features/issues/IssueContextMenu').then((module) => ({
    default: module.IssueContextMenu,
  })),
)

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
  const hex = issueColorHex(issue.color)
  // THE ROW'S IDENTITY IS ITS NUMBER (POD-1057). The 30px square carried the
  // ref, the phase, a corner badge and the colour picker — four jobs on the
  // smallest object in the row. Each went somewhere it reads better: the ref is
  // these digits, the phase and the ask are line 2's one ochre sentence, the
  // spinner is the meta column's clock, the picker is in the context menu. The
  // colour stayed: it is the band's ground.
  const idLabel = idSquareLabel(issue)
  // Spin-off provenance (POD-85): an outgoing discovered-from edge names the
  // issue this one was spun off from. One quiet ⤷ tick on line 2; selecting
  // the row flashes the origin.
  const originDep = issue.deps.find((d) => d.type === 'discovered-from')
  const origin = originDep ? issues.find((i) => i.id === originDep.id) : undefined
  // A closed handoff points FORWARD. That answer outranks the provenance tick:
  // an old row saying only "done ⤷ 766" explains its ancestry but gives no
  // route to the task where the work actually continued.
  //
  // Read off the ROW, not recomputed here (POD-1193). The same verdict now
  // withdraws the row's amber in `rowPendingDecision`, and a list that decides
  // its attention from one derivation and its words from another can disagree
  // with itself. It is also a graph walk per row per render, gone.
  const continuationStatus = row.continuation ?? null
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
    <Suspense fallback={null}>
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
    </Suspense>
  ) : null
  // WHERE THE LIFECYCLE STAMP GOES, BY PHASE (3a). A working row's clock and a
  // waiting row's "how long has this sat there" belong in line 1's meta column,
  // where they tabulate. A finished row's `67:44 total` does not: it is the tail
  // of a sentence, prose rather than a reading — and on a done row the meta
  // column is already spoken for by the tuck chip.
  const timer = (
    <PhaseTimer
      phase={timing.phase}
      sinceMs={timing.sinceMs}
      baseMs={timing.baseMs ?? 0}
      totalMs={timing.totalMs}
      // The micro role, matching line 2 and the id gutter — every mono mark in
      // this row is now set at one size (POD-783's floor).
      size={10.5}
      // The design puts the braille spinner in front of the running clock, and
      // that is the ONLY perpetual motion in the row (DESIGN.md §5).
      showSpinner={timing.phase === 'working'}
      plainLanguage
      leadingSeparator={timing.phase === 'done'}
      mutedWaiting
      // The artboard's meta column: a blue braille cell in front of NEUTRAL
      // digits. The row's blue lives on the spinner and on the meter's running
      // segment; a blue clock beside them was a third voice for one fact.
      mutedWorking
      className="flex-none"
    />
  )
  return (
    <>
      <WorkRowShell
        testId="unified-issue-row"
        deemphasized={issue.audience === 'agent'}
        idNumber={idLabel.number}
        idLabel={idLabel.full}
        shortcutDigit={shortcutDigit}
        label={label}
        onTuck={onTuck}
        statusLine={
          <>
            {/* THE ONE WORKING MARK ON A ROW THAT IS ALSO ASKING (POD-703): a
                waiting row's meta column holds the ask's stamp, so a spinner for
                an agent still computing comes back here. */}
            {working && phase !== 'working' && (
              // The mark already paints itself `--motion-working`, so it stays
              // calm blue inside an ochre waiting lockup without a prop.
              <WorkingMark size={12} className="mr-1" />
            )}
            {/* THE PILL'S WORDS, WITHOUT THE PILL (3a): the count was the part
                worth keeping, so it leads the sentence line 2 was already
                saying, in that line's own ochre. */}
            {decision === null && waitingCount > 1 && (
              <span className="flex-none" data-testid="need-count">
                {waitingCount} need you ·{' '}
              </span>
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
        timeMeta={timing.phase === 'done' ? undefined : timer}
        statusTime={timing.phase === 'done' ? timer : undefined}
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
          !continuationStatus && (
            <span
              // No size of its own: line 2 sets one, and a second here was what
              // made the tick's line box taller than the sentence it annotates.
              className="flex-none tabular-nums"
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
        // LINE 1 IS A TITLE AND A TIME (3a). Everything that trailed the title
        // now leads line 2 in the machine voice. The pin and the alarm did not
        // survive the move: a pinned row is under the PINNED band and a snoozed
        // one inside the Snoozed fold, so both restated the row's own address.
        marks={
          <>
            {/* One rule, no exceptions: an agent on this issue or anywhere in its
                subtree shows here. Drafts used to be carved out on the grounds
                that their row already WAS the agent — true when the sidebar was
                the only column, but the Flight Deck owns the tree now, and the
                one row that is purely an agent was the one row that never named
                one. */}
            <IssueFleetSummary sessions={fleetSessions} size={11} variant="glyphs" />
            {issue.audience === 'agent' && (
              <span className="flex-none text-text-dim" data-testid="internal-issue-badge">
                internal
              </span>
            )}
            {issueReturnedFromDefer(issue, now) && (
              <span
                className="flex-none font-semibold text-attention"
                title="Snooze ended — back in your queue"
              >
                unsnoozed
              </span>
            )}
          </>
        }
      />
      {menu}
    </>
  )
}
