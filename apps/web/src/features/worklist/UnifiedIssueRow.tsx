import { relativeTime } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import {
  errorPhrase,
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
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
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
import { NotSavedMark } from '@/components/NotSavedMark'
import type { IssueMenuPoolInputs } from '@/features/issues/issue-menu-pool-inputs'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useAgeNow } from '@/lib/clock-hooks'
import { issueIdTitle } from '@/lib/issue-labels'
import { PhaseTimer, WorkingMark } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { type PoolIssueDisplay, rowVoice, worklistIssueStatus } from './pool-row-data'
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
 * The spin-off origin used for the lineage flash
 * (POD-4421). The parent resolves the `discovered-from` edge once per list
 * through a by-id map; the row never sees the whole issue array.
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
  model,
  row: suppliedRow,
  now,
  onSelectIssue,
  onSelectPanelForIssue,
  onOpenIssue,
  onRenameIssue,
  onGripDown,
  onTuck,
  shortcutDigit,
  displayTitle: suppliedTitle,
  progress: suppliedProgress,
  origin: suppliedOrigin = null,
  active = false,
  resolveMenuData,
  display: suppliedDisplay,
}: {
  row?: UnifiedIssueRowView
  /** Production worklist rows read the shared companion inside this observer. */
  model?: WorklistIssue
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
  const row = suppliedRow!
  const display = suppliedDisplay
  const displayTitleProp = model?.title ?? suppliedTitle
  const progressProp = model?.progress ?? suppliedProgress
  const origin = (model?.origin ?? suppliedOrigin) as UnifiedIssueRowOrigin | null
  const issue = model ? (model.issue as unknown as IssueNavigationModel) : row.issue
  const mine = model ? (model.sessions as unknown as SessionView[]) : row.sessions
  const unread = model?.visibleUnread ?? display?.unread ?? rowUnreadEmphasized(row)
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
  const phase = model?.timing.phase ?? display?.timing.phase ?? rowMotionPhase(row)
  // Is an agent on this mission computing right now? NOT the same question as
  // the phase, which an ask outranks — and the row is the mission's only line
  // here, so the phase alone left a running fleet reading as stillness
  // (POD-703). This is the predicate every working texture below gates on.
  const working = model?.visibleWorking ?? display?.working ?? rowHasWorkingSession(row)
  // What this row is asking of the human, if anything (POD-279).
  const decision = model ? model.decision : display ? display.decision : rowPendingDecision(row)
  const errorLine = model
    ? model.errorClass === null
      ? null
      : errorPhrase(model.errorClass, 'lower')
    : display
      ? display.errorLine
      : rowErrorLine(row)
  const timing = model?.timing ?? display?.timing ?? rowMotionTiming(row)
  // The published row carries the Flight Deck's child-task rollup. Direct
  // component fixtures can supply the same rollup on their addressed row.
  const progress =
    progressProp && progressProp !== LOADING
      ? progressProp
      : (row?.missionRollup?.progress ?? fallbackEmptyProgress())
  // THE ROW'S IDENTITY IS ITS NUMBER (POD-1057). These digits carry the ref;
  // line 2 carries the phase and ask, and the meta column carries the spinner.
  const idLabel = idSquareLabel(issue)
  // A closed handoff names where the work continued.
  // Read off the ROW, not recomputed here (POD-1193). The same verdict now
  // withdraws the row's amber in `rowPendingDecision`, and a list that decides
  // its attention from one derivation and its words from another can disagree
  // with itself. It is also a graph walk per row per render, gone.
  const continuationStatus = model
    ? model.continuation
      ? `${model.continuation.kind} · ${model.continuation.ref}`
      : null
    : (row.continuation ?? null)
  // The full status sentence stays the row's hover text.
  const statusSentence = model
    ? worklistIssueStatus(model)
    : (display?.statusLine ?? continuationStatus ?? rowStatusLine(row, now, 0))
  // Draft vessel whose only content is agents → clicking opens the session.
  // Shared with the nesting rule so structure and rendering agree (POD-282).
  const draftAgentOnly =
    model?.sessionOnlyDraft ?? display?.draftAgentOnly ?? isDraftAgentVessel(issue, mine)
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
  const voice = rowVoice({
    decision,
    phase,
    working,
    awaitingFirstPrompt: model?.awaitingFirstPrompt,
    showsChildProgress: model?.showsChildProgress ?? progress.total > 0,
    progress,
    issue,
    continuation:
      model?.continuation ??
      (continuationStatus
        ? {
            kind: continuationStatus.split(' · ')[0] ?? continuationStatus,
            ref: continuationStatus.split(' · ').slice(1).join(' · '),
          }
        : null),
  })
  // LINE 1'S ONE TIME FACT (POD-2074). A computing row counts in blue — the
  // design's only blue text — and every other row shows a compact age: how
  // long an ask has waited, or since the row last moved.
  const meta =
    timing.phase === 'working' ? (
      <PhaseTimer
        phase="working"
        sinceMs={timing.sinceMs}
        baseMs={timing.baseMs ?? 0}
        size={10.5}
        showSpinner={false}
        className="flex-none"
      />
    ) : (
      <RowAge
        waiting={timing.phase === 'waiting'}
        // The row's activity clock, never `updatedAt`: a reorder rewrites
        // the sort key, and must not repaint every row it moves.
        stamp={
          (voice.tone === 'done' || voice.tone === 'closed') && issue.closedAt
            ? issue.closedAt
            : timing.sinceMs || issue.createdAt
        }
      />
    )
  return (
    <>
      <WorkRowShell
        testId="unified-issue-row"
        deemphasized={issue.audience === 'agent'}
        idLabel={idLabel.full}
        shortcutDigit={shortcutDigit}
        label={label}
        onTuck={onTuck}
        tone={voice.tone}
        muted={voice.tone === 'done' || voice.tone === 'closed'}
        statusLine={
          <>
            {/* THE ONE WORKING MARK ON A ROW THAT IS ALSO ASKING (POD-703): the
                status dot speaks for the ask, so a still-computing agent keeps
                its mark beside it. */}
            {working && voice.tone !== 'working' && (
              <WorkingMark size={12} className="mr-1 inline-flex align-middle" />
            )}
            <span
              data-testid={
                decision === 'merge'
                  ? 'awaiting-merge-status'
                  : decision === 'review'
                    ? 'needs-review-status'
                    : undefined
              }
              data-decision={decision ?? undefined}
              title={decision !== null ? pendingDecisionTitle(issue, decision) : statusSentence}
            >
              {voice.word}
            </span>
          </>
        }
        statusTime={voice.sub ?? undefined}
        phase={phase}
        timeMeta={meta}
        active={active}
        gitStamp={
          // A landed row already says where it went (POD-2151); a git stamp
          // cached before the landing would contradict it.
          issue.gitState && voice.word !== 'Landed' && (
            <GitStamp
              issueBranch={issue.branch}
              git={issue.gitState}
              density="stamp"
              className="flex-none text-text-faint"
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
          onGripDown && !(model?.issue.deferred ?? display?.deferred ?? isIssueDeferred(issue, now))
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
                · {errorLine}
              </span>
            )}
            {(model?.returnedFromDefer ??
              display?.unsnoozed ??
              issueReturnedFromDefer(issue, now)) && (
              <span
                className="flex-none font-semibold text-attention"
                title="Snooze ended — back in your queue"
              >
                · unsnoozed
              </span>
            )}
            {issue.audience === 'agent' && (
              <span className="flex-none text-text-faint" data-testid="internal-issue-badge">
                · internal
              </span>
            )}
          </>
        }
        onContextMenu={onContextMenu}
        onDoubleClick={() => rename.begin()}
        editor={renameEditor}
        titleHint={issueIdTitle(issue)}
        marks={<NotSavedMark kind="issue" id={issue.id} />}
      />
      {menu}
    </>
  )
}

function fallbackEmptyProgress(): MissionProgress {
  return { total: 0, done: 0, working: 0, waiting: 0, todo: 0 }
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
export const UnifiedIssueRow = memo(UnifiedIssueRowInner)
export const WorklistIssueRow = observer(UnifiedIssueRowInner)

/** The compact age the design sets in line 1's meta: `14h`, `2d`, `now`. */
function RowAge({
  stamp,
  waiting = false,
}: {
  stamp: number | string | null | undefined
  waiting?: boolean
}): JSX.Element | null {
  const now = useAgeNow(stamp ?? 0, 0, stamp != null && stamp !== '')
  if (stamp == null || stamp === '') return null
  const iso = typeof stamp === 'number' ? new Date(stamp).toISOString() : stamp
  const age = relativeTime(iso, now).replace(/ ago$/, '').replace('just now', 'now')
  const at = new Date(iso).toLocaleString()
  return <span title={waiting ? `Waiting since ${at}` : at}>{age}</span>
}
