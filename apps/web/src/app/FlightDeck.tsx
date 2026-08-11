import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  archivedSessionsForIssue,
  buildFlightDeckRows,
  type CollapsedSummary,
  type DeckIssueState,
  type DeckState,
  deckIssueState,
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  type IssueNavigationModel,
  type IssueNote,
  isCoordinatorSession,
  issueNote,
  type MissionDeparture,
  missionDepartures,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  motionPhase,
  nativeSubagentRows,
  type PresenceNote,
  presenceNote,
  reposToViews,
  type SessionRole,
  sessionNeedsHuman,
  sessionRole,
  sessionSettled,
  treeGuides,
} from '@podium/client-core/viewmodels'
import type { AgentKind, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  Ellipsis,
  Hourglass,
  Search,
  X,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { BrailleSpinner, PhaseTimer, useArrivals } from '@/lib/motion'
import { type ContextMenuAnchor, SessionContextMenu } from '@/lib/SessionContextMenu'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { MissionGauge } from './MissionGauge'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useReplicaIssues, useStoreSelector } from './store'

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full spine' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

/**
 * The spine's geometry, in one place because the tree guides are drawn from it.
 *
 * The rows render FLAT — one strip per issue, indented — so a filter, a search
 * or (later) a window can drop any of them without re-parenting anything. What
 * makes it read as a tree is that every row draws the rail segments crossing it
 * and the elbow into its own strip, so adjacent rows compose one continuous
 * line. `treeGuides` in mission.ts decides which rails carry on past a row.
 *
 * A TASK'S AGENTS AND ITS CHILD TASKS SHARE ONE RAIL (POD-758). They used to
 * hang on two lines two pixels apart, so that a child task landed left of its
 * parent's agents and could never be misread as one. The redesign makes an
 * agent row a different KIND of object instead — no strip, no fill, no rounded
 * edge — which settles the same confusion without spending a second line on it,
 * and lets one branch line carry everything a task owns.
 */
const SPINE_PAD = 8
const DEPTH_STEP = 16
/** Where a nesting level's rail sits inside its own step. Also the inset of a
 *  task's agent rail inside its own band, because they are the same line. */
const RAIL_INSET = 8
/** A task strip's height, and its vertical centre — where its elbow lands. */
const BAND_HEIGHT = 32
const BAND_MID = BAND_HEIGHT / 2
/**
 * A PROPOSED strip is shorter — nobody has accepted it, so it holds no space for
 * an agent and needs none for itself (POD-516 round 3 §7b). Its elbow moves with
 * it: a rail that met a 30px band's centre would enter a 24px one three pixels
 * low, which is exactly the kind of near-miss that makes a tree look drawn
 * rather than computed.
 */
const PROPOSED_BAND = 26
const PROPOSED_MID = PROPOSED_BAND / 2
/** A session row's inset inside its task strip, and its own rail — one issue
 *  step and the step's own rail, so an agent and a child task hang on the SAME
 *  line at the SAME indent (see the note above). */
const AGENT_INDENT = DEPTH_STEP
const AGENT_RAIL = RAIL_INSET
/**
 * THE MISSION'S OWN RAIL — where a depth-1 strip draws its line (`BranchGuides`'
 * `ownX` at depth 1). The header, the view bar and the root's own agent rows all
 * line up on it, which is what lets the spine leave the mission header as one
 * unbroken line instead of the mission being repeated as a strip (round 3 §4).
 */
const ROOT_RAIL = SPINE_PAD + RAIL_INSET
/**
 * The root block's inset, chosen so the root's sessions hang on ROOT_RAIL
 * EXACTLY: the header's descent is not merely near their rail, it IS their rail,
 * and the line continues through their elbows into the first child below.
 */
const ROOT_BLOCK_INSET = ROOT_RAIL - AGENT_RAIL
/** Where a depth-1 strip's band begins — the left edge everything in the column
 *  that is not the spine itself aligns to, so the rail runs in a clear gutter. */
const GUTTER = SPINE_PAD + DEPTH_STEP
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
/** Offsets from the row's own rail: selection just inside it, attention just
 *  outside — so attention is always the leftmost thing on the row. */
const TICK_SELECTED_X = RAIL_INSET - 5
const TICK_ATTENTION_X = -5
/** The right-hand column every row parks its state in, so the whole mission
 *  scans as one vertical read. Rigid: the title is the only shrinker. */
const STATE_COL = 70

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
type RailTone = 'mission' | 'task' | null

interface Rail {
  className: string
  width: number
}

const HAIRLINE_RAIL: Rail = { className: 'bg-hairline-soft', width: 1 }

const railFor = (tone: RailTone): Rail =>
  tone === 'mission'
    ? { className: 'deck-rail-mission', width: 2 }
    : tone === 'task'
      ? { className: 'deck-rail-task', width: 2 }
      : HAIRLINE_RAIL

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

const readMode = (raw: string | null): FlightDeckMode =>
  raw === 'active' || raw === 'needs-you' ? raw : 'full'
const writeMode = (mode: FlightDeckMode): string | null => (mode === 'full' ? null : mode)

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
export type FoldState = 'open' | 'closed'
export type FoldMap = ReadonlyMap<string, FoldState>

const EMPTY_FOLDS: FoldMap = new Map<string, FoldState>()

const idsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

/** Total, like every persisted reader here: a malformed or older blob falls back
 *  to "nothing explicit" rather than throwing. The v1 format was a bare array of
 *  collapsed ids — every one of those WAS an explicit fold, so it migrates to
 *  `closed` rather than being dropped. */
export const readFolds = (raw: string | null): FoldMap => {
  if (!raw) return EMPTY_FOLDS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_FOLDS
  }
  if (Array.isArray(parsed)) {
    const legacy = idsIn(parsed)
    return legacy.length === 0
      ? EMPTY_FOLDS
      : new Map(legacy.map((id): [string, FoldState] => [id, 'closed']))
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_FOLDS
  const blob = parsed as { open?: unknown; closed?: unknown }
  const folds = new Map<string, FoldState>()
  for (const id of idsIn(blob.open)) folds.set(id, 'open')
  for (const id of idsIn(blob.closed)) folds.set(id, 'closed')
  return folds.size === 0 ? EMPTY_FOLDS : folds
}

export const writeFolds = (folds: FoldMap): string | null => {
  if (folds.size === 0) return null
  const open: string[] = []
  const closed: string[] = []
  for (const [id, state] of folds) (state === 'open' ? open : closed).push(id)
  return JSON.stringify({ v: 2, open, closed })
}

type FoldableRow = Pick<FlightDeckRow, 'issue' | 'descendantIds' | 'sessions'>

/** Whether a task has anything to fold at all. A payload-less strip draws no
 *  chevron and never enters the fold map. */
export function hasPayload(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return row.descendantIds.length > 0 || row.sessions.length > 0
}

/**
 * The default when the operator has said nothing: a task whose ENTIRE payload is
 * one session and no sub-tasks arrives closed, everything else with a payload
 * arrives open. Folding the one-session task hides a row that only restates the
 * strip; folding a branch hides work.
 */
export function defaultFolded(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return row.descendantIds.length === 0 && row.sessions.length === 1
}

/** The effective fold: an explicit value wins, else the default rule. */
export function isFolded(row: FoldableRow, folds: FoldMap): boolean {
  const explicit = folds.get(row.issue.id)
  return explicit === undefined ? defaultFolded(row) : explicit === 'closed'
}

/** What the mission search matches on a row: its title, its ref, its agents. */
function matchesQuery(row: FlightDeckRow, needle: string): boolean {
  return (
    row.issue.title.toLowerCase().includes(needle) ||
    issueDisplayRef(row.issue).toLowerCase().includes(needle) ||
    row.sessions.some((session) => sessionDisplayName(session).toLowerCase().includes(needle))
  )
}

/**
 * SINGLE CLICK AND DOUBLE CLICK ON ONE TARGET, resolved without a race.
 *
 * A preview open and a permanent open are the same gesture repeated, so the
 * first click cannot act immediately — it would leave a stray fold toggle (and a
 * second navigation) behind every double click. The first click schedules; a
 * second click inside the window cancels the schedule and promotes instead,
 * which is the "promote on the second click" arm the contract allows and the one
 * that needs no `dblclick` event to be delivered.
 *
 * One instance per row, so a fast click on one row followed by another row is
 * two singles rather than a double.
 */
const DOUBLE_CLICK_MS = 260

interface ClickIntent {
  press: (single: () => void, double: () => void) => void
  /** Enter is the keyboard's double click; it also drops anything pending. */
  commit: (double: () => void) => void
}

function useClickIntent(): ClickIntent {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback((): boolean => {
    if (pending.current === null) return false
    clearTimeout(pending.current)
    pending.current = null
    return true
  }, [])
  useEffect(() => () => void cancel(), [cancel])
  return useMemo(
    () => ({
      press: (single, double) => {
        if (cancel()) {
          double()
          return
        }
        pending.current = setTimeout(() => {
          pending.current = null
          single()
        }, DOUBLE_CLICK_MS)
      },
      commit: (double) => {
        cancel()
        double()
      },
    }),
    [cancel],
  )
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
 * NOTHING HERE IS AMBER. Under the round-2 model attention belongs to the
 * session that asked, so amber on a task strip is the one colour this slot may
 * not spend. `Blocked` therefore takes no hue either: in the Superade theme
 * `--warning` IS `--attention` (#f5c518), so a warning-toned "Blocked" would
 * read as "answer me" on the very surface built to tell those apart. Blocked is
 * a stopped state, not an obligation — the ⊘ mark and the named reason
 * underneath carry it, and the dot beside them is the only amber on the strip.
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
  return state === 'working' ? <BrailleSpinner size={9} className="flex-none" /> : null
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
function IssueNoteChip({ note }: { note: IssueNote }): JSX.Element {
  // `shape-own` is the one that leaves, and it takes the same arrow the
  // departure tick below the spine uses — the chip and the tick are two halves
  // of one story, so they may not be drawn with two different marks.
  const Glyph =
    note.kind === 'blocked'
      ? Ban
      : note.kind === 'waiting'
        ? ArrowDown
        : note.kind === 'shape-own'
          ? ArrowUpRight
          : CornerDownRight
  return (
    <span
      className="shell-type-micro deck-drop-relation flex max-w-[8rem] flex-none items-center gap-1 font-mono text-text-faint"
      data-testid="flight-issue-note"
      data-note={note.kind}
      title={note.full}
      role="img"
      aria-label={note.full}
    >
      <Glyph size={9} aria-hidden className="flex-none" />
      <span className="truncate">{note.short}</span>
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
      // RIGID, AND ALWAYS THE SAME WIDTH. Every strip and every agent row parks
      // its state in this one column, right-aligned, so the mission's states
      // read down the edge of the spine as a single list. It never shrinks —
      // the title does — because a half-rendered state is a wrong state.
      className="flex flex-none items-center justify-end gap-1.5"
      style={{ width: STATE_COL }}
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
function crewLine(session: SessionMeta, now: number): string {
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
function CrewCensus({ crew, now }: { crew: readonly SessionMeta[]; now: number }): JSX.Element {
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
function SeatChip({ note }: { note: PresenceNote }): JSX.Element {
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
const seatFor = (note: PresenceNote | null): PresenceNote | null =>
  note && (note.kind === 'ready' || note.kind === 'attention') ? note : null

/**
 * A session's native subagents, hung off it on their own guide.
 *
 * They are the harness's own workers, not Podium sessions — the quietest tier in
 * the spine, mono throughout, and they open the PARENT in its Native view
 * because there is no child transcript to route to.
 */
function NativeRows({
  session,
  onOpen,
}: {
  session: SessionMeta
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
            title={`Focus ${sessionDisplayName(session)} in Native · ${agent.anonymous ? 'unnamed worker' : agent.id}`}
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
            <span className="flex-none">{agent.working ? 'working' : 'waiting'}</span>
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
  peer: 'operator-added peer',
}

/** The role as the word after the name. A spawn edge is named by its PARENT —
 *  "by Spine designer" is the fact the operator can act on; the parent session
 *  id is not. An unresolvable parent gets no word rather than an id. */
function roleLabel(
  role: SessionRole | null,
  nameOf: (sessionId: string) => string | undefined,
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
 */
function RoleWord({ role, label }: { role: SessionRole; label: string }): JSX.Element {
  const lead = isLead(role)
  return (
    <span
      className={cn(
        'shell-type-micro font-mono',
        // A LEAD'S WORD NEVER TRUNCATES. It is one of exactly two strings and
        // both are short, and `COORDINAT…` is not a caption — it is a word
        // that failed. The arbitrary-length thing on this row is the NAME, so
        // the name is what gives way. Every other arm is a phrase that can lose
        // its tail and still read ("by Spine desig…"), so those still shrink,
        // and first.
        lead
          ? 'flex-none font-medium tracking-[0.1em] uppercase'
          : 'min-w-0 flex-1 shrink-[8] truncate font-normal text-text-faint',
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
function SessionRow({
  session,
  role = null,
  label = null,
  active,
  last,
  now,
  rail = HAIRLINE_RAIL,
  flat = false,
  onOpen,
  onOpenNative,
}: {
  session: SessionMeta
  role?: SessionRole | null
  /** The role as a word, already resolved (a spawn parent needs a name). */
  label?: string | null
  active: boolean
  last: boolean
  now: number
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
  const renameSession = useStoreSelector((store) => store.renameSession)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const intent = useClickIntent()
  const retired = session.archived || session.status === 'exited'
  const starting = session.status === 'starting' || session.status === 'reconnecting'
  const needs = !retired && sessionNeedsHuman(session)
  const phase = motionPhase(session)
  const since = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  const stamp = relativeTime(session.lastActiveAt, now)
  const total = session.agentState?.workingMsTotal
  const name = sessionDisplayName(session)
  const lead = isLead(role)
  const body = (
    <div
      className={cn(
        // SQUARE, AND OPEN TO THE LEFT. An agent row sits ON its parent's rail
        // rather than hanging off it as a pill: no rounded collar, because a
        // rounded edge is what makes the task strips read as units and an agent
        // is not one of those.
        'group/srow relative',
        // The mission's own lead is the one agent row in the spine with a fill.
        // It owns the whole mission, so it is allowed to be the loudest thing
        // in the roster — and being the only one, the fill means exactly that.
        role?.kind === 'coordinator' && 'deck-lead-fill',
        // Attention is an inner rule and amber type, never a wash.
        needs && 'shadow-[inset_2px_0_0_var(--attention)]',
        flat && 'rounded-md',
      )}
      style={{ marginLeft: flat ? 0 : AGENT_INDENT }}
      data-flight-session={session.sessionId}
      data-needs-you={needs ? 'true' : undefined}
    >
      {/* THE SESSION YOU ARE IN takes the same square accent tick a selected
          task takes, in the row's own gutter. Extending the mark rather than
          reaching for a fill is the whole point of the tick: "this one" is one
          device in this column, whatever kind of row it lands on. */}
      {active && !flat && (
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: AGENT_RAIL - AGENT_INDENT + TICK_SELECTED_X,
            top: HUNG_MID - TICK_HEIGHT / 2,
            width: TICK_WIDTH,
            height: TICK_HEIGHT,
            background: 'var(--issue)',
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
            // The ONLY fill an agent ever gets is transient: hover, and nothing
            // else. `px-0` on the left — the row opens onto its rail.
            'group/session shell-type-secondary flex min-h-7 w-full items-center gap-1.5 py-1 pr-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground',
            active && 'text-foreground',
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
        >
          {/* WorkerLabel already says "Handing over → <target>" mid-move, in the
              same words the sidebar and the pane header use, so the row never
              invents a second vocabulary for the same event. */}
          {/* `overflow-hidden` is the hard stop, and the shrink weights are the
              policy: WHO this is outranks WHAT it is here as. The role used to
              be `flex-none`, which cannot shrink — so on a long parent name it
              took the width it wanted, squeezed the session's own name down to
              "S." or "T…", and then ran straight under the Needs-you badge on
              the right. The name now shrinks last (weight 1) and the role first
              (weight 8), and both truncate instead of overlapping. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <WorkerLabel session={session} chip />
            {/* THE REF IS THE HANDLE (POD-758). `POD-710-B` is what the operator
                types, pastes and says out loud, and it is the one string on the
                row that is worthless partly rendered — so it never truncates
                and the NAME shrinks around it. Lifted straight off the session:
                it is the permanent birth ref, so it survives a rename. */}
            {session.displayRef && (
              <span className="shell-type-micro flex-none font-mono font-normal text-text-faint">
                {session.displayRef}
              </span>
            )}
            {/* ATTENTION OUTRANKS PROVENANCE, here as on the elbow. An asking
                row spends its width on the question and the answer; "operator-
                added peer" squeezed to "op…" beside them is noise wearing the
                shape of information. */}
            {role && label && !needs && <RoleWord role={role} label={label} />}
          </span>
          <span
            className={cn(
              'flex flex-none items-center gap-1.5',
              // Everything but the asking row parks in the shared state column.
              // "Needs you · 1:12" is the one line allowed to overrun it: it is
              // an obligation, not a status, and it earns the room.
              !needs && 'justify-end',
            )}
            style={needs ? undefined : { width: STATE_COL }}
          >
            {needs ? (
              <>
                <span
                  aria-hidden
                  className="flex size-3 flex-none items-center justify-center rounded-full bg-attention text-[8px] leading-none font-bold text-attention-foreground"
                >
                  !
                </span>
                <span className="shell-type-micro font-semibold text-attention">Needs you</span>
                {Number.isFinite(since) && (
                  <PhaseTimer phase="waiting" sinceMs={since} leadingSeparator />
                )}
              </>
            ) : retired ? (
              <span className="shell-type-micro font-mono text-text-faint">Retired · {stamp}</span>
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
        <SessionContextMenu
          session={session}
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
      // tinting the roster. An asking row overrides it — amber outranks
      // provenance, because one of them is a job for the operator.
      elbow={needs ? 'bg-attention' : lead ? rail.className : 'bg-hairline-soft'}
    >
      {body}
    </Hung>
  )
}

/** The agents on a task, hung off it. Shared by the strips and by the MISSION
 *  HEADER, which is the root of the tree and hangs its own agents the same way
 *  (round 3 §4) — one idiom, so the root reads as a node and not as a special
 *  case. The seat a task holds for the agent it does not have is NOT here any
 *  more: it is a chip on the strip itself (see `SeatChip`). */
interface HungContext {
  issue: IssueNavigationModel
  sessions: SessionMeta[]
  rootId: string | undefined
  inMission: ReadonlySet<string>
  nameOf: (sessionId: string) => string | undefined
  activeSessionId: string | null
  /** Session ids that appeared since the deck settled — see `useArrivals`. */
  arrivals: ReadonlySet<string>
  settle: (key: string) => void
  now: number
  /** The block's left inset; its hung rails sit `AGENT_RAIL` inside that. */
  inset: number
  /** The branch line this block draws — coloured when the task has a lead. */
  rail: Rail
  /** Keep the last row's rail running to the block's bottom edge, because the
   *  tree carries on below it. The root block sets this; a strip never does. */
  tail: boolean
  onSelectSession: (session: SessionMeta, permanent: boolean) => void
  onSelectNative: (session: SessionMeta) => void
}

function HungRows(ctx: HungContext): JSX.Element | null {
  const reduce = useReducedMotion()
  const { sessions } = ctx
  if (sessions.length === 0) return null
  let placed = 0
  const isLast = (): boolean => {
    placed += 1
    return !ctx.tail && placed === sessions.length
  }
  return (
    <div className="relative" style={{ marginLeft: ctx.inset }}>
      {sessions.map((session) => {
        const role = sessionRole(ctx.issue, session, {
          rootId: ctx.rootId,
          siblings: sessions,
          inMission: ctx.inMission,
        })
        const row = (
          <SessionRow
            key={session.sessionId}
            session={session}
            role={role}
            label={roleLabel(role, ctx.nameOf)}
            active={ctx.activeSessionId === session.sessionId}
            last={isLast()}
            now={ctx.now}
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
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            onAnimationComplete={() => ctx.settle(session.sessionId)}
          >
            {row}
          </motion.div>
        ) : (
          <div key={session.sessionId}>{row}</div>
        )
      })}
    </div>
  )
}

function TaskRow({
  row,
  byId,
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
  now,
  onToggle,
  onSelectIssue,
  onSelectSession,
  onSelectNative,
}: {
  row: FlightDeckRow
  byId: ReadonlyMap<string, IssueNavigationModel>
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
  mode: FlightDeckMode
  rootId: string | undefined
  inMission: ReadonlySet<string>
  nameOf: (sessionId: string) => string | undefined
  selected: boolean
  activeSessionId: string | null
  arrivals: ReadonlySet<string>
  settle: (key: string) => void
  collapsed: boolean
  now: number
  onToggle: () => void
  /** Single click previews the task's lead session (and toggles the fold);
   *  double click / Enter opens it permanently. */
  onSelectIssue: (permanent: boolean) => void
  onSelectSession: (session: SessionMeta, permanent: boolean) => void
  onSelectNative: (session: SessionMeta) => void
}): JSX.Element {
  const intent = useClickIntent()
  const payload = hasPayload(row)
  const bandLeft = SPINE_PAD + row.depth * DEPTH_STEP
  const ownRailX = SPINE_PAD + (row.depth - 1) * DEPTH_STEP + RAIL_INSET
  const state = deckIssueState(row.issue, row.sessions, byId)
  const sessions = deckSessions(row, mode)
  // A PROPOSAL IS A DIFFERENT KIND OF ROW (round 3 §7b): nobody has accepted it,
  // so it holds no seat for an agent and takes the shorter band. Only one with
  // sub-tasks reaches this component — the childless ones leave the tree
  // entirely for the Proposed tail below it.
  const proposed = row.issue.stage === 'proposed'
  const bandHeight = proposed ? PROPOSED_BAND : BAND_HEIGHT
  const mid = proposed ? PROPOSED_MID : BAND_MID
  const note = issueNote(row.issue, byId)
  // The seat is held for work that could be picked up — never under a proposal,
  // and never to restate a dependency the strip has already named above it.
  const seat = proposed ? null : seatFor(presenceNote(row.issue, row.sessions, byId))
  // A FOLDED BRANCH REPORTS LIVE STATE, not the count already in its payload
  // chip: "2 running" is the thing the fold is hiding, and `3 tasks` is printed
  // two inches to the left of it.
  const folded = collapsed && payload
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
      <div
        className={cn(
          'deck-strip group/task relative flex items-center gap-1 rounded-row border bg-tabstrip pr-1.5 transition-[border-color,min-height] duration-200 ease-out motion-reduce:transition-none',
          state.state === 'blocked' && 'deck-hatch',
          selected ? 'border-border-strong' : 'border-hairline-soft hover:border-hairline-bar',
        )}
        style={{ marginLeft: bandLeft, minHeight: bandHeight }}
      >
        {payload ? (
          <button
            data-pressable
            type="button"
            className="flex size-5 flex-none items-center justify-center text-text-dim hover:text-text-strong"
            aria-label={collapsed ? `Expand ${row.issue.title}` : `Collapse ${row.issue.title}`}
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
        <button
          data-pressable
          type="button"
          className={cn(
            // gap-1.5, not gap-2: five gaps at 8px is 40px of the row spent on
            // air, and the title is the thing that pays for it.
            'flex min-w-0 flex-1 items-center gap-1.5 text-left',
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
          <StageGlyph stage={row.issue.stage} size={13} />
          {/* THE TITLE OUTRANKS EVERYTHING ELSE IN THE ROW: it has a floor and
              it is the only thing here that shrinks. Ref THEN title, in one
              truncating label — the ref is how the operator addresses the task
              everywhere else in Podium, and a right-aligned ref made the column
              read right-to-left. */}
          <span
            className={cn(
              'shell-type-secondary min-w-0 flex-1 truncate text-text-strong',
              selected ? 'font-semibold' : 'font-medium',
            )}
          >
            <span className="shell-type-micro mr-1.5 font-mono font-normal text-text-faint">
              {issueDisplayRef(row.issue)}
            </span>
            {row.issue.title}
          </span>
          {note && <IssueNoteChip note={note} />}
          {seat && <SeatChip note={seat} />}
          {folded && <CollapsedPayload summary={row.collapsedSummary} />}
          {folded && row.collapsedSummary.crew.length > 0 && (
            <CrewCensus crew={row.collapsedSummary.crew} now={now} />
          )}
          <StateLabel value={state} label={liveWord} />
        </button>
      </div>
      {/* THE FOLD GROWS AND SHRINKS (round 3 §7c) — a grid-rows collapse that
          needs no measurement and no mount, so nothing choreographs on first
          paint: a transition only runs when a value actually changes. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <HungRows
            issue={row.issue}
            sessions={sessions}
            rootId={rootId}
            inMission={inMission}
            nameOf={nameOf}
            activeSessionId={activeSessionId}
            arrivals={arrivals}
            settle={settle}
            now={now}
            inset={bandLeft}
            rail={agentRail}
            tail={childFollows}
            onSelectSession={onSelectSession}
            onSelectNative={onSelectNative}
          />
        </div>
      </div>
    </div>
  )
}

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
function ProposalRow({
  issue,
  author,
  selected,
  onSelect,
}: {
  issue: IssueNavigationModel
  /** The display ref of the session that filed it, when the deck can resolve it. */
  author: string | null
  selected: boolean
  onSelect: (permanent: boolean) => void
}): JSX.Element {
  const intent = useClickIntent()
  return (
    <div data-flight-issue={issue.id}>
      <button
        data-pressable
        type="button"
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
        <StageGlyph stage="proposed" size={12} />
        <span className="shell-type-secondary min-w-0 flex-1 truncate text-muted-foreground">
          <span className="shell-type-micro mr-1.5 font-mono text-fuchsia-500">
            {issueDisplayRef(issue)}
          </span>
          {issue.title}
        </span>
        {author && (
          /* Never dropped: the author IS the proposal's secondary content, and
             a row with only a title tells the operator nothing to act on. */
          <span className="shell-type-micro flex-none font-mono text-fuchsia-500">by {author}</span>
        )}
      </button>
    </div>
  )
}

/**
 * A NAMED REGION BELOW THE TREE (POD-710 §4.4).
 *
 * The spine is one thing — the mission's shape — and anything that is not part
 * of that shape has to leave it rather than hang off it with a guide rail
 * borrowed from a parent it does not really have. Proposals are the first
 * tenant; departure ticks (POD-679) are the next, and they are SIBLINGS of this
 * section, not children of it.
 *
 * The heading is DESIGN.md §3's Label: 8.5px Geist Mono, 0.12em, uppercase,
 * Label Grey — the same voice as WORK and TRAY, because it is the system naming
 * a region of itself. It carries its own COUNT and its own rule rather than
 * sitting under a full-width border: a rule that starts after the word reads as
 * that word underlining a region, where a border across the column reads as the
 * spine ending. The spine has not ended — these sections are its tail.
 */
function DeckSection({
  label,
  count,
  tone,
  testId,
  children,
}: {
  label: string
  /** Printed beside the label when the region's size is the useful fact. */
  count?: number
  /** Class for the label, when the region has a hue of its own (proposals). */
  tone?: string
  testId: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mt-2.5 px-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <h3
          className={cn(
            'font-mono text-[8.5px] font-medium tracking-[0.16em] uppercase',
            tone ?? 'text-label',
          )}
        >
          {label}
        </h3>
        {count !== undefined && (
          <span className="shell-type-micro font-mono text-text-faint">{count}</span>
        )}
        <span aria-hidden className="h-px flex-1 bg-hairline-soft" />
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  )
}

/**
 * WHAT LEFT — the departure ticks under the spine (POD-679).
 *
 * Work discovered here and started as its own thing is not a member of this
 * mission any more: it holds no seat, wears no state mark, and does not move
 * the gauge. But a row that simply vanished would be a lie by omission — the
 * operator watched an agent file it here — so the mission keeps one line each,
 * and the line is a way back to it.
 *
 * Deliberately OUTSIDE the tree: no rail, no elbow, and a label above rather
 * than an indent below. A guide line running into these would say the one thing
 * this whole change exists to stop saying — that they are still in here.
 */
export function DepartureTicks({
  departures,
  onOpen,
}: {
  departures: readonly MissionDeparture[]
  onOpen: (issue: IssueNavigationModel) => void
}): JSX.Element | null {
  if (departures.length === 0) return null
  return (
    <div
      className="mt-2 border-t border-hairline-soft pt-1.5"
      style={{ marginLeft: GUTTER }}
      data-testid="flight-departures"
    >
      <div className="shell-type-micro font-mono tracking-wide text-text-faint uppercase">
        Left this mission
      </div>
      {departures.map((departure) => (
        <button
          data-pressable
          type="button"
          key={departure.issue.id}
          data-testid="flight-departure"
          data-departure-issue={departure.issue.id}
          className="shell-type-micro flex min-h-[22px] w-full items-center gap-1.5 font-mono text-text-faint hover:text-text-dim"
          title={`${issueDisplayRef(departure.issue)} runs on its own · ${departure.state.label}`}
          onClick={() => onOpen(departure.issue)}
        >
          <ArrowUpRight size={9} aria-hidden className="flex-none" />
          <span className="flex-none">{issueDisplayRef(departure.issue)}</span>
          <span className="min-w-0 flex-1 truncate text-left">{departure.issue.title}</span>
          <span className="flex-none">
            {departure.state.attention && (
              <span
                aria-hidden
                className="mr-1.5 inline-block size-[5px] rounded-full bg-attention align-middle"
              />
            )}
            {departure.state.label.toLowerCase()}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The empty deck: a canvas that fills as the conversation does, never an error
 * and never a demand for a task. A fresh Codex keeps its ordinary chat and
 * composer; this column simply shows what it has learned so far.
 */
function IntakeCanvas({
  session,
  draft,
  repoName,
}: {
  session: SessionMeta | undefined
  draft: string | undefined
  repoName: string | null
}): JSX.Element {
  const kind: AgentKind = session?.agentKind ?? 'codex'
  const fields: Array<{ label: string; value: string; loading?: boolean }> = [
    draft?.trim()
      ? { label: 'Task', value: draft.trim() }
      : { label: 'Task', value: 'Waiting for your first message', loading: true },
    { label: 'Plan', value: 'The agent will outline the work' },
    {
      label: 'Team',
      value: session ? `${sessionDisplayName(session)} · ready` : 'Agents will appear as they join',
    },
  ]
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pt-4 pr-11 pb-6 pl-4"
      data-testid="flight-intake"
    >
      <div className="shell-type-micro flex items-center gap-2 font-mono tracking-wide text-text-dim uppercase">
        <KindIcon kind={kind} chip />
        {session ? sessionDisplayName(session) : 'New session'}
      </div>
      {/* The deck's title slot, at the deck's title size — an empty column and a
          loaded one are the same column, so its one heading does not shrink
          because there is no mission in it yet. */}
      <h2 className="mt-2.5 shell-type-column-title font-semibold text-text-strong">
        Ready when you are
      </h2>
      <p className="shell-type-secondary mt-[7px] leading-[1.6] text-muted-foreground">
        The agent will organize this workspace as you talk
        {repoName ? ` in ${repoName}` : ''}.
      </p>
      <div className="mt-4">
        {fields.map((field) => (
          <div
            key={field.label}
            className="grid min-h-11 grid-cols-[46px_minmax(0,1fr)] items-center gap-2 border-t border-hairline-soft"
          >
            <span className="shell-type-micro font-mono text-text-dim">{field.label}</span>
            {/* The artifact shimmers the pending field. Stillness is the signal
                here (DESIGN.md §5) and the braille spinner means "an agent is
                computing", which nothing is yet — so a pending field simply
                reads fainter. */}
            <span
              className={cn(
                'shell-type-secondary truncate',
                field.loading ? 'text-text-faint' : 'text-text-dim',
              )}
            >
              {field.value}
            </span>
          </div>
        ))}
      </div>
      <p className="shell-type-micro mt-4 font-mono text-text-faint">
        Names and rows crossfade into place; no task is invented.
      </p>
    </div>
  )
}

export function FlightDeck({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const {
    sessions,
    repos,
    selectedIssueId,
    paneA,
    paneB,
    split,
    setSelectedWorktree,
    setSelectedIssueId,
    openSessionTab,
    setPanelMode,
    setView,
    markIssueRead,
    markSessionRead,
    drafts,
    coarseNow,
  } = useStoreSelector(
    (store) => ({
      sessions: store.sessions,
      repos: store.repos,
      selectedIssueId: store.selectedIssueId,
      paneA: store.paneA,
      paneB: store.paneB,
      split: store.split,
      setSelectedWorktree: store.setSelectedWorktree,
      // POD-679's departure ticks RE-ROOT the deck: a departed spin-off is not a
      // member of this mission any more, so focusing it would resolve to nothing.
      setSelectedIssueId: store.setSelectedIssueId,
      // The deck OPENS TABS now (POD-710 §2) rather than assigning pane A: a
      // preview open and a permanent open are different things, and only the
      // workspace layout can tell them apart. `paneA`/`paneB` below stay as the
      // derived mirrors they now are — this column still reads them to know
      // which session the operator is actually in.
      openSessionTab: store.openSessionTab,
      setPanelMode: store.setPanelMode,
      setView: store.setView,
      markIssueRead: store.markIssueRead,
      markSessionRead: store.markSessionRead,
      drafts: store.drafts,
      // The shared coarse clock, not one interval per row: the "N ago" stamp on
      // a stopped session must not disagree with the ordering derived from the
      // same clock elsewhere in the shell (sidebar-common, POD-407).
      coarseNow: store.coarseNow,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const allWorktreePaths = useMemo(
    () => reposToViews(repos).flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)),
    [repos],
  )
  const { focusedIssueId, setFocusedIssueId } = useOperatorFocus()
  // Device-local DISPLAY preference, subscribed rather than seeded (POD-540):
  // which view you left the deck in and which branches you folded survive a
  // remount. Neither ever touches issue stage or agent state.
  const [mode, setMode] = usePersistedUiState<FlightDeckMode>(
    FLIGHT_DECK_MODE_KEY,
    readMode,
    writeMode,
  )
  const [folds, setFolds] = usePersistedUiState<FoldMap>(
    FLIGHT_DECK_FOLDS_KEY,
    readFolds,
    writeFolds,
  )
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const headerIntent = useClickIntent()
  const root = missionRootFor(issues, selectedIssueId)
  const rows = useMemo(
    () => (root ? buildFlightDeckRows(issues, sessions, root.id, mode, allWorktreePaths) : []),
    [issues, sessions, root, mode, allWorktreePaths],
  )
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  /**
   * The session the operator is ACTUALLY in.
   *
   * Pane A holds a tab id, and a tab may be a file — its id is not a session
   * identity, so reading `paneA` as one highlighted nothing (or, worse, the
   * wrong thing) whenever a file was open. In split view the session being
   * worked may be the one in pane B.
   */
  const focusedSession = useMemo(() => {
    const find = (id: string | null): SessionMeta | undefined =>
      id ? sessions.find((session) => session.sessionId === id) : undefined
    return find(paneA) ?? (split ? find(paneB) : undefined)
  }, [paneA, paneB, split, sessions])
  const activeSessionId = focusedSession?.sessionId ?? null
  // Resolved against the UNFILTERED mission membership, exactly as RightDock
  // does: resolving against the mode-filtered rows let a switch to "Needs you"
  // silently move the highlight — and the Task dock with it — to the root.
  const missionMembers = useMemo(
    () => (root ? missionIssueIds(issues, root.id, sessions) : new Set<string>()),
    [issues, root, sessions],
  )
  const focused = resolveFocus(focusedIssueId, missionMembers, root?.id)
  const progress = missionProgress(issues, sessions, root?.id)
  // What this mission discovered and no longer owns. Derived beside the rows
  // from the same membership set, so a departure can never also be a strip.
  const departures = useMemo(
    () => missionDepartures(issues, sessions, root?.id, allWorktreePaths),
    [issues, sessions, root, allWorktreePaths],
  )
  const liveCount = rows[0]?.liveAgentCount ?? 0
  const workingCount = rows[0]?.workingAgentCount ?? 0
  // The Needs-you badge counts what the filter SHOWS — sessions that stopped and
  // asked, plus the tasks that are the exception themselves. Counting tasks here
  // and listing sessions there is how a badge comes to disagree with its column.
  const needsCount = rows[0]?.attentionCount ?? 0
  // Every session anywhere in the mission, so a spawn edge can be named ("by
  // Spine designer") and one pointing outside the mission is left unnamed rather
  // than rendered as a raw id.
  const missionSessionNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const row of rows) {
      for (const session of row.sessions) names.set(session.sessionId, sessionDisplayName(session))
    }
    return names
  }, [rows])
  const nameOf = useCallback(
    (sessionId: string): string | undefined => missionSessionNames.get(sessionId),
    [missionSessionNames],
  )
  /**
   * The mission's own row, which the SPINE NO LONGER PRINTS (round 3 §4).
   *
   * The header above is the root of the tree — its ref, its title, its progress
   * and, hanging directly off it, its own agents. Printing it a second time as
   * the first strip was the duplication the operator asked us to remove.
   *
   * It is therefore also unfoldable: the root's fold used to hide the entire
   * mission, and with no strip to unfold from there would be no way back. The
   * "fold every branch" control below excludes it for the same reason, and the
   * root's sessions consequently always show — which is what §4 asks for.
   *
   * ALL of them, now (POD-758). The roster used to fold its settled agents away
   * behind a count; nothing in this spine is hidden by default any more, and
   * what narrows it is the view bar — a second disclosure inside a view was
   * hiding what that view had just promised to show.
   */
  const rootRow = rows[0]
  const rootNote = root ? issueNote(root, byId) : null
  const rootSessions = useMemo(() => (rootRow ? deckSessions(rootRow, mode) : []), [rootRow, mode])
  const rootSeat = rootRow ? seatFor(presenceNote(rootRow.issue, rootRow.sessions, byId)) : null
  /**
   * PROPOSALS LEAVE THE TREE (POD-710 §4.4).
   *
   * A proposal is not part of the mission's shape — it is a thing being offered
   * to the operator — so it is partitioned out here and rendered in its own
   * section, with no rail, no elbow and no indent. Partitioned in this file on
   * purpose: `mission.ts` still owns the mission's shape, and this is a display
   * decision about it.
   *
   * A proposal that has somehow acquired sub-tasks stays IN the tree: pulling it
   * out would leave its children hanging off a parent that is no longer there,
   * which is worse than a proposal in the spine.
   */
  const proposalIds = useMemo(
    () =>
      new Set(
        rows
          .filter(
            (row) =>
              row.depth > 0 && row.issue.stage === 'proposed' && row.descendantIds.length === 0,
          )
          .map((row) => row.issue.id),
      ),
    [rows],
  )
  // Search keeps a match's ANCESTORS as context, the same rule the mode filters
  // follow — an exception that loses its path is an exception you cannot place.
  const visibleRows = useMemo(() => {
    const tree = rows.filter((row) => !proposalIds.has(row.issue.id))
    const hiddenByAncestor = new Set<string>()
    for (const row of tree) {
      if (row.depth === 0 || !isFolded(row, folds)) continue
      for (const id of row.descendantIds) hiddenByAncestor.add(id)
    }
    const unfolded = tree.filter((row) => row.depth > 0 && !hiddenByAncestor.has(row.issue.id))
    const needle = query.trim().toLowerCase()
    if (!needle) return unfolded
    const keep = new Set<string>()
    const trail: FlightDeckRow[] = []
    for (const row of unfolded) {
      trail.length = row.depth
      trail[row.depth] = row
      if (matchesQuery(row, needle))
        for (const ancestor of trail) if (ancestor) keep.add(ancestor.issue.id)
    }
    return unfolded.filter((row) => keep.has(row.issue.id))
  }, [rows, proposalIds, folds, query])
  /** The proposals themselves. The tree's folds do not govern them — they are
   *  not in the tree — so only the search narrows them. */
  const proposedRows = useMemo(() => {
    const proposals = rows.filter((row) => proposalIds.has(row.issue.id))
    const needle = query.trim().toLowerCase()
    return needle ? proposals.filter((row) => matchesQuery(row, needle)) : proposals
  }, [rows, proposalIds, query])
  // Computed over the rows that ACTUALLY render: a fold or a filter changes which
  // strip is the last child of its branch, and a rail that outlives its last
  // child is the tell that the tree was drawn from data rather than from layout.
  const guides = useMemo(() => treeGuides(visibleRows), [visibleRows])
  /**
   * THE TASKS THAT HAVE A LEAD — the set the coloured rails are drawn from.
   *
   * A designated coordinator whose session has exited is not leading anything,
   * so the predicate is over LIVE sessions: a rail that stayed lit after its
   * lead went home would be the deck asserting somebody is driving when nobody
   * is, which is the one thing this device must never do.
   */
  const ledIssueIds = useMemo(() => {
    const led = new Set<string>()
    for (const row of rows) {
      const hasLead = row.sessions.some(
        (session) =>
          !session.archived &&
          session.status !== 'exited' &&
          isCoordinatorSession(row.issue, session.sessionId),
      )
      if (hasLead) led.add(row.issue.id)
    }
    return led
  }, [rows])
  const leadTone = useCallback(
    (issueId: string | undefined): RailTone =>
      issueId === undefined || !ledIssueIds.has(issueId)
        ? null
        : issueId === root?.id
          ? 'mission'
          : 'task',
    [ledIssueIds, root],
  )
  /**
   * WHICH TASK OWNS THE RAIL AT EACH LEVEL of each rendered row.
   *
   * The rail at level L descends from the node at depth L-1 — level 1 from the
   * mission root, level 2 from the depth-1 ancestor — so colouring a lead's
   * branch means knowing each row's ancestry, which the flat row list does not
   * carry. Rebuilt here from depth alone, over the rows that actually render,
   * for the same reason `treeGuides` is: a filtered spine has a different tree.
   */
  const rails = useMemo(() => {
    const trail: (string | undefined)[] = [root?.id]
    return visibleRows.map((row) => {
      trail.length = row.depth
      trail[row.depth] = row.issue.id
      const tones: RailTone[] = []
      for (let level = 1; level <= row.depth; level += 1) tones.push(leadTone(trail[level - 1]))
      return tones
    })
  }, [visibleRows, root, leadTone])
  /** A proposal names the session that filed it, because the ref is how you go
   *  and ask it why. Unresolvable (a human create, or an agent long gone) means
   *  no author line rather than a raw session id. */
  const authorOf = useCallback(
    (issue: IssueNavigationModel): string | null => {
      const id = issue.startedBySession
      if (!id) return null
      return sessions.find((session) => session.sessionId === id)?.displayRef?.trim() || null
    },
    [sessions],
  )
  /**
   * THE ARCHIVED SESSIONS OF THIS MISSION (POD-710 §4.3).
   *
   * The tab strip used to hold this reveal, because tabs were where sessions
   * lived; they are views now, so it comes here with the rest of session
   * lifecycle. Archived sessions are absent from `rows` by construction
   * (`sessionsForIssueNav` drops them), so they are gathered per mission issue
   * and de-duplicated — one session may be a member of two.
   */
  const archivedSessions = useMemo(() => {
    const seen = new Set<string>()
    const found: SessionMeta[] = []
    for (const row of rows) {
      for (const session of archivedSessionsForIssue(row.issue, sessions, allWorktreePaths)) {
        if (seen.has(session.sessionId)) continue
        seen.add(session.sessionId)
        found.push(session)
      }
    }
    return found
  }, [rows, sessions, allWorktreePaths])
  const [archivedOpen, setArchivedOpen] = useState(false)
  const missionSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows) for (const session of row.sessions) ids.add(session.sessionId)
    return ids
  }, [rows])
  const rootSession = root ? rows[0]?.sessions[0] : focusedSession
  const draftFilling = Boolean(root?.draft && rootSession)
  const repoName = useMemo(() => reposToViews(repos)[0]?.name ?? null, [repos])
  // The root is never in the fold set — see `rootRow`. Neither are proposals:
  // they left the tree, and "fold every branch" is about the tree.
  const foldable = useMemo(
    () => rows.filter((row) => row.depth > 0 && !proposalIds.has(row.issue.id) && hasPayload(row)),
    [rows, proposalIds],
  )
  const anyFoldable = foldable.length > 0
  const allFolded = anyFoldable && foldable.every((row) => isFolded(row, folds))
  /**
   * Session ids that appeared since the deck settled (round 3 §7c).
   *
   * Keyed over the WHOLE mission rather than per row, so a session that moves
   * from one task to another does not read as an arrival on the new one, and so
   * a fold or a filter cannot manufacture entrances. The first render seeds the
   * latch, which is why opening the workspace is still.
   */
  const sessionKeys = useMemo(
    () => rows.flatMap((row) => row.sessions.map((session) => session.sessionId)),
    [rows],
  )
  const { arrivals, settle } = useArrivals(sessionKeys)

  /** A fold the operator performed is always written EXPLICITLY, whichever way
   *  it went — that is what stops the default rule from re-closing a branch the
   *  operator just opened. */
  const setFold = useCallback(
    (id: string, closed: boolean): void => {
      const next = new Map(folds)
      next.set(id, closed ? 'closed' : 'open')
      setFolds(next)
    },
    [folds, setFolds],
  )
  const toggleFold = useCallback(
    (row: FoldableRow): void => setFold(row.issue.id, !isFolded(row, folds)),
    [folds, setFold],
  )

  const selectIssue = (row: FlightDeckRow, permanent: boolean): void => {
    setFocusedIssueId(row.issue.id)
    void markIssueRead(row.issue.id)
    if (row.issue.worktreePath) setSelectedWorktree(row.issue.worktreePath)
    const active = row.sessions.filter(
      (session) => !session.archived && session.status !== 'exited',
    )
    // Contract order: coordinator → lone member → most recently active member →
    // no-session state. The pane you happen to be looking at is NOT a
    // preference — it made clicking one task open a different task's session.
    const target =
      active.find((session) => session.sessionId === row.issue.coordinatorSessionId) ??
      (active.length === 1 ? active[0] : undefined) ??
      [...active].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    // A sessionless task updates the inspector but leaves the current chat
    // intact. Task creation is never a navigation side effect.
    if (target) {
      openSessionTab(target.sessionId, { permanent })
      void markSessionRead(target.sessionId)
    }
    setView('workspace')
  }
  /**
   * A departure tick is a way BACK to the work, so it re-roots the deck onto it
   * rather than focusing something this mission no longer contains. Selecting
   * an issue outside `missionMembers` would leave the focus resolver with
   * nothing to resolve and the column showing the same spine.
   *
   * Its tab opens PERMANENT, not as a preview (POD-710): re-rooting the whole
   * deck onto another mission is a deliberate departure from this one, not the
   * glance a preview tab exists to serve.
   */
  const openDeparture = (issue: IssueNavigationModel): void => {
    setSelectedIssueId(issue.id)
    setFocusedIssueId(issue.id)
    void markIssueRead(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    const live = sessions
      .filter(
        (session) =>
          session.issueId === issue.id && !session.archived && session.status !== 'exited',
      )
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    if (live) {
      openSessionTab(live.sessionId, { permanent: true })
      void markSessionRead(live.sessionId)
    }
    setView('workspace')
  }
  const selectSession = (
    issueId: string | null,
    session: SessionMeta,
    opts: { permanent: boolean; native?: boolean },
  ): void => {
    if (issueId) setFocusedIssueId(issueId)
    if (session.cwd) setSelectedWorktree(session.cwd)
    openSessionTab(session.sessionId, { permanent: opts.permanent })
    if (opts.native) setPanelMode(session.sessionId, 'native')
    if (issueId) void markIssueRead(issueId)
    void markSessionRead(session.sessionId)
    setView('workspace')
  }

  return (
    <aside className="engraved-column relative" aria-label="Flight Deck">
      <Button
        variant="ghost"
        size="icon-sm"
        // Centred in the 32px eyebrow row below, which is the row the artifact
        // puts it in: the chevron is part of the header's line, not a control
        // floating over the corner of the column.
        className="absolute top-1 right-2 z-20 size-6 text-text-faint"
        aria-label="Collapse Flight Deck"
        title="Collapse Flight Deck"
        onClick={onCollapse}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </Button>

      {root ? (
        <>
          {/* THE MISSION HEADER IS THE ROOT OF THE TREE (round 3 §2, §4, §10).
              Roomy because it is read once where the strips below are scanned.
              It carries NO fill of its own any more (POD-725): the column ITSELF
              now runs the mission's colour, from the 3px inset along its top
              edge down through a tint that flattens into the card tone over
              240px, so a tinted slab here would only tint the tint. What is left
              is the geometry the artifact measures — a 32px eyebrow row, then
              the title block — and the seam under it belongs to the view bar's
              own top rule rather than to a border here.
              The `1 / 16` that used to sit after the title is gone (§10) — the
              gauge below says it in words. */}
          <div className="relative flex-none">
            <div className="shell-type-micro flex h-8 items-center gap-1.5 px-4 pr-11 font-mono text-text-dim">
              <StageGlyph stage={root.stage} size={12} />
              <span>{issueDisplayRef(root)}</span>
              <span>{STAGE_LABELS[root.stage].toLowerCase()}</span>
              {/* The mission's own dependency or provenance, and the seat it is
                  holding if nobody is on it — in the same chips a strip wears.
                  The header IS a node, so it says what a node says, in the same
                  slot: a strip carries these on its right, and so does this. */}
              {(rootNote || rootSeat) && (
                <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">
                  {rootNote && <IssueNoteChip note={rootNote} />}
                  {rootSeat && <SeatChip note={rootSeat} />}
                </span>
              )}
            </div>
            <div className="px-4 pt-1 pb-3">
              <button
                data-pressable
                type="button"
                className="block w-full min-w-0 text-left"
                // The header IS the root's strip (round 3 §4), so it takes the
                // strips' gesture: preview once, promote twice.
                onClick={() =>
                  rootRow &&
                  headerIntent.press(
                    () => selectIssue(rootRow, false),
                    () => selectIssue(rootRow, true),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !rootRow) return
                  event.preventDefault()
                  headerIntent.commit(() => selectIssue(rootRow, true))
                }}
                title={`Focus ${issueDisplayRef(root)}`}
              >
                {/* The one title in the column, and the only place in the shell
                    that outgrows the `reading` role: everything under it is a
                    scanned list, so the mission's name is allowed to be read
                    from across the desk. 17px is the artifact's own measure. */}
                <h2 className="shell-type-column-title font-semibold text-text-strong">
                  {draftFilling ? sessionDisplayName(rootSession as SessionMeta) : root.title}
                </h2>
              </button>
              <p className="shell-type-secondary mt-[7px] line-clamp-4 leading-[1.6] text-muted-foreground">
                {draftFilling
                  ? drafts[rootSession?.sessionId ?? '']
                    ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
                    : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
                  : root.description?.trim() ||
                    root.activityNotes?.trim() ||
                    'Mission work, agents, and dependencies in one live execution view.'}
              </p>
              <MissionGauge progress={progress} live={liveCount} working={workingCount} />
            </div>
            {/* THE DESCENT. The spine leaves the header on the mission's own
                rail and is picked up, unbroken, by the view bar and then by the
                root's agents — whose rail IS this one (see ROOT_BLOCK_INSET). */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-0 h-4 w-px bg-hairline-soft"
              style={{ left: ROOT_RAIL }}
            />
          </div>
          {/* Rules TOP AND BOTTOM, both in the soft tier: the bar is a band cut
              through the column, and its top rule is the seam the header no
              longer draws for itself. */}
          <div
            className="relative flex h-8 flex-none items-center gap-1 border-y border-hairline-soft pr-3"
            style={{ paddingLeft: GUTTER }}
          >
            {/* The view bar sits in the spine's gutter rather than across it: its
                controls start where a depth-1 strip starts, and the rail runs
                behind them from the header to the tree. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-hairline-soft"
              style={{ left: ROOT_RAIL }}
            />
            {MODES.map((option) => (
              <button
                data-pressable
                type="button"
                key={option.id}
                aria-pressed={mode === option.id}
                // THE ACTIVE VIEW IS UNDERLINED IN THE MISSION'S OWN COLOUR, and
                // the underline runs the bar's full height rather than a pill's.
                // A filled pill here read as one more raised object competing
                // with the strips below it; an inset floor rule is the same
                // device the selected strip wears on its left edge, turned
                // through ninety degrees, so both say "this one" in one voice.
                className={cn(
                  'shell-type-micro inline-flex items-center gap-1 self-stretch px-2 font-medium text-text-faint hover:text-text-strong',
                  mode === option.id && 'text-text-strong shadow-[inset_0_-2px_0_var(--issue)]',
                )}
                onClick={() => setMode(option.id)}
              >
                {option.label}
                {option.id === 'needs-you' && needsCount > 0 && (
                  <span className="font-mono font-semibold text-attention">{needsCount}</span>
                )}
              </button>
            ))}
            <div className="ml-auto flex flex-none items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-text-faint"
                aria-pressed={searchOpen}
                title="Search this mission"
                onClick={() => {
                  setSearchOpen((open) => !open)
                  if (searchOpen) setQuery('')
                }}
              >
                <Search size={13} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-text-faint"
                title={allFolded ? 'Expand every branch' : 'Fold every branch'}
                disabled={!anyFoldable}
                // Both directions write EXPLICIT values for every foldable
                // branch: "expand everything" that merely cleared the map would
                // leave the one-session tasks closed by the default rule, which
                // is not what the control says.
                onClick={() =>
                  setFolds(
                    new Map(
                      foldable.map((row): [string, FoldState] => [
                        row.issue.id,
                        allFolded ? 'open' : 'closed',
                      ]),
                    ),
                  )
                }
              >
                {allFolded ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              </Button>
            </div>
          </div>
          {searchOpen && (
            <div
              className="relative flex h-8 flex-none items-center gap-2 border-b border-hairline-soft pr-3"
              style={{ paddingLeft: GUTTER }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-hairline-soft"
                style={{ left: ROOT_RAIL }}
              />
              <Search size={13} aria-hidden="true" className="flex-none text-text-faint" />
              <input
                // biome-ignore lint/a11y/noAutofocus: the field exists only while searching
                autoFocus
                type="text"
                value={query}
                placeholder="Task, session, agent or ref"
                aria-label="Search this mission"
                className="shell-type-secondary min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-text-faint"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  setQuery('')
                  setSearchOpen(false)
                }}
              />
              {query && (
                <button
                  data-pressable
                  type="button"
                  className="flex-none text-text-faint hover:text-text-strong"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )}
          {/* Each task block owns a small trailing gap. Because the guide rails
              cross the whole block, the spacing separates issue groups without
              breaking the tree into disconnected fragments. */}
          <div
            className="min-h-0 flex-1 overflow-y-auto pb-1.5 pr-2"
            data-testid="flight-deck-rows"
          >
            {/* The rail crosses the list's own top padding, so the header's
                descent meets the first thing under it without a six-pixel gap. */}
            <div className="relative h-1.5">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-hairline-soft"
                style={{ left: ROOT_RAIL }}
              />
            </div>
            {/* THE MISSION'S OWN AGENTS, hanging off the header (round 3 §4).
                Not a strip — the header above IS their task. Their rail lands on
                ROOT_RAIL exactly, so the header's descent runs through their
                elbows and carries on into the first child below. */}
            {rootRow && (
              <>
                <HungRows
                  issue={rootRow.issue}
                  sessions={rootSessions}
                  rootId={root.id}
                  inMission={missionSessionIds}
                  nameOf={nameOf}
                  activeSessionId={activeSessionId}
                  arrivals={arrivals}
                  settle={settle}
                  now={coarseNow}
                  inset={ROOT_BLOCK_INSET}
                  rail={railFor(leadTone(root.id))}
                  tail={visibleRows.length > 0}
                  onSelectSession={(session, permanent) =>
                    selectSession(rootRow.issue.id, session, { permanent })
                  }
                  onSelectNative={(session) =>
                    selectSession(rootRow.issue.id, session, { permanent: false, native: true })
                  }
                />
                {rootSessions.length > 0 && visibleRows.length > 0 && (
                  <div className="relative h-2" aria-hidden>
                    <span
                      className={cn(
                        'pointer-events-none absolute inset-y-0',
                        railFor(leadTone(root.id)).className,
                      )}
                      style={{ left: ROOT_RAIL, width: railFor(leadTone(root.id)).width }}
                    />
                  </div>
                )}
              </>
            )}
            {visibleRows.map((row, index) => (
              <TaskRow
                key={row.issue.id}
                row={row}
                byId={byId}
                carries={guides[index] ?? []}
                rails={rails[index] ?? []}
                agentRail={railFor(leadTone(row.issue.id))}
                childFollows={(visibleRows[index + 1]?.depth ?? 0) > row.depth}
                mode={mode}
                rootId={root.id}
                inMission={missionSessionIds}
                nameOf={nameOf}
                selected={focused === row.issue.id}
                activeSessionId={activeSessionId}
                arrivals={arrivals}
                settle={settle}
                collapsed={isFolded(row, folds)}
                now={coarseNow}
                onToggle={() => toggleFold(row)}
                // A single click on a task BOTH folds it and previews its lead
                // session; the double click promotes and leaves the fold where
                // it was, so promoting never costs you the branch you opened.
                onSelectIssue={(permanent) => {
                  if (!permanent && hasPayload(row)) toggleFold(row)
                  selectIssue(row, permanent)
                }}
                onSelectSession={(session, permanent) =>
                  selectSession(row.issue.id, session, { permanent })
                }
                onSelectNative={(session) =>
                  selectSession(row.issue.id, session, { permanent: false, native: true })
                }
              />
            ))}
            {visibleRows.length === 0 && proposedRows.length === 0 && (
              <p className="shell-type-secondary px-4 py-6 text-text-dim">
                {query
                  ? 'Nothing in this mission matches that.'
                  : rootRow && rootRow.sessions.length > 0
                    ? 'No sub-tasks yet — this mission is the whole of it.'
                    : 'Nothing here in this view.'}
              </p>
            )}
            {/* THE SECTIONS BELOW THE TREE. Siblings, in a flat stack, so the
                next one (POD-679's departure ticks) sits here beside these two
                rather than being threaded through the spine. */}
            {/* PROPOSALS SINK. They leave the sibling order and collect in a
                tail at the bottom of the spine, under a divider carrying their
                count — work being offered to the operator is not part of the
                mission's shape, and interleaving it with the shape is what made
                a proposal read as a task somebody had started. */}
            {proposedRows.length > 0 && (
              <DeckSection
                label="Proposed"
                count={proposedRows.length}
                tone="text-fuchsia-500"
                testId="flight-proposed"
              >
                <div className="flex flex-col gap-1">
                  {proposedRows.map((row) => (
                    <ProposalRow
                      key={row.issue.id}
                      issue={row.issue}
                      author={authorOf(row.issue)}
                      selected={focused === row.issue.id}
                      onSelect={(permanent) => selectIssue(row, permanent)}
                    />
                  ))}
                </div>
              </DeckSection>
            )}
            {/* No count on this divider: the disclosure under it already carries
                one, and a region that states its size twice reads as two
                different numbers that happen to agree. */}
            {archivedSessions.length > 0 && (
              <DeckSection label="Archived" testId="flight-archived">
                <button
                  data-pressable
                  type="button"
                  data-testid="flight-archived-toggle"
                  aria-expanded={archivedOpen}
                  className="shell-type-micro flex min-h-6 w-full items-center gap-1.5 rounded-md text-left font-mono text-text-faint hover:text-text-dim"
                  onClick={() => setArchivedOpen((open) => !open)}
                >
                  <Archive size={11} aria-hidden className="flex-none" />
                  <span className="truncate">
                    {archivedOpen
                      ? 'Hide archived'
                      : `${archivedSessions.length} archived session${
                          archivedSessions.length === 1 ? '' : 's'
                        }`}
                  </span>
                </button>
                {archivedOpen && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {archivedSessions.map((session) => (
                      <SessionRow
                        key={session.sessionId}
                        session={session}
                        active={activeSessionId === session.sessionId}
                        last
                        flat
                        now={coarseNow}
                        onOpen={(permanent) =>
                          selectSession(session.issueId ?? null, session, { permanent })
                        }
                        onOpenNative={() =>
                          selectSession(session.issueId ?? null, session, {
                            permanent: false,
                            native: true,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </DeckSection>
            )}
            {/* POD-679's departures, the third sibling section — and deliberately
                NOT folded into PROPOSED ACTIONS above. A proposal is work nobody
                has triaged yet; a departure is work that is already gone. Same
                place on the screen, opposite meanings, so they stay two lists.
                Not filtered by the mode or the search either: a departure is a
                fact about this mission rather than a task in it, and the view
                controls narrow the spine. */}
            <DepartureTicks departures={departures} onOpen={openDeparture} />
          </div>
        </>
      ) : (
        <IntakeCanvas
          session={focusedSession}
          draft={focusedSession ? drafts[focusedSession.sessionId] : undefined}
          repoName={repoName}
        />
      )}
    </aside>
  )
}
