import type { FlightDeckView } from './FlightDeck'
import { isFinished } from '@podium/model/browser'
import { relativeTime } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/store'
import {
  FLIGHT_DECK_BRIEF_CUTOFF_KEY,
  FLIGHT_DECK_FOLDS_KEY,
  FLIGHT_DECK_MODE_KEY,
} from '@podium/client-core/ui-state'
import {
  type CollapsedSummary,
  type DeckIssueState,
  type DeckState,
  deckSessions,
  deckViewEmptyLine,
  type FlightDeckFoldMap,
  type FlightDeckFoldState,
  type FlightDeckMode,
  type FlightDeckRow,
  flightDeckRowDefaultFolded,
  flightDeckRowHasPayload,
  flightDeckRowIsFolded,
  type IssueContinuation,
  type IssueNavigationModel,
  type IssueNote,
  isCoordinatorSession,
  issueAbandoned,
  issueOwnContentUnread,
  type MissionDeparture,
  type machineViewsFromWire,
  motionPhase,
  nativeSubagentRows,
  type PresenceNote,
  readFlightDeckFolds,
  type SessionRole,
  sessionAsksOnIssue,
  sessionNeedsHuman,
  sessionRole,
  sessionSettled,
  sessionUnreadEmphasized,
  continuationPresenceLine as sharedContinuationPresenceLine,
  spawnIssueAgent,
  subtreeUnread,
  treeGuides,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import type {
  MissionHandoffValues,
  MissionRowPresentation,
  MissionViewValues,
} from '@podium/client-graph/mission-view'
import { MissionDeckIssueModel } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { requireLoaded, settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { asIssueId } from '@podium/model'
import type { IssueId, MachineId, SessionId } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  Hourglass,
  Maximize2,
  Minimize2,
  Search,
  UserPlus,
  X,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type {
  CSSProperties,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { GhostBar, GhostDot, GhostPreview, GhostSquare } from '@/components/GhostPreview'
import { UnreadDot } from '@/components/UnreadMark'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useIssueExplorer } from '@/features/issues/explorer/explorer-context'
import type { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { IssueCloseDialog, useIssueCloseGuard } from '@/features/issues/issue-lifecycle'
import { useIssueStatusApply } from '@/features/issues/use-issue-status-apply'
import {
  type AgentRowStatus,
  agentFleetStatus,
  CapabilityAgentItem,
  candidateFromAvailability,
} from '@/lib/agent-capability'
import { type IssueAgentKind, issueAgentOptions, issueDefaultAgentKind } from '@/lib/issue-agents'
import { renderReadoutMarkdown } from '@/lib/markdown'
import { PhaseTimer, useArrivals, WorkingMark } from '@/lib/motion'
import { PoolSessionContextMenu } from '@/lib/PoolSessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useFeature } from '@/lib/use-feature'
import { usePersistedUiState, usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { useClickIntent } from './click-intent'
import { type FlightDeckDisplay, nextFlightDeckDisplayForSessionPick } from './flight-deck-display'
import {
  type DeckWindow,
  type DeckWindowRow,
  DeckRowPlaceholder,
  deckSessionKey,
  deckTaskKey,
  useFlightDeckWindow,
} from './flight-deck-window'
import { useRuntimeDraft } from './keyed-runtime'
import { MissionCostChip } from './MissionCostChip'
import { MissionGauge } from './MissionGauge'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useSessionHovered } from './session-hover'
import {
  CLOSE_RIGHT_PANEL,
  OPEN_RIGHT_PANEL_EVENT,
  REVEAL_IN_DECK_EVENT,
  RIGHT_PANEL_KEY,
  readRightPanel,
} from './shell-state'
import { useRuntimeSelector } from './store'


const SPINE_PAD = 8
export const DEPTH_STEP = 16
/** Where a nesting level's rail sits inside its own step. Also the inset of a
 *  task's agent rail inside its own band, because they are the same line. */
export const RAIL_INSET = 8
/** A task strip's height, and its vertical centre — where its elbow lands. */
export const BAND_HEIGHT = 32
const BAND_MID = BAND_HEIGHT / 2
/**
 * A PROPOSED strip is shorter — nobody has accepted it, so it holds no space for
 * an agent and needs none for itself (POD-516 round 3 §7b). Its elbow moves with
 * it: a rail that met a 30px band's centre would enter a 24px one three pixels
 * low, which is exactly the kind of near-miss that makes a tree look drawn
 * rather than computed.
 */
export const PROPOSED_BAND = 26
const PROPOSED_MID = PROPOSED_BAND / 2
/** A session row's inset inside its task strip, and its own rail — one issue
 *  step and the step's own rail, so an agent and a child task hang on the SAME
 *  line at the SAME indent (see the note above). */
const AGENT_INDENT = DEPTH_STEP
const AGENT_RAIL = RAIL_INSET
/**
 * THE MISSION'S OWN RAIL — where a depth-1 strip draws its line (`BranchGuides`'
 * `ownX` at depth 1). The root's own agent rows line up on it too, so the
 * mission's agents and its first child task hang on ONE line instead of the
 * mission being repeated as a strip above them (round 3 §4).
 *
 * NOTHING ABOVE THE LIST DRAWS HERE (POD-1306). It is also the header's own
 * padding, so a segment at this x in the header lands under the title rather
 * than beside it — see the note over `spineSegment`.
 */
export const ROOT_RAIL = SPINE_PAD + RAIL_INSET
/**
 * The root block's inset, chosen so the root's sessions hang on ROOT_RAIL
 * EXACTLY: the list's top pad is not merely near their rail, it IS their rail,
 * and the line continues through their elbows into the first child below.
 */
export const ROOT_BLOCK_INSET = ROOT_RAIL - AGENT_RAIL
/** Where a depth-1 strip's band begins — the left edge everything in the column
 *  that is not the spine itself aligns to, so the rail runs in a clear gutter. */
export const GUTTER = SPINE_PAD + DEPTH_STEP
/** Vertical centre of every row hung under a task strip (min-height 28px). */
const HUNG_MID = 14
/** A native worker's inset inside its session band, and its own rail. */
const NATIVE_INDENT = 18
const NATIVE_RAIL = 7
/** Vertical centre of a native row (height 22px). */
const NATIVE_MID = 11
/**
 * THE ATTENTION AND SELECTION TICKS — colour as a mark in the gutter, never as
 * a fill or a border on the strip (POD-758).
 *
 * The spine has exactly two fills: grey for a task, fuchsia for a proposal.
 * Selection and attention are therefore not allowed to be surfaces, or the one
 * thing a colour means here stops being one thing. They arrive instead as a
 * short square tick standing in the rail's own gutter — the issue accent for
 * the strip you are on, amber one notch further out for a strip with a session
 * asking inside it. Two ticks can stand side by side without either becoming
 * the other, which a border and a background cannot.
 */
const TICK_WIDTH = 3
const TICK_HEIGHT = 15
/**
 * Offsets from the row's own rail: selection ON it, attention outside it — so
 * attention is always the leftmost thing on the row and the gutter between the
 * rail and the row is left to the elbow.
 *
 * AN AGENT ROW WEARS THE SAME TWO TICKS AS A STRIP (POD-1226). Attention used to
 * arrive on an agent row as a 2px amber rule inset on the row's own left edge —
 * a second grammar for the one fact this column already has a mark for, and the
 * row has NO left padding (it opens onto its rail), so the rule was painted
 * exactly where the 20px agent tile starts. What the operator saw was an amber
 * line crossing the icon's rounded corner, and, once the row wrapped to two
 * lines, a long amber bar running down past the content into empty space. Under
 * one grammar the marks read in one order at every depth and every row kind —
 * attention, then the rail (lit when selected), then the elbow, then the row —
 * and the tile is left alone.
 *
 * The elbow goes back to carrying PROVENANCE only. It was painted amber on an
 * asking row on the argument that attention outranks it; with attention standing
 * on its own side of the rail there is nothing to outrank, and an amber elbow
 * running INTO an amber rule was most of what made these ten pixels unreadable.
 *
 * SELECTION STANDS ON THE RAIL, NOT IN THE GUTTER (POD-1306).
 * The gutter between a rail and the thing hanging on it is `RAIL_INSET` — eight
 * pixels — and the ELBOW crosses all eight of them, so anything parked in there
 * is parked on the elbow. POD-1170 put the tick mid-gutter and got a broken
 * cross; POD-1226 moved it flush against the row's own left edge, and on an
 * AGENT row that edge is the 20px agent tile. A 3×15 grey bar butted against a
 * 20×20 filled tile does not read as a terminal cap: it reads as the spine
 * running behind the icon and being cut off by it, which is what the operator
 * filed. Both placements fail for the same reason — the gutter belongs to the
 * elbow.
 *
 * So the mark goes where it is ABOUT: the rail itself, one pixel either side of
 * it, so the branch line thickens and takes the accent for the length of the
 * selected row. The elbow then leaves the mark and runs the full gutter into the
 * row, clear of the tile at every depth and every row kind. Attention keeps its
 * own side of the rail, further out, and still never meets the elbow.
 */
const TICK_SELECTED_X = -1
/** Far enough out that the two marks never read as one pair of bars: at depth 1
 *  this lands the amber tick's left edge on `SPINE_PAD` exactly, which is the
 *  column's own datum and as far out as anything here is allowed to go. */
const TICK_ATTENTION_X = -RAIL_INSET
/**
 * The trailing column every row parks its state in, so the whole mission scans
 * as one vertical read. Task strips take its fixed 80px measure. Agent rows use
 * that as a minimum and let a longer obligation size itself, because a complete
 * `Needs you · 30m ago` is more valuable than false column rigidity.
 *
 * The width lives in CSS (`--deck-state-col` / `.deck-state-col`), where the
 * agent grid can reinterpret it at its narrow composition. `DECK_LABEL` has two
 * eleven-character values (`Standing by`, `Not started`) and 70 held neither;
 * the departure ticks were already 80 (70px of text plus a 5px dot and its
 * gap), so the shared floor stays 80.
 */
export const STATE_COL = 'deck-state-col'

/**
 * THE LEAD RAIL.
 *
 * A branch whose owner has a coordinator draws its guide in the mission's own
 * colour instead of a hairline, so "who is running this" is answered by the
 * line rather than by a badge. Two tiers, because the same device names the
 * mission's lead and a task's lead and those are not the same claim. Un-led
 * branches keep the hairline, which is what stops the coloured line from
 * reading as decoration.
 */
export type RailTone = 'mission' | 'task' | null

interface Rail {
  className: string
  width: number
}

const HAIRLINE_RAIL: Rail = { className: 'bg-hairline-soft', width: 1 }

const MISSION_RAIL: Rail = { className: 'deck-rail-mission', width: 2 }
const TASK_RAIL: Rail = { className: 'deck-rail-task', width: 2 }
export const railFor = (tone: RailTone): Rail =>
  tone === 'mission' ? MISSION_RAIL : tone === 'task' ? TASK_RAIL : HAIRLINE_RAIL

/**
 * THE TITLE'S FLOOR — 150px, and it is a TARGET, not a `min-width`.
 *
 * The title is the only shrinker on a strip: the icons and the state column are
 * rigid, because a half-rendered clock (`28:`) is a WRONG number where
 * `Mission progress…` is still a readable title. When the column narrows past
 * the point where the title would go under this floor, whole elements DROP
 * rather than anything being cut mid-string — in order: the relation chip, then
 * the payload chip, then the census icons past the first. Everything dropped
 * survives on the row's tooltip.
 *
 * Enforcing it as a literal `min-width` was the wrong shape and shipped for
 * exactly one screenshot: a flex item that refuses to shrink does not make the
 * row wider than the column, it makes the row OVERFLOW it, and the state column
 * — the rigid thing the floor exists to protect — was the first casualty, cut
 * to `Not sta…` on every nested strip. So the floor lives in the container
 * thresholds in `styles.css` instead, which is where it can actually be
 * enforced, and the title keeps `min-w-0` so the last resort is a truncated
 * title rather than a broken row.
 */

/** `active` is `working`'s old id (POD-1452), still read so an operator who had
 *  chosen that view does not silently land back on `Full spine`. */
export const readMode = (raw: string | null): FlightDeckView =>
  raw === 'active'
    ? 'working'
    : raw === 'working' || raw === 'needs-you' || raw === 'waterfall' || raw === 'handoff'
      ? raw
      : 'full'
export const writeMode = (mode: FlightDeckView): string | null => (mode === 'full' ? null : mode)

/**
 * THE FOLD IS THREE-VALUED (POD-710).
 *
 * A single `collapsed` set could only say "the operator folded this"; everything
 * else was open, which is the wrong default for the commonest strip in the
 * column — a task carrying exactly one agent and nothing else. Its fold buys the
 * operator nothing (the strip already names the one session under it) and costs
 * a row of the spine, so it wants to arrive closed. A task with real structure
 * under it wants to arrive open.
 *
 * Neither of those is a decision the operator made, so neither may be stored as
 * one: the map holds only EXPLICIT folds, and a task the operator never touched
 * falls through to {@link defaultFolded}. That is what lets the rule change later
 * without rewriting everyone's saved state, and what stops "fold everything" and
 * "I closed this one" from being the same fact.
 */
export type FoldState = FlightDeckFoldState
export type FoldMap = FlightDeckFoldMap
export const readFolds = readFlightDeckFolds
export const writeFolds = writeFlightDeckFolds
export type FoldableRow = Pick<FlightDeckRow, 'issue' | 'descendantIds' | 'sessions'>

/** Whether a task has anything to fold at all. A payload-less strip draws no
 *  chevron and never enters the fold map. */
export function hasPayload(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return flightDeckRowHasPayload(row)
}

/**
 * The default when the operator has said nothing: a task whose ENTIRE payload is
 * one session and no sub-tasks arrives closed, everything else with a payload
 * arrives open. Folding the one-session task hides a row that only restates the
 * strip; folding a branch hides work.
 */
export function defaultFolded(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return flightDeckRowDefaultFolded(row)
}

/** The effective fold: an explicit value wins, else the default rule. */
export const isFolded = flightDeckRowIsFolded

/**
 * Unread for a task strip. Working agents suppress the mark (the spinner
 * already says "live"). A collapsed strip — including the default one-agent
 * fold — rolls up hidden sessions and descendant issues against THIS issue's
 * readAt. An expanded strip only marks issue-level activity; sessions and
 * children speak for themselves.
 */
export function deckTaskUnread(
  row: Pick<FlightDeckRow, 'issue' | 'workingAgentCount' | 'descendantIds' | 'collapsedSummary'>,
  collapsed: boolean,
  descendants: ReadonlyMap<string, { updatedAt: string }> | string,
): boolean {
  if (row.workingAgentCount > 0) return false
  if (!collapsed) return issueOwnContentUnread(row.issue)
  return subtreeUnread({
    readAt: row.issue.readAt,
    updatedAt: row.issue.updatedAt,
    descendantUpdatedAts: typeof descendants === 'string' ? [descendants] : row.descendantIds.flatMap(id => { const child = descendants.get(id); return child ? [child.updatedAt] : [] }),
    sessions: row.collapsedSummary.crew,
  })
}

/** What the mission search matches on a row: its title, its ref, its agents. */
function matchesQuery(row: FlightDeckRow, needle: string): boolean {
  return (
    row.issue.title.toLowerCase().includes(needle) ||
    issueDisplayRef(row.issue).toLowerCase().includes(needle) ||
    row.sessions.some((session) => sessionDisplayName(session).toLowerCase().includes(needle))
  )
}

export function sessionSearchText(
  session: SessionView,
  issue: IssueNavigationModel | null = null,
  label?: string | null,
): string {
  const retired = session.archived || session.status === 'exited'
  const needs =
    !retired && (issue ? sessionAsksOnIssue(issue, session) : sessionNeedsHuman(session))
  return [
    session.handoffTarget ? `Handing over → ${session.handoffTarget}` : sessionDisplayName(session),
    session.displayRef,
    label,
    sessionUnreadEmphasized(session) ? 'unread' : null,
    retired ? 'Retired' : needs ? 'Needs you' : null,
    session.status === 'starting' || session.status === 'reconnecting' ? 'Starting' : null,
    ...nativeSubagentRows(session).map((agent) =>
      [
        agent.type,
        agent.anonymous ? null : agent.id.slice(0, 8),
        'native',
        agent.working ? 'working' : 'waiting',
      ]
        .filter(Boolean)
        .join(' '),
    ),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The task strip's operational state as a MARK plus one word.
 *
 * An earlier pass shipped the word alone, on the argument that every icon that
 * would fit here already means something else. The approved artifact disagrees
 * and it wins: on a spine of thirty strips the word is unreadable at a glance,
 * and a working row has no other motion of its own once its agent rows are
 * folded away. The marks are drawn from what already carries meaning here — the
 * canonical braille spinner of the motion grammar — rather than invented.
 *
 * NOTHING HERE TAKES THE ACCENT. Under the round-2 model attention belongs to
 * the session that asked, so the accent on a task strip is the one colour this
 * slot may not spend. `Blocked` therefore takes no hue either: `--warning` is
 * the demoted yellow, the loudest warm left in the window, so a warning-toned
 * "Blocked" would shout alarm about a stopped state — and `--attention` is now
 * the accent itself, which would read as "answer me" on the very surface built
 * to tell those apart. Blocked is a stopped state, not an obligation — the ⊘
 * mark and the named reason underneath carry it, and the dot beside them is the
 * only accent on the strip.
 */
function StateMark({ state }: { state: DeckState }): JSX.Element | null {
  // ONLY THE LIVE ONE (POD-758). An earlier pass gave every state a mark — a
  // tick for done, ⊘ for blocked, an hourglass for waiting — on the argument
  // that a word alone is unreadable down a spine of thirty strips. It is not
  // the word that was unreadable, it is the word CUT: mark plus word does not
  // fit 70px, and `Not sta…` is worse than either. Every static state is
  // already carried twice over on the left — the stage glyph, the hatch on a
  // blocked strip, the relation chip naming the blocker — so the column spends
  // its width on the word, and the one mark that says something the words
  // cannot is the one that MOVES.
  //
  // The spinner carries its own reserved working blue (`--motion-working`);
  // nothing here retints it.
  return state === 'working' ? <WorkingMark size={12} className="flex-none" /> : null
}

/**
 * ONE fact about the ISSUE, in the issue's own visual area (round 3 §5, §6).
 *
 * The operator's complaint was positional, not informational: "Discovered from
 * POD-516" hanging under the agent rows read as another agent. On the strip it
 * reads as what it is — a property of the task, beside the task's own name. It
 * prints the REF (the thing you can go and act on) and keeps the sentence on the
 * hover title, which is the only way it fits at the column's narrowest.
 */
export function IssueNoteChip({ note }: { note: IssueNote }): JSX.Element {
  // BLOCKED AND WAITING TAKE THE ATTENTION INK AND A WARM RIM; provenance stays
  // neutral. Those two are the ones that STOP work — they are the reason the
  // operator is looking — where "discovered from" and "continued in" are facts
  // about the task's shape that nothing hangs on.
  const stopping = note.kind === 'blocked' || note.kind === 'waiting'
  return (
    <span
      className={cn(
        // WRITTEN OUT, NOT DRAWN. The chip used to be a glyph and a ref, and a
        // `↳` cannot say *spun off from*: the difference between "this came
        // from POD-775", "this is blocked by POD-869" and "this continued in
        // POD-1037" is exactly what the operator needs off one glance. So the
        // relation prints in 8px mono caps and the ref follows in the row's own
        // micro mono, with the whole sentence still on the hover title.
        //
        // RIGID, WITH A CEILING. The title is the only shrinker on a strip, so
        // the chip never gives ground to it — it either fits or it DROPS whole
        // (`.deck-drop-relation`, at the strip's own 370px rung). The ceiling is
        // what keeps a long relation from eating the title before that: past
        // 168px the ref inside truncates rather than the chip growing.
        'deck-drop-relation flex h-[17px] max-w-[10.5rem] flex-none items-center gap-1.5 rounded-[4px] border px-1.5',
        stopping ? 'border-attention/40 text-attention' : 'border-hairline-bar text-text-dim',
      )}
      data-testid="flight-issue-note"
      data-note={note.kind}
      title={note.full}
      role="img"
      aria-label={note.full}
    >
      {note.label && (
        <span
          className={cn(
            'flex-none font-mono text-[8px] leading-none font-semibold tracking-[0.11em] uppercase',
            stopping ? 'text-attention' : 'text-text-faint',
          )}
        >
          {note.label}
        </span>
      )}
      <span className="shell-type-micro min-w-0 truncate font-mono">{note.short}</span>
    </span>
  )
}

/**
 * The strip's right-hand slot: the attention indicator, the mark, the word.
 *
 * The indicator is a COLOUR and nothing else (POD-516 round 2 §5). A task does
 * not need you; a session inside it stopped and asked, and that session's row is
 * where the words, the marker and the answer live. All this strip owes the
 * operator is "there is something in here" from across the column.
 */
function StateLabel({ value, label }: { value: DeckIssueState; label?: string }): JSX.Element {
  const word = label ?? value.label
  return (
    <span
      // RIGID, AND ALWAYS THE SAME WIDTH. Every strip, every agent row, every
      // departure tick and every proposal parks its right-hand fact in this one
      // column, right-aligned, so the mission's states read down the edge of the
      // spine as a single list. It never shrinks — the title does — because a
      // half-rendered state is a wrong state.
      className={cn('flex flex-none items-center justify-end gap-1.5', STATE_COL)}
      data-operational-state={value.state}
      data-attention={value.attention ? 'true' : undefined}
      title={value.attention ? `${word} · a session in here needs you` : word}
    >
      {value.attention && (
        <span aria-hidden className="size-[5px] flex-none rounded-full bg-attention" />
      )}
      {/* A folded branch reports live state in words (`2 running`) and drops the
          mark: the word already says what the mark would, and 70px does not
          hold both without cutting the word that carries the number. */}
      {label === undefined && <StateMark state={value.state} />}
      <span className="shell-type-micro truncate font-mono text-text-dim">{word}</span>
    </span>
  )
}

/** The one line a census icon carries on hover: who it is, and what it is doing.
 *  Deliberately a coarse word rather than a live clock — the icon exists so the
 *  operator can decide whether to unfold, and a tooltip that ticks would be one
 *  more thing animating in a column whose only motion is the working spinner. */
function crewLine(session: SessionView, now: number): string {
  const retired = session.archived || session.status === 'exited'
  const phase = motionPhase(session)
  const state = retired
    ? `retired ${relativeTime(session.lastActiveAt, now)}`
    : sessionNeedsHuman(session)
      ? 'needs you'
      : phase === 'working'
        ? 'working'
        : phase === 'done'
          ? 'done'
          : 'standing by'
  return [session.displayRef?.trim(), sessionDisplayName(session), state]
    .filter(Boolean)
    .join(' · ')
}

/** Past this the icons stop being a census and start being a texture. */
const CREW_SHOWN = 4

/**
 * WHO IS BEHIND THE FOLD — one harness icon per session, and no names.
 *
 * A collapsed strip is a census, not a roster. Names need room the strip does
 * not have and a bare count says nothing about what kind of thing is in there;
 * the harness icons say "two Claudes and a shell" in the width of three
 * characters. Settled agents dim rather than disappear — nothing in this spine
 * is hidden by default — and everything each icon stands for rides on its
 * tooltip, which is also where an icon dropped by a narrow column survives.
 */
function CrewCensus({ crew }: { crew: readonly SessionView[] }): JSX.Element {
  const now = useRuntimeSelector((store) => store.coarseNow)
  const shown = crew.slice(0, CREW_SHOWN)
  const extra = crew.length - shown.length
  return (
    <span className="flex flex-none items-center gap-1" data-testid="flight-crew">
      {shown.map((session, index) => (
        <span
          key={session.sessionId}
          // The FIRST icon always survives: "there is somebody in here" is the
          // fact, and the rest are detail the tooltip keeps.
          className={index === 0 ? undefined : 'deck-drop-crew'}
          title={crewLine(session, now)}
        >
          <KindIcon kind={session.agentKind} compact dimmed={sessionSettled(session)} />
        </span>
      ))}
      {extra > 0 && (
        <span className="shell-type-micro deck-drop-crew font-mono text-text-faint">+{extra}</span>
      )}
    </span>
  )
}

/**
 * One rail segment plus the elbow into the row hanging on it.
 *
 * `last` stops the rail at the elbow, which is what makes the final child of a
 * branch read as final rather than as a line running off into the next block.
 *
 * THE RAIL AND THE ELBOW ARE TWO DECISIONS. The vertical belongs to the BRANCH
 * — every row in a lead's block draws the same coloured line, or the line would
 * be dashes. The elbow belongs to the ROW: only the lead's own elbow is drawn
 * in the branch colour, which is how the line names one agent rather than
 * decorating all of them. Everyone else's elbow stays a hairline.
 */
function Hung({
  railX,
  indent,
  mid,
  last,
  rail,
  elbow,
  children,
}: {
  railX: number
  indent: number
  mid: number
  last: boolean
  rail: Rail
  /** Background class for this row's elbow; defaults to the rail's own. */
  elbow?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="relative">
      <span
        aria-hidden
        className={cn('pointer-events-none absolute', rail.className)}
        style={{ left: railX, top: 0, width: rail.width, height: last ? mid : '100%' }}
      />
      <span
        aria-hidden
        className={cn('pointer-events-none absolute h-px', elbow ?? rail.className)}
        style={{ left: railX, top: mid, width: indent - railX }}
      />
      {children}
    </div>
  )
}

/** The ancestor rails crossing one task strip's whole block, plus its own elbow.
 *  `carries[level]` comes from `treeGuides` — see the geometry note above.
 *  `mid` is the strip's own vertical centre, which a shorter (proposed) band
 *  moves; everything else about the geometry is fixed. */
function BranchGuides({
  carries,
  rails,
  mid = BAND_MID,
}: {
  carries: readonly boolean[]
  /** The tone of the rail at each level, `rails[level - 1]` — see `railTones`. */
  rails: readonly RailTone[]
  mid?: number
}): JSX.Element | null {
  const depth = carries.length
  if (depth === 0) return null
  const ownX = SPINE_PAD + (depth - 1) * DEPTH_STEP + RAIL_INSET
  const own = railFor(rails[depth - 1] ?? null)
  return (
    <>
      {carries.slice(0, -1).map((carry, level) => {
        const left = SPINE_PAD + level * DEPTH_STEP + RAIL_INSET
        const rail = railFor(rails[level] ?? null)
        return carry ? (
          <span
            key={left}
            aria-hidden
            className={cn('pointer-events-none absolute top-0 bottom-0', rail.className)}
            style={{ left, width: rail.width }}
          />
        ) : null
      })}
      <span
        aria-hidden
        className={cn('pointer-events-none absolute', own.className)}
        style={{ left: ownX, top: 0, width: own.width, height: carries[depth - 1] ? '100%' : mid }}
      />
      {/* The elbow into a task is ALWAYS a hairline, even off a lead's coloured
          rail: the colour is the branch saying who runs it, and painting every
          child's elbow with it would turn a name into a wash. */}
      <span
        aria-hidden
        className="pointer-events-none absolute h-px bg-hairline-soft"
        style={{ left: ownX, top: mid, width: DEPTH_STEP - RAIL_INSET }}
      />
    </>
  )
}

/** What a fold is hiding, said in the row's own meta slot rather than in a
 *  second row below it — a fold that costs a row hides nothing. */
function CollapsedPayload({ summary }: { summary: CollapsedSummary }): JSX.Element | null {
  const { tasks, done, run, needsYou } = summary
  if (tasks === 0) return null
  const pct = (n: number): string => `${(n / tasks) * 100}%`
  return (
    <span
      className="deck-drop-payload flex flex-none items-center gap-1.5"
      data-testid="flight-collapse-payload"
      title={`${tasks} task${tasks === 1 ? '' : 's'} · ${run} active${needsYou ? ' · needs you' : ''}`}
    >
      <span className="shell-type-micro rounded border border-hairline-bar px-1 font-mono text-text-dim">
        {tasks} task{tasks === 1 ? '' : 's'}
      </span>
      <span className="flex h-[3px] w-7 flex-none overflow-hidden rounded-full bg-secondary">
        <span className="h-full bg-success" style={{ width: pct(done) }} />
        <span className="h-full bg-info" style={{ width: pct(run) }} />
      </span>
    </span>
  )
}

/**
 * THE EMPTY SEAT — a dotted chip in the strip's own chip slot (POD-758).
 *
 * It used to be a full row hung under the task, holding exactly the space a
 * session would occupy. That space taught where you would click, and cost a row
 * of the spine on every unstaffed task to teach it. The seat is a chip now, in
 * the slot where a staffed task shows its crew: "nobody is here" is read
 * exactly where somebody would be, which is the same lesson in no rows at all.
 *
 * DOTTED, NEVER DASHED. One rim style, reserved for one meaning across the
 * whole spine — a session belongs here and there is not one. Dashed is used
 * nowhere in this column, so the two can never be confused.
 *
 * Only the two arms that are genuinely a held seat get one. `done` and `review`
 * are settled, `moved` and `blocked` already name themselves on the strip, and
 * a proposal holds no seat at all — nobody has accepted it, so there is nothing
 * yet to hold space for.
 */
export function SeatChip({ note }: { note: PresenceNote }): JSX.Element {
  return (
    <span
      className={cn(
        'shell-type-micro flex flex-none items-center gap-1 border border-dotted px-1.5 py-px font-mono',
        note.attention
          ? 'border-attention/60 font-semibold text-attention'
          : 'border-border-strong text-text-faint',
      )}
      data-presence={note.kind}
      data-testid="flight-reserved-slot"
      title={note.text}
    >
      {note.attention ? 'no agent' : 'seat open'}
    </span>
  )
}

/** Which presence notes are a HELD SEAT rather than a settled fact. Everything
 *  else the strip already says in its state column or its relation chip, and
 *  saying it twice is what made the old seat read as an agent. */
export const seatFor = (note: PresenceNote | null): PresenceNote | null =>
  note && (note.kind === 'ready' || note.kind === 'attention') ? note : null

/**
 * A session's native subagents, hung off it on their own guide.
 *
 * They are the harness's own workers, not Podium sessions — the quietest tier in
 * the spine, mono throughout, and they open the PARENT in its CLI view
 * because there is no child transcript to route to.
 */
function NativeRows({
  session,
  onOpen,
}: {
  session: SessionView
  onOpen: () => void
}): JSX.Element | null {
  const rows = nativeSubagentRows(session)
  if (rows.length === 0) return null
  return (
    <div className="relative pb-0.5" data-testid="flight-native-agents">
      {rows.map((agent, index) => (
        <Hung
          key={`${session.sessionId}:${agent.id}`}
          railX={NATIVE_RAIL}
          indent={NATIVE_INDENT}
          mid={NATIVE_MID}
          last={index === rows.length - 1}
          rail={HAIRLINE_RAIL}
        >
          <button
            data-pressable
            type="button"
            // NO ICON OF ITS OWN, and no rounded edge (POD-758). A native worker
            // is evidence of one agent's work, not a seat you can act on — mono
            // type on the quietest rail in the spine, and nothing else. Giving
            // it a harness tile would put it in the same visual class as the
            // session that owns it.
            className="shell-type-micro flex h-[22px] w-full items-center gap-1.5 pr-2 text-left font-mono text-text-faint hover:bg-muted hover:text-text-dim"
            style={{ paddingLeft: NATIVE_INDENT + 4 }}
            onClick={onOpen}
            title={`Focus ${sessionDisplayName(session)} in CLI · ${agent.anonymous ? 'unnamed worker' : agent.id}`}
          >
            {/* The artifact's `native-row`: TYPE first and lit, its id dimmed
                behind a separator. The full 17-character harness id was the
                widest thing on the row and the least useful — eight characters
                distinguish concurrent workers, and the whole id is on the title
                for anyone who needs to match it against a transcript. */}
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-text-dim">{agent.type}</span>
              {!agent.anonymous && (
                <span className="text-text-faint/70"> · {agent.id.slice(0, 8)}</span>
              )}
            </span>
            {/* WHICH KIND OF THING THIS IS, said rather than guessed. A native
                worker is the harness's own fan-out, not a Podium session: no
                strip, no seat, no ref of its own. The badge after the id is what
                stops `general-purpose · a7b1341d` from reading as one more
                agent the operator could have started. */}
            <span
              aria-hidden
              className="flex h-3 flex-none items-center rounded-[3px] bg-chip px-1 text-[8px] leading-none font-semibold tracking-[0.12em] uppercase"
            >
              native
            </span>
            {/* Their state follows the session that owns them, and it parks in
                the same column every other row in the spine parks in. */}
            <span className={cn('flex flex-none justify-end', STATE_COL)}>
              {agent.working ? 'working' : 'waiting'}
            </span>
          </button>
        </Hung>
      ))}
    </div>
  )
}

const ROLE_LABEL: Record<Exclude<SessionRole, { kind: 'spawned' }>['kind'], string> = {
  coordinator: 'coordinator',
  // "task lead", not "phase lead": the thing it leads is a task, and the spine
  // calls every node in it a task. Two words for one node is one too many.
  'phase-lead': 'task lead',
  // `peer`, not `operator-added peer`: this is the relationship the operator
  // needs to scan. How it was added is history, not a second role.
  peer: 'peer',
}

/** The role as the word after the name. A spawn edge is named by its PARENT —
 *  "by Spine designer" is the fact the operator can act on; the parent session
 *  id is not. An unresolvable parent gets no word rather than an id. */
export function roleLabel(
  role: SessionRole | null,
  nameOf: (sessionId: SessionId) => string | undefined,
): string | null {
  if (role === null) return null
  if (role.kind !== 'spawned') return ROLE_LABEL[role.kind]
  const parent = nameOf(role.parentSessionId)
  return parent ? `by ${parent}` : null
}

const isLead = (role: SessionRole | null): boolean =>
  role?.kind === 'coordinator' || role?.kind === 'phase-lead'

/**
 * WHO DRIVES THIS TASK, said in a word (POD-758).
 *
 * The `coord` badge is retired. A badge is a small filled object, and it was
 * competing for the same five pixels as the attention dot on the one row most
 * likely to have both. The lead is already named twice over by then — its
 * branch runs in the mission's colour and its elbow is the only one drawn in
 * that colour — so all that is left to add is the word itself, in the accent,
 * in the caption voice the rest of the shell uses for a role.
 *
 * Full strength for the mission's coordinator, 70% for a task's lead: a quiet
 * line, a readable word, and the two altitudes told apart without a second
 * device.
 *
 * A role stays content-sized. The roster used to force every role through a
 * 96px slot, which clipped useful provenance even when the deck had hundreds of
 * spare pixels. The row grid now gives it its full measure and moves the whole
 * fact to the second line when the deck is narrow.
 */
function RoleWord({ role, label }: { role: SessionRole; label: string }): JSX.Element {
  const lead = isLead(role)
  return (
    <span
      className={cn(
        // ONE VOICE FOR THE WHOLE COLUMN — 9px mono caps, the shell's caption
        // for a role — so `COORDINATOR`, `TASK LEAD`, `BY SPINE DESIGNER` and
        // `PEER` read down one edge instead of alternating between two
        // typographic registers.
        // No `flex-none`: `.deck-agent-role` is a grid cell that fills its own
        // track now (POD-1461), and its display is the stylesheet's to own —
        // the wide row needs `block` for the ellipsis it may have to spend.
        'deck-agent-role font-mono text-[9px] leading-none tracking-[0.14em] uppercase',
        lead ? 'font-medium' : 'font-normal text-text-faint',
      )}
      style={
        lead ? { color: 'var(--issue)', opacity: role.kind === 'coordinator' ? 1 : 0.7 } : undefined
      }
      data-session-role={role.kind}
      data-testid={role.kind === 'coordinator' ? 'coordinator-badge' : undefined}
      title={label}
    >
      {label}
    </span>
  )
}

/**
 * One session on a task: who it is, what it is here as, and how long it has been
 * at it.
 *
 * THIS is where "needs you" lives (POD-516 round 2 §5). A task cannot ask an
 * operator anything; an agent stopped mid-turn and did. So the marker, the word
 * and the click that answers it are all on this row, and the strip above only
 * carries a dot so the row can be found with the branch folded.
 *
 * The right-hand slot is mark + elapsed, per DESIGN.md §5 — the spinner never
 * turns without its counting timer beside it. Every stopped phase still shows
 * how long it has been stopped, because "how stale is this" is the question the
 * operator is actually asking when nothing is moving.
 *
 * AN AGENT ROW HAS NO FILL AND NO OUTLINE (POD-758), and no rounded edge. It is
 * a CONTENT of a task, not an object beside one — drawn by its icon, its indent
 * and its rail, so the only rectangles in the column are tasks and the tree's
 * structure reads as fast as it can. The coordinator is the single exception
 * (see `lead` below); every other fill an agent ever gets is transient hover.
 * Even the row that is asking stays unfilled: attention is a MARK in this
 * system — amber type, an amber inner rule, the `!` disc — never a surface.
 */
export const SessionRow = observer(function SessionRow({
  session,
  issue = null,
  role = null,
  label = null,
  active,
  last,
  rail = HAIRLINE_RAIL,
  flat = false,
  onOpen,
  onOpenNative,
}: {
  session: SessionView
  /** The task this row hangs on. Needed to answer "is it asking?", which a
   *  session cannot answer alone once the task has closed (POD-1072). Null
   *  outside the tree, where the archived reveal draws rows on their own. */
  issue?: IssueNavigationModel | null
  role?: SessionRole | null
  /** The role as a word, already resolved (a spawn parent needs a name). */
  label?: string | null
  active: boolean
  last: boolean
  /** The branch line this row hangs on — coloured when its task has a lead. */
  rail?: Rail
  /** Outside the tree (the archived reveal) — no rail, no elbow, no indent. */
  flat?: boolean
  /** `permanent` is the double click / Enter: it opens the session as a real
   *  tab rather than as the workspace's one preview. */
  onOpen: (permanent: boolean) => void
  onOpenNative: () => void
}): JSX.Element {
  // SESSION LIFECYCLE LIVES HERE NOW (POD-710 §4). The tab is a view and stops
  // owning the session, so rename / snooze / hibernate / handoff / archive /
  // kill move to the row that IS the session. Imported, never forked: the
  // sidebar and this column must offer one menu, not two that drift.
  const renameSession = useRuntimeSelector((store) => store.renameSession)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const intent = useClickIntent()
  const retired = session.archived || session.status === 'exited'
  const starting = session.status === 'starting' || session.status === 'reconnecting'
  const needs =
    !retired && (issue ? sessionAsksOnIssue(issue, session) : sessionNeedsHuman(session))
  const phase = motionPhase(session)
  const since = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  const now = useRuntimeSelector((store) => store.coarseNow)
  const stamp = relativeTime(session.lastActiveAt, now)
  const total = session.agentState?.workingMsTotal
  const name = sessionDisplayName(session)
  const unread = sessionUnreadEmphasized(session)
  const lead = isLead(role)
  // The pointer is on this session's TAB, over in the strip. Same session, drawn
  // twice — so the row answers "this one" in the only device it has spare.
  const pointed = useSessionHovered(session.sessionId)
  // The native title mirrors the row's whole reading. It remains useful for an
  // exceptionally long value that wraps in the narrow two-line composition.
  const waited = Number.isFinite(since) ? relativeTime(new Date(since).toISOString(), now) : null
  const rowTitle = [
    name,
    session.displayRef,
    label,
    needs ? `Needs you${waited ? ` · ${waited}` : ''}` : null,
    retired ? `Retired · ${stamp}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const body = (
    <div
      className={cn(
        // SQUARE, AND OPEN TO THE LEFT. An agent row sits ON its parent's rail
        // rather than hanging off it as a pill: no rounded collar, because a
        // rounded edge is what makes the task strips read as units and an agent
        // is not one of those.
        // `deck-agent-row` is the wrapper the ticks and the ⋯ are positioned
        // against. The list is the query container, so every nesting depth
        // switches to the two-line composition at the same panel width.
        'deck-agent-row group/srow relative',
        // The mission's own lead. A FILL, and since POD-1480 no longer the only
        // one an agent row can take — the session you are in takes a second,
        // stronger tier of the same tint below. Two grounds, and they are two
        // statements only because the doses are far enough apart to read as
        // two; the arithmetic is on `.deck-agent-active` in styles.css.
        role?.kind === 'coordinator' && 'deck-lead-fill',
        // THE SESSION YOU ARE IN owns a ground, not just a tick (POD-1480).
        // Without one the pointed row — which takes the row's own hover wash —
        // was the loudest mark in the column, so pointing at any tab visibly
        // demoted the session you were actually working in. The row answers the
        // pointer in the same tint rather than in `--muted`; see styles.css.
        active && !flat && 'deck-agent-active',
        flat && 'rounded-md',
      )}
      style={{ marginLeft: flat ? 0 : AGENT_INDENT }}
      data-flight-session={session.sessionId}
      data-needs-you={needs ? 'true' : undefined}
      data-retired={retired ? 'true' : undefined}
      data-pointed={pointed ? 'true' : undefined}
    >
      {/* THE SESSION YOU ARE IN takes the same square accent tick a selected
          task takes, in the row's own gutter. Extending the mark rather than
          reaching for a fill is the whole point of the tick: "this one" is one
          device in this column, whatever kind of row it lands on.
          A row the pointer is on FROM THE TAB STRIP takes the SAME tick in a
          DIFFERENT HUE (POD-1480): one device, two colours, both at full
          strength. The issue accent is where you ARE, the no-colour `--flow`
          is where you are POINTING — a distinction the palette already draws,
          rather than a third mark this column would have to teach. Two
          strengths of one hue was the earlier attempt and 45% of a 3px tick is
          not a difference you catch peripherally, which is the whole job.
          A pointed row that is also the active one keeps the active mark: you
          are already there, so pointing at it says nothing new. The colours and
          the uncoloured-issue fallback live on `.deck-mark-*` in styles.css. */}
      {(active || pointed) && !flat && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute',
            active ? 'deck-mark-active' : 'deck-mark-pointed',
          )}
          style={{
            left: AGENT_RAIL - AGENT_INDENT + TICK_SELECTED_X,
            top: HUNG_MID - TICK_HEIGHT / 2,
            width: TICK_WIDTH,
            height: TICK_HEIGHT,
          }}
        />
      )}
      {/* THE ASK STANDS OUTSIDE THE RAIL, on the same side and at the same size
          a task strip's does (POD-1226) — never as a rule on the row's own edge,
          which is the 20px agent tile's edge. See the tick note in the geometry
          block above. Amber outranks the issue accent when both land, because
          they are on opposite sides of the rail and cannot overlap. */}
      {needs && !flat && (
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: AGENT_RAIL - AGENT_INDENT + TICK_ATTENTION_X,
            top: HUNG_MID - TICK_HEIGHT / 2,
            width: TICK_WIDTH,
            height: TICK_HEIGHT,
            background: 'var(--attention)',
          }}
        />
      )}
      {editing ? (
        <div className="flex min-h-7 items-center px-2 py-1">
          <SessionNameEditor
            value={name}
            onCommit={(next) => {
              void renameSession(session.sessionId, next)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          data-pressable
          type="button"
          className={cn(
            // No left padding — the row opens onto its rail.
            'deck-agent group/session shell-type-secondary grid min-h-7 w-full items-center gap-x-1.5 py-1 pr-2 text-left text-muted-foreground hover:text-foreground',
            // The neutral wash is for rows that have no ground of their own.
            // The ACTIVE row does, and `--muted` is less extreme than that
            // ground in both appearances — so letting it through would make the
            // one row you are in step BACK under the pointer while every other
            // row steps forward. It answers in its own tint instead, on the
            // wrapper (`.deck-agent-active:hover`), which is why the hover fill
            // is spent here rather than in the base string.
            !active && 'hover:bg-muted',
            active && 'text-foreground',
            // The pointer is on the tab, so the row takes the fill it would
            // have taken under the pointer itself. Borrowing the row's OWN
            // hover rather than inventing a second wash is what keeps this
            // legible without being loud: the strip is simply reaching in and
            // hovering the row on the operator's behalf.
            pointed && !active && 'bg-muted text-foreground',
            // Settled agents dim one tier rather than leaving. Removing them is
            // the view bar's job, not the row's.
            (retired || phase === 'done') && 'opacity-60',
          )}
          // One click previews, two promote (see `useClickIntent`). Enter is the
          // keyboard's double click and must not go through the click path, so
          // it cancels the browser's synthesised click first.
          onClick={() =>
            intent.press(
              () => onOpen(false),
              () => onOpen(true),
            )
          }
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            intent.commit(() => onOpen(true))
          }}
          // Right-click is the fast path into session lifecycle, exactly as it
          // is on the sidebar's rows — same menu, same gesture, one vocabulary.
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuAnchor({ x: event.clientX, y: event.clientY })
          }}
          title={rowTitle}
        >
          {/* FOUR ORDERED FIELDS — name · ref · role · state (POD-1146).
              On a wide deck they read in one line and the state owns the
              trailing edge. Name and role are content-sized rather than capped,
              so spare room reveals information instead of becoming dead air.
              When the row no longer fits, CSS turns the same four fields into
              two deliberate lines: name/state, then ref/role. No field is
              discarded just because the instrument was resized.
              WorkerLabel already says "Handing over → <target>" mid-move, in the
              same words the sidebar and the pane header use, so the row never
              invents a second vocabulary for the same event. */}
          <span className="deck-agent-name flex min-w-0 items-center gap-1.5 overflow-hidden">
            {/* `flex`, not a bare block — the sidebar's rows already wrap the
                label this way. A block parent leaves `WorkerLabel`'s inline-flex
                to size itself shrink-to-fit, which floors at the whole name;
                as a flex item it takes the width flex gives it and the name
                reaches its ellipsis (POD-1170). */}
            <span className={cn('flex min-w-0', unread && 'font-semibold text-text-strong')}>
              <WorkerLabel session={session} chip />
            </span>
            {unread ? (
              <>
                <UnreadDot />
                <span className="sr-only">unread</span>
              </>
            ) : null}
          </span>
          {/* THE REF IS THE HANDLE (POD-758). `POD-710-B` is what the operator
              types, pastes and says out loud, and it is the one string on the
              row that is worthless partly rendered — so it never truncates and
              the NAME shrinks around it. Lifted straight off the session: it is
              the permanent birth ref, so it survives a rename. */}
          {/* Left-aligned in its own fixed column (POD-1461): the refs on a
              mission share a stem, so aligning their STARTS is what makes the
              suffix that distinguishes them the thing that moves. */}
          <span className="deck-agent-ref shell-type-micro flex-none text-left font-mono font-normal whitespace-nowrap text-text-faint">
            {session.displayRef}
          </span>
          {/* Attention and provenance are different facts. The state remains the
              louder one, but it no longer deletes the role to make itself fit;
              narrow rows have a second line for that job. */}
          {role && label ? <RoleWord role={role} label={label} /> : null}
          <span
            className={cn(
              'deck-agent-state flex flex-none items-center justify-end gap-1.5',
              // Every row parks its operational fact against the trailing edge.
              // The 80px shared state measure is now a floor, not a fixed box:
              // long obligations keep their words and short timers still align.
              STATE_COL,
            )}
          >
            {needs ? (
              <>
                <span
                  aria-hidden
                  className="flex size-3 flex-none items-center justify-center rounded-full bg-attention shell-type-micro leading-none font-bold text-attention-foreground"
                >
                  !
                </span>
                <span className="shell-type-micro font-semibold text-attention">Needs you</span>
                {Number.isFinite(since) && (
                  <PhaseTimer
                    phase="waiting"
                    sinceMs={since}
                    leadingSeparator
                    className="deck-agent-elapsed"
                  />
                )}
              </>
            ) : retired ? (
              <span className="shell-type-micro font-mono whitespace-nowrap text-text-faint">
                Retired
                {/* Keep the retirement age visible. Narrow rows make room by
                    changing composition, not by silently dropping the stamp. */}
                <span className="deck-agent-elapsed"> · {stamp}</span>
              </span>
            ) : starting ? (
              <span className="shell-type-micro font-mono text-text-dim">Starting</span>
            ) : phase === 'working' && Number.isFinite(since) ? (
              <PhaseTimer phase="working" sinceMs={since} baseMs={total ?? 0} />
            ) : (
              <>
                {phase === 'done' ? (
                  <Check size={11} aria-hidden className="flex-none text-success" />
                ) : (
                  <Hourglass size={10} aria-hidden className="flex-none text-text-faint" />
                )}
                {phase === 'done' && total !== undefined && Number.isFinite(since) ? (
                  <PhaseTimer phase="done" sinceMs={since} totalMs={total} />
                ) : (
                  <span className="shell-type-micro font-mono text-text-dim">{stamp}</span>
                )}
              </>
            )}
          </span>
        </button>
      )}
      {/* The hover affordance for the same menu. Right-click is the fast path
          and the one the sidebar already teaches; the ⋯ is how an operator who
          has never right-clicked a row finds out these actions exist at all. It
          floats over the row's right edge so revealing it never reflows. */}
      {!editing && (
        <div
          data-hover-reveal
          className="absolute top-0.5 right-1 hidden items-center rounded-md bg-chip group-hover/srow:flex"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-5 text-text-dim"
            aria-label={`Session actions for ${name}`}
            title="Session actions"
            onClick={(event) => {
              event.stopPropagation()
              setMenuAnchor({ x: event.clientX, y: event.clientY })
            }}
          >
            <Ellipsis size={12} aria-hidden="true" />
          </Button>
        </div>
      )}
      <NativeRows session={session} onOpen={onOpenNative} />
      {menuAnchor && (
        <PoolSessionContextMenu
          sessionId={session.sessionId}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onRename={() => {
            setMenuAnchor(null)
            setEditing(true)
          }}
        />
      )}
    </div>
  )
  return flat ? (
    body
  ) : (
    <Hung
      railX={AGENT_RAIL}
      indent={AGENT_INDENT}
      mid={HUNG_MID}
      last={last}
      rail={rail}
      // THE LEAD'S OWN ELBOW IS THE ONLY COLOURED ONE. Everybody in the block
      // hangs on the same coloured line; only the agent the line is ABOUT is
      // joined to it in that colour, so the branch names one agent instead of
      // tinting the roster. It carries provenance and nothing else now
      // (POD-1226): the ask has its own tick on the far side of the rail, so
      // there is no longer a claim here for amber to outrank.
      elbow={lead ? rail.className : 'bg-hairline-soft'}
    >
      {body}
    </Hung>
  )
})

/** The agents on a task, hung off it. Shared by the strips and by the MISSION
 *  HEADER, which is the root of the tree and hangs its own agents the same way
 *  (round 3 §4) — one idiom, so the root reads as a node and not as a special
 *  case. The seat a task holds for the agent it does not have is NOT here any
 *  more: it is a chip on the strip itself (see `SeatChip`). */
interface HungContext {
  issue: IssueNavigationModel
  sessions: SessionView[]
  rootId: string | undefined
  inMission: ReadonlySet<string>
  nameOf: (sessionId: SessionId) => string | undefined
  activeSessionId: SessionId | null
  /** Session ids that appeared since the deck settled — see `useArrivals`. */
  arrivals: ReadonlySet<string>
  settle: (key: string) => void
  /** The block's left inset; its hung rails sit `AGENT_RAIL` inside that. */
  inset: number
  /** The branch line this block draws — coloured when the task has a lead. */
  rail: Rail
  /** Keep the last row's rail running to the block's bottom edge, because the
   *  tree carries on below it. The root block sets this; a strip never does. */
  tail: boolean
  onSelectSession: (session: SessionView, permanent: boolean) => void
  onSelectNative: (session: SessionView) => void
  window?: DeckWindow
  model?: MissionDeckIssueModel
  mode?: FlightDeckMode
}

export const HungRows = observer(function HungRows(ctx: HungContext): JSX.Element | null {
  const reduce = useReducedMotion()
  const ids = ctx.model?.sessionIds(ctx.mode ?? 'full') ?? ctx.sessions.map(session => session.sessionId)
  if (ids.length === 0) return null
  return (
    <div className="relative" style={{ marginLeft: ctx.inset }}>
      {ids.map((sessionId, index) => {
        const key = deckSessionKey(ctx.issue.id, sessionId)
        if (ctx.window?.enabled && !ctx.window.contains(key)) {
          return (
            <DeckRowPlaceholder
              key={sessionId}
              row={{ key, size: 46, get text() { return ctx.window?.text(key) } }}
              window={ctx.window}
            />
          )
        }
        const session = ctx.model ? requireLoaded(ctx.model.view.session(sessionId))! : ctx.sessions[index]!
        const role = sessionRole(ctx.issue, session, {
          rootId: ctx.rootId,
          siblings: ctx.model?.sessions ?? ctx.sessions,
          inMission: ctx.inMission,
        })
        const row = (
          <SessionRow
            key={session.sessionId}
            session={session}
            issue={ctx.issue}
            role={role}
            label={roleLabel(role, ctx.nameOf)}
            active={ctx.activeSessionId === session.sessionId}
            last={!ctx.tail && index === ids.length - 1}
            rail={ctx.rail}
            onOpen={(permanent) => ctx.onSelectSession(session, permanent)}
            onOpenNative={() => ctx.onSelectNative(session)}
          />
        )
        // A SESSION JOINING A TASK MAKES SPACE, then arrives (round 3 §7c). Only
        // a session that appeared AFTER the deck settled animates — `useArrivals`
        // is the same latch the sidebar rows use, so opening the workspace never
        // replays a mission's worth of entrances.
        return ctx.arrivals.has(session.sessionId) && !reduce ? (
          <motion.div
            key={session.sessionId}
            ref={ctx.window?.enabled ? ctx.window.measure(key) : undefined}
            className="overflow-hidden"
            // CONTAINED, BECAUSE THIS ONE ANIMATES HEIGHT (POD-1146).
            //
            // Animating `height` relayouts every frame. Without containment the
            // webview is free to keep a stale tile of a row mid-collapse, and
            // what the operator sees is one strip repeated three times with
            // fragments of its neighbour torn between them — inside a scrolling
            // container, which is where compositing bugs of this shape live.
            // `contain: layout paint` makes the wrapper its own containing block
            // and clips its subtree to it, so a growing row can never paint past
            // its own bounds however the frame lands. The promoted layer is
            // dropped for free at the end of the one-shot: `settle()` retires
            // this session from `arrivals`, and the plain `<div>` below replaces
            // the motion element entirely.
            style={{ contain: 'layout paint' }}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            onAnimationComplete={() => ctx.settle(session.sessionId)}
          >
            {row}
          </motion.div>
        ) : (
          <div
            key={session.sessionId}
            ref={ctx.window?.enabled ? ctx.window.measure(key) : undefined}
          >
            {row}
          </div>
        )
      })}
    </div>
  )
})

/** Flat tails use the same measured window as the spine. An unbounded proposal
 * or archived tail would defeat the mount budget even while it is offscreen. */
export function DeckFlatRows({
  rows,
  scrollRef,
  scope,
  className,
  gap,
  revealSessionId,
  children,
}: {
  rows: DeckWindowRow[]
  scrollRef: RefObject<HTMLElement | null>
  scope: string
  className: string
  gap: number
  revealSessionId?: string | null
  children: (index: number) => ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const window = useFlightDeckWindow(rows, scrollRef, ref, scope)
  useLayoutEffect(() => {
    if (!revealSessionId || !window.enabled) return
    const target = rows.find((row) => row.key.endsWith(`:${revealSessionId}`))
    if (target && !window.contains(target.key)) window.reveal(target.key)
  }, [revealSessionId, rows, window])
  return (
    <div ref={ref} className={className} style={window.enabled ? { gap: 0 } : undefined}>
      {rows.map((row, index) =>
        window.enabled ? (
          window.contains(row.key) ? (
            <div key={row.key} ref={window.measure(row.key)} style={{ paddingBottom: gap }}>
              {children(index)}
            </div>
          ) : (
            <DeckRowPlaceholder key={row.key} row={row} window={window} />
          )
        ) : (
          children(index)
        ),
      )}
    </div>
  )
}

export const TaskRow = observer(
  function TaskRow({
    row,
    renameSeed,
    carries,
    mode,
    rootId,
    inMission,
    nameOf,
    selected,
    activeSessionId,
    arrivals,
    settle,
    collapsed,
    rails,
    agentRail,
    childFollows,
    window: deckWindow,
    onToggle,
    onSelectIssue,
    onSelectSession,
    onSelectNative,
    onMenu,
    onRenameIssue,
    onStatusPick,
    onRenameDone,
  }: {
    row: MissionDeckIssueModel
    /** The displayed title captured when Rename opened. `null` keeps the row in
     *  read mode; a string keeps the editor and its no-op comparison in sync. */
    renameSeed: string | null
    /** Which ancestor guide rails cross this row — see `treeGuides`. */
    carries: readonly boolean[]
    /** The tone of the rail at each of those levels — see `railTones`. */
    rails: readonly RailTone[]
    /** The line this task's OWN agents hang on: coloured when it has a lead. */
    agentRail: Rail
    /** Whether the next RENDERED row is a child of this task. Its agents and its
     *  children share one line, so the line has to survive the gap between this
     *  block and the next row instead of stopping at the last agent's elbow. */
    childFollows: boolean
    window?: DeckWindow
    mode: FlightDeckMode
    rootId: string | undefined
    inMission: ReadonlySet<string>
    nameOf: (sessionId: SessionId) => string | undefined
    selected: boolean
    activeSessionId: SessionId | null
    arrivals: ReadonlySet<string>
    settle: (key: string) => void
    collapsed: boolean
    folds: FoldMap
    onToggle: () => void
    /** Single click previews the task's lead session (and toggles the fold);
     *  double click / Enter opens it permanently. */
    onSelectIssue: (permanent: boolean) => void
    onSelectSession: (session: SessionView, permanent: boolean) => void
    onSelectNative: (session: SessionView) => void
    /** Open the shared task menu at the cursor — right-click, or the ⋯ reveal. */
    onMenu: (event: ReactMouseEvent) => void
    /** The strip's status glyph is a picker (POD-1271) — the deck applies it. */
    onStatusPick: (value: string) => void
    /** Rename this task's title (POD-1077). Already trimmed and known-changed —
     *  the commit policy lives in the deck, next to the state that opens the
     *  editor, so the row has no rename decision of its own to get wrong. */
    onRenameIssue: (title: string) => void
    /** Commit or cancel — either way the deck clears its rename target. */
    onRenameDone: () => void
  }): JSX.Element {
    const intent = useClickIntent()
    const payload = row.hasPayload
    const bandLeft = SPINE_PAD + row.depth * DEPTH_STEP
    const ownRailX = SPINE_PAD + (row.depth - 1) * DEPTH_STEP + RAIL_INSET
    // A visible session can belong to a task whose band is offscreen. That
    // session needs its own owner fields, but never the hidden band's payload.
    if (deckWindow?.enabled && !deckWindow.contains(deckTaskKey(row.id))) {
      const issue = requireLoaded(row.view.catalogIssue(row.id))!
      return <div className="relative pb-1.5" data-flight-issue={row.id} data-depth={row.depth}>
        <BranchGuides carries={carries} rails={rails} mid={row.stage === 'proposed' ? PROPOSED_MID : BAND_MID} />
        <DeckRowPlaceholder row={{ key: deckTaskKey(row.id), size: BAND_HEIGHT, get text() { return deckWindow.text(deckTaskKey(row.id)) } }} window={deckWindow} />
        {!collapsed && <HungRows issue={issue} sessions={[]} model={row} mode={mode} rootId={rootId} inMission={inMission} nameOf={nameOf}
          activeSessionId={activeSessionId} arrivals={arrivals} settle={settle} inset={bandLeft} rail={agentRail} tail={childFollows}
          onSelectSession={onSelectSession} onSelectNative={onSelectNative} window={deckWindow} />}
      </div>
    }
    const raw = row.view.issue(row.id)
    if (!raw || typeof raw === 'symbol') return <div className="relative pb-1.5" data-flight-issue={row.id}><GhostBar /></div>
    const displayTitle = row.title
    const presentation = settled(() => row.presentation)
    if (presentation === LOADING) return <div className="relative pb-1.5" data-flight-issue={row.id}><GhostBar /></div>
    if (!presentation) throw new Error('Pool mission row has no presentation values')
    const state = presentation!.state
    const sessions = deckSessions(row, mode)
    /**
     * A ROW THAT IS ONLY THE PATH TO A MATCH (POD-1245).
     *
     * The filters keep a match's ancestors so an exception never loses its
     * context, and this row used to be indistinguishable from the task that
     * actually matched: same fill, same outline, same state word, same crew. On
     * `Needs you` that turned one stopped agent into a column of rows all
     * looking like they wanted something.
     *
     * So a context row stops being a strip and becomes what it is — the tree
     * getting to the match. No fill, no outline, no seat, no note, no state
     * word, and (via `deckSessions`) no agents. What survives is the rail, the
     * ref and the title, one tier down: enough to place the match, not enough to
     * compete with it.
     *
     * `Active` draws context rows the same way now (POD-1452). It used to be
     * exempt because it matched whole open tasks, so its path rows were live
     * work in their own right; it matches AGENTS now, and a row on the path to a
     * working agent is scaffolding exactly as it is under `Needs you`.
     */
    const context = mode !== 'full' && !row.matched
    // A PROPOSAL IS A DIFFERENT KIND OF ROW (round 3 §7b): nobody has accepted it,
    // so it holds no seat for an agent and takes the shorter band. Only one with
    // sub-tasks reaches this component — the childless ones leave the tree
    // entirely for the Proposed tail below it.
    const proposed = row.issue.stage === 'proposed'
    const bandHeight = proposed ? PROPOSED_BAND : BAND_HEIGHT
    const mid = proposed ? PROPOSED_MID : BAND_MID
    const note = presentation!.note
    // The seat is held for work that could be picked up — never under a proposal,
    // and never to restate a dependency the strip has already named above it.
    const seat = proposed ? null : seatFor(presentation!.presence)
    // A FOLDED BRANCH REPORTS LIVE STATE, not the count already in its payload
    // chip: "2 running" is the thing the fold is hiding, and `3 tasks` is printed
    // two inches to the left of it.
    const folded = collapsed && payload
    const unread = deckTaskUnread(row, collapsed, row.updatedBelow)
    const liveWord =
      folded && row.descendantIds.length > 0 && row.workingAgentCount > 0
        ? `${row.workingAgentCount} running`
        : undefined
    return (
      <div className="relative pb-1.5" data-flight-issue={row.issue.id} data-depth={row.depth}>
        <BranchGuides carries={carries} rails={rails} mid={mid} />
        {/* THE TASK'S OWN DESCENT — one unbroken line from the strip down through
          its agents and on into its first child. It starts behind the (opaque)
          strip and runs to the block's bottom edge, so the gap between this
          block and the row below it never breaks the branch. `HungRows` draws
          the same line at the same x for its elbows; this is what carries it
          across the padding they cannot reach. */}
        {!collapsed && (sessions.length > 0 || childFollows) && (
          <span
            aria-hidden
            className={cn('pointer-events-none absolute', agentRail.className)}
            style={{ left: bandLeft + AGENT_RAIL, top: mid, bottom: 0, width: agentRail.width }}
          />
        )}
        {/* COLOUR ARRIVES AS A TICK IN THE GUTTER, NEVER AS A SURFACE. Both marks
          stand beside the strip rather than on it: attention outside the rail,
          selection inside it, so a selected task that also has somebody asking
          shows two ticks and neither one has to become the other. */}
        {state.attention && (
          <span
            aria-hidden
            className="pointer-events-none absolute bg-attention"
            style={{
              left: ownRailX + TICK_ATTENTION_X,
              top: mid - TICK_HEIGHT / 2,
              width: TICK_WIDTH,
              height: TICK_HEIGHT,
            }}
          />
        )}
        {selected && (
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: ownRailX + TICK_SELECTED_X,
              top: mid - TICK_HEIGHT / 2,
              width: TICK_WIDTH,
              height: TICK_HEIGHT,
              background: 'var(--issue)',
            }}
          />
        )}
        {/* A TASK IS GREY, IN EVERY STATE (POD-758) — done, running, blocked,
          moving, open or closed, selected or not. One fill for one kind of
          thing is what lets the column's only other fill (a proposal's fuchsia)
          mean exactly one thing: this task does not exist yet.
          So selection is not a fill and not an accent border either. It darkens
          the outline one step, bolds the title, and takes the accent tick in
          the gutter above — three quiet changes to the row itself rather than
          one loud one that turns a strip into a callout card.
          BLOCKED WEARS A HATCH (round 3 §8) — a shallow diagonal rule over the
          same ground. No border, no hue: blocked is a stopped state, and
          `--warning` IS `--attention` in this theme, so any warning tone here
          would read as "answer me".
          The band's own HEIGHT transitions, so a task leaving `proposed` grows
          into its full strip rather than snapping (§7c). */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu covers the strip; its buttons provide keyboard actions. */}
        <div
          ref={deckWindow?.enabled ? deckWindow.measure(deckTaskKey(row.issue.id)) : undefined}
          className={cn(
            'deck-strip group/task relative flex items-center gap-1 rounded-row border pr-1.5 transition-[border-color,min-height] duration-200 ease-out motion-reduce:transition-none',
            context ? 'bg-transparent' : 'bg-tabstrip',
            state.state === 'blocked' && !context && 'deck-hatch',
            // Selection still outlines a context row: the operator can click one
            // to go and look at it, and a click with no answer is worse than a
            // quiet row.
            selected
              ? 'border-border-strong'
              : context
                ? 'border-transparent hover:border-hairline-soft'
                : 'border-hairline-soft hover:border-hairline-bar',
          )}
          style={{ marginLeft: bandLeft, minHeight: bandHeight }}
          // A TASK ANSWERS THE SAME GESTURE ITS AGENTS DO (POD-771). Right-click
          // on an agent row has opened session lifecycle since POD-710; the task
          // it hangs under offered nothing, so stage, placement, colour and close
          // were reachable from the board and the sidebar but not from the column
          // the operator actually works in. Same menu as those two surfaces —
          // imported, never forked.
          onContextMenu={onMenu}
        >
          {payload ? (
            <button
              data-pressable
              type="button"
              className="flex size-5 flex-none items-center justify-center text-text-dim hover:text-text-strong"
              aria-label={collapsed ? `Expand ${displayTitle}` : `Collapse ${displayTitle}`}
              aria-expanded={!collapsed}
              // The chevron is the ONE control that folds without navigating, and
              // it acts immediately — the row's own click is deferred by the
              // double-click window, so an operator folding a long spine has an
              // affordance that never waits.
              onClick={onToggle}
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          ) : (
            <span className="size-5 flex-none" />
          )}
          {/* RENAMING IN PLACE (POD-1077). The deck could not rename a task at
            all — it mounted the shared menu without `onRename`, which gates the
            entry — so the column the operator works in was the one column that
            could not fix a title. Same hook and same editor the sidebar row and
            the session row above already use. */}
          {renameSeed !== null ? (
            <span className={cn('flex min-w-0 flex-1 items-center', proposed ? 'py-0.5' : 'py-1')}>
              <SessionNameEditor
                value={renameSeed}
                onCommit={(next) => {
                  onRenameIssue(next)
                  onRenameDone()
                }}
                onCancel={onRenameDone}
              />
            </span>
          ) : (
            <button
              data-pressable
              type="button"
              className={cn(
                // gap-1.5, not gap-2: five gaps at 8px is 40px of the row spent on
                // air, and the title is the thing that pays for it.
                'deck-task-content flex min-w-0 flex-1 items-center gap-1.5 text-left',
                proposed ? 'py-0.5' : 'py-1',
              )}
              onClick={() =>
                intent.press(
                  () => onSelectIssue(false),
                  () => onSelectIssue(true),
                )
              }
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                intent.commit(() => onSelectIssue(true))
              }}
            >
              <span className="deck-task-identity flex min-w-0 flex-1 items-center gap-1.5">
                {/* POD-1074's status glyph, kept: the strip states one status, not
                a stage. Only the wrapper around this button is POD-1077's — and
                since POD-1271 the glyph is also the door onto changing it, which
                is why the row's own click stops at its edge. */}
                <IssueStatusPicker issue={row.issue} size={13} onPick={onStatusPick} />
                {/* THE TITLE OUTRANKS EVERYTHING ELSE IN THE ROW: it has a floor and
              it is the only thing here that shrinks. Ref THEN title, in one
              truncating label — the ref is how the operator addresses the task
              everywhere else in Podium, and a right-aligned ref made the column
              read right-to-left. */}
                <span
                  className={cn(
                    'shell-type-secondary min-w-0 flex-1 truncate',
                    context ? 'text-text-dim' : 'text-text-strong',
                    selected || unread ? 'font-semibold' : 'font-medium',
                  )}
                >
                  <span className="shell-type-micro mr-1.5 font-mono font-normal text-text-faint">
                    {issueDisplayRef(row.issue)}
                  </span>
                  {displayTitle}
                </span>
                {unread ? (
                  <>
                    <UnreadDot />
                    <span className="sr-only">unread</span>
                  </>
                ) : null}
              </span>
              {/* Everything below is the row REPORTING on itself, and a context
                row has nothing to report — it is here to be walked past. The
                fold's payload survives, because a folded context row still has
                to say how much tree it is hiding. */}
              {!context && (
                <span className="deck-task-meta flex flex-none items-center gap-1.5">
                  {note && <IssueNoteChip note={note} />}
                  {seat && <SeatChip note={seat} />}
                  {folded && <CollapsedPayload summary={row.collapsedSummary} />}
                  {folded && row.collapsedSummary.crew.length > 0 && (
                    <CrewCensus crew={row.collapsedSummary.crew} />
                  )}
                  <StateLabel value={state} label={liveWord} />
                </span>
              )}
            </button>
          )}
          {/* The same pairing the agent rows use: right-click is the fast path,
            and the ⋯ is how an operator who has never right-clicked a strip
            finds out these actions exist. It floats over the row's right edge
            so revealing it never reflows the state column. */}
          <div
            data-hover-reveal
            className="absolute top-0.5 right-1 hidden items-center rounded-md bg-chip group-hover/task:flex"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 text-text-dim"
              aria-label={`Task actions for ${displayTitle}`}
              title="Task actions"
              onClick={(event) => {
                event.stopPropagation()
                onMenu(event)
              }}
            >
              <Ellipsis size={12} aria-hidden="true" />
            </Button>
          </div>
        </div>
        {/* THE FOLD GROWS AND SHRINKS (round 3 §7c) — a grid-rows collapse that
          needs no measurement and no mount, so nothing choreographs on first
          paint: a transition only runs when a value actually changes. */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
        >
          <div className="min-h-0 overflow-hidden">
            {(!collapsed || !deckWindow?.enabled) && (
              <HungRows
                issue={row.issue}
                sessions={[]}
                model={row}
                mode={mode}
                rootId={rootId}
                inMission={inMission}
                nameOf={nameOf}
                activeSessionId={activeSessionId}
                arrivals={arrivals}
                settle={settle}
                inset={bandLeft}
                rail={agentRail}
                tail={childFollows}
                onSelectSession={onSelectSession}
                onSelectNative={onSelectNative}
                window={deckWindow}
              />
            )}
          </div>
        </div>
      </div>
    )
  },

)

/**
 * A PROPOSAL IS THE COLUMN'S ONLY OTHER FILL (POD-758).
 *
 * The spine has exactly two grounds: grey for a task, fuchsia for a proposal.
 * That is the whole reason selection and attention had to become ticks — with
 * two fills and nothing else, purple in this column means one thing and one
 * thing only, and the operator learns it in a glance: THIS TASK DOES NOT EXIST
 * YET. The stage's own hue is taken from `issue-glyphs`, so the glyph, the ref
 * and the ground are three spellings of one fact.
 *
 * A proposal is something an AGENT asked for, so the row names the session that
 * asked — the ref is how you go and ask it why. It holds no seat (nobody has
 * accepted it), wears no state word (it has no state to be in) and takes the
 * shorter band, because a row with nothing happening in it should not occupy
 * the space of a row that has.
 */
export const ProposalRow = observer(function ProposalRow({
  row,
  selected,
  onSelect,
  onMenu,
  onStatusPick,
}: {
  row: MissionDeckIssueModel
  selected: boolean
  onSelect: (permanent: boolean) => void
  /** A proposal is still a task: same right-click menu as a strip. */
  onMenu: (event: ReactMouseEvent) => void
  /** Match every other issue row in the deck: its status mark opens the picker. */
  onStatusPick: (value: string) => void
}): JSX.Element {
  const intent = useClickIntent()
  const issue = row.view.issue(row.id)
  if (!issue || typeof issue === 'symbol') return <GhostBar />
  const author = issue.startedBySession ? row.view.session(issue.startedBySession) : undefined
  const authorRef = author && typeof author !== 'symbol' ? author.displayRef?.trim() || null : null
  return (
    <div data-flight-issue={issue.id}>
      <button
        data-pressable
        type="button"
        onContextMenu={onMenu}
        className={cn(
          'deck-strip flex w-full items-center gap-2 rounded-row border px-2 text-left',
          selected
            ? 'border-fuchsia-500/40 bg-fuchsia-500/8'
            : 'border-fuchsia-500/15 bg-fuchsia-500/5 hover:border-fuchsia-500/30',
        )}
        style={{ minHeight: PROPOSED_BAND }}
        onClick={() =>
          intent.press(
            () => onSelect(false),
            () => onSelect(true),
          )
        }
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          intent.commit(() => onSelect(true))
        }}
      >
        <IssueStatusPicker issue={issue} onPick={onStatusPick} />
        <span className="shell-type-secondary min-w-0 flex-1 truncate text-muted-foreground">
          <span className="shell-type-micro mr-1.5 font-mono text-fuchsia-500">
            {issueDisplayRef(issue)}
          </span>
          {issue.title}
        </span>
        {/* Never dropped: the author IS the proposal's secondary content, and a
            row with only a title tells the operator nothing to act on. It parks
            in the spine's state column with the "by" gone — three refs reading
            down one edge, not three ragged phrases — because the column already
            says what this cell is by being where it is. */}
        <span
          className={cn(
            'shell-type-micro flex-none truncate text-right font-mono text-fuchsia-500',
            STATE_COL,
          )}
          title={authorRef ? `Proposed by ${authorRef}` : undefined}
        >
          {authorRef}
        </span>
      </button>
    </div>
  )
})
