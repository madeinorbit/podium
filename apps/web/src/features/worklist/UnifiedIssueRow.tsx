import {
  type IssueNavigationModel,
  isDraftAgentVessel,
  type MissionProgress,
  pendingDecisionTitle,
  rowErrorLine,
  rowHasWorkingSession,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import { LOADING } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import {
  asSessionId,
  type IssueId,
  isIssueDeferred,
  issueReturnedFromDefer,
  type SessionId,
} from '@podium/model/browser'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { lazy, memo, Suspense, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { idSquareLabel } from '@/components/IdSquare'
import { IssueFleetSummary } from '@/components/IssueFleetSummary'
import type { IssueMenuPoolInputs } from '@/features/issues/issue-menu-pool-inputs'
import { throughRestarts } from '@/lib/chunk-recovery'
import { issueIdTitle } from '@/lib/issue-labels'
import { issueColorHex } from '@/lib/issueColors'
import { PhaseTimer, WorkingMark } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import type { PoolIssueDisplay } from './pool-row-data'
import { RowProgressMeter } from './row-progress'
import { measureSidebarRow } from './sidebar-measurements'
import { inlineRenameEditor, useInlineRename } from './use-inline-rename'
import { WorkRowShell } from './WorkRowShell'

// Deferred for the same reason `SessionContextMenu` is (sidebar-common): the
// menu exists only after a right-click, and it drags the whole issue-lifecycle
// vocabulary — stage moves, dependency edits, spin-off — behind it. Every row in
// the work list rendered it eagerly, so the first paint paid for a gesture no
// one had made yet.
const IssueContextMenu = lazy(() =>
  throughRestarts(() => import('@/features/issues/IssueContextMenu')).then((module) => ({
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
 * The spin-off origin a row displays, narrowed to what the tick renders
 * (POD-4421). The parent resolves the `discovered-from` edge once per list
 * through a by-id map and hands each row its own tick; the row never sees the
 * whole issue array. `null` = no origin tick.
 */
export interface UnifiedIssueRowOrigin {
  id: IssueId
  seq: number
  title: string
  ref: string
}

/** Context-menu payload, built on open only (POD-4421). */
export interface UnifiedIssueRowMenuData {
  single: IssueNavigationModel[]
  all: IssueNavigationModel[]
  poolInputs: IssueMenuPoolInputs | typeof LOADING
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
 * What a subtree still owes this row is its summary. Task progress comes from
 * the formal child-task rollup, while attention and the fleet remain separate
 * agent signals. The status words never infer task state from those sessions.
 *
 * Agent drafts (a draft issue whose only content is agents, no worktree) click
 * straight into their session; real issues select the mission.
 *
 * MEMOIZED OVER NARROW PROPS (POD-4421). The row receives its own row object
 * (stable across publishes via `reuseUnifiedWorkRows`), its display title, its
 * progress and its origin tick as scalars, plus stable callbacks. It must NOT
 * receive whole arrays: a fresh `issues`/`sessions` identity per publish used
 * to re-render every visible row on every publish, and each row then ran its
 * own `issues.find` on top.
 */
function UnifiedIssueRowInner({
  row,
  now,
  onSelectIssue,
  onSelectPanelForIssue,
  onOpenIssue,
  onRenameIssue,
  onGripDown,
  onTuck,
  shortcutDigit,
  displayTitle: displayTitleProp,
  progress: progressProp,
  origin = null,
  active = false,
  resolveMenuData,
  display,
}: {
  row: UnifiedIssueRowView
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
  /** Narrow display title, computed once per list (POD-4421). */
  displayTitle?: string
  /** Narrow progress: the row's own rollup, fallback computed per list. */
  progress?: MissionProgress
  /** Narrow origin tick; absent means none. */
  origin?: UnifiedIssueRowOrigin | null
  /** Narrow selection (the draft paneA rule already applied by the parent). */
  active?: boolean
  /** Menu payload built on open only, so the row holds no issue array. */
  resolveMenuData?: () => UnifiedIssueRowMenuData
  /** Pool facts: presentation stays here, with no legacy row derivation. */
  display?: PoolIssueDisplay
}): JSX.Element {
  const { issue, sessions: mine } = row
  const unread = display?.unread ?? rowUnreadEmphasized(row)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  // WHAT THE ROW CALLS THIS TASK — never the raw title, which on a draft is the
  // composer's placeholder. The parent computes the display title once.
  const label = displayTitleProp ?? issue.title
  // The rename lifecycle and its commit policy live in `use-inline-rename.ts`;
  // the row keeps only the slot it renders into. Opened on the LABEL, not the
  // stored title: an editor that opens on a draft showing one name and offers
  // the word "Draft" to edit is an editor for some other row. The hook snapshots
  // whatever it opened on and hands it back as `value`, so the field and the
  // commit policy measure the same string even when the label moves underneath.
  const rename = useInlineRename(label, (next) => onRenameIssue(issue.id, next))
  const renameEditor = inlineRenameEditor(rename, ({ value, onCommit, onCancel }) => (
    <SessionNameEditor value={value} onCommit={onCommit} onCancel={onCancel} />
  ))
  // The row speaks for its whole branch: descendants have no row of their own
  // here, so the fleet stack reads the bubbled aggregate.
  const fleetSessions = row.aggregateSessions ?? mine
  const phase = display?.timing.phase ?? rowMotionPhase(row)
  // Is an agent on this mission computing right now? NOT the same question as
  // the phase, which an ask outranks — and the row is the mission's only line
  // here, so the phase alone left a running fleet reading as stillness
  // (POD-703). This is the predicate every working texture below gates on.
  const working = display?.working ?? rowHasWorkingSession(row)
  // What this row is asking of the human, if anything (POD-279).
  const decision = display ? display.decision : rowPendingDecision(row)
  const errorLine = display ? display.errorLine : rowErrorLine(row)
  const timing = display?.timing ?? rowMotionTiming(row)
  // The published row carries the Flight Deck's child-task rollup. Direct
  // component fixtures can supply the same rollup on their addressed row.
  const progress = progressProp ?? row.missionRollup?.progress ?? fallbackEmptyProgress()
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
  // the row flashes the origin. The parent supplies the addressed origin tick.
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
  const draftAgentOnly = display?.draftAgentOnly ?? isDraftAgentVessel(issue, mine)
  const first = mine[0]
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    setMenuAnchor({ x: e.clientX, y: e.clientY })
  }
  // The right-click menu (mirrors the board / SessionContextMenu pattern):
  // cursor-anchored portal, acts on this one issue, rendered alongside the row.
  // MENU DATA IS BUILT ON OPEN ONLY (POD-4421): the row holds no issue array,
  // so the `issues.map` below runs only while the menu is open, never per row
  // per publish.
  const menu =
    menuAnchor && resolveMenuData ? (
      <Suspense fallback={null}>
        <ResolvedIssueMenu
          resolve={resolveMenuData}
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
            {decision !== null ? (
              <span
                data-testid={decision === 'merge' ? 'awaiting-merge-status' : 'needs-review-status'}
                data-decision={decision}
                title={pendingDecisionTitle(issue, decision)}
                className="flex-none font-semibold text-attention"
              >
                {display?.statusLine ?? continuationStatus ?? rowStatusLine(row, now, 0)}
              </span>
            ) : (
              (display?.statusLine ?? continuationStatus ?? rowStatusLine(row, now, 0))
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
        active={active}
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
          onGripDown && !(display?.deferred ?? isIssueDeferred(issue, now))
            ? (e) => onGripDown(e, issue.id)
            : undefined
        }
        statusExtra={
          <>
            {errorLine && (
              <span
                data-testid="agent-error-status"
                title="An agent on this task stopped on an error"
                className="flex-none font-semibold text-destructive"
              >
                {errorLine}
              </span>
            )}
            {origin && !continuationStatus && (
              <span
                // No size of its own: line 2 sets one, and a second here was what
                // made the tick's line box taller than the sentence it annotates.
                className="flex-none tabular-nums"
                data-testid="spinoff-origin-tick"
                title={`Spun off from ${origin.ref} · ${origin.title}`}
              >
                ⤷ {origin.seq}
              </span>
            )}
          </>
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
            <IssueFleetSummary
              sessions={fleetSessions}
              summary={display?.fleet}
              size={11}
              variant="glyphs"
            />
            {issue.audience === 'agent' && (
              <span className="flex-none text-text-dim" data-testid="internal-issue-badge">
                internal
              </span>
            )}
            {(display?.unsnoozed ?? issueReturnedFromDefer(issue, now)) && (
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

function fallbackEmptyProgress(): MissionProgress {
  return { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
}

const ResolvedIssueMenu = observer(function ResolvedIssueMenu({
  resolve,
  ...props
}: {
  resolve: () => UnifiedIssueRowMenuData
} & Omit<
  import('react').ComponentProps<typeof IssueContextMenu>,
  'issues' | 'allIssues' | 'poolInputs'
>) {
  const data = resolve()
  if (data.poolInputs === LOADING) return null
  return (
    <IssueContextMenu
      {...props}
      poolInputs={data.poolInputs}
      issues={data.single.map((candidate) => ({
        ...candidate,
        memberSessionIds: candidate.memberSessionIds?.map(asSessionId),
      }))}
      allIssues={data.all.map((candidate) => ({
        ...candidate,
        memberSessionIds: candidate.memberSessionIds?.map(asSessionId),
      }))}
    />
  )
})

/**
 * MEMOIZED ROW (POD-4421). Default shallow compare is the whole contract:
 * `row` is stable via `reuseUnifiedWorkRows`, `displayTitle`/`active`/
 * `shortcutDigit`/`now` are scalars, `progress`/`origin` keep stable
 * references for unchanged rows, and every callback is a stable reference.
 */
export const UnifiedIssueRow = memo(measureSidebarRow(UnifiedIssueRowInner))
