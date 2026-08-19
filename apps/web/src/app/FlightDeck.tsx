import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  archivedSessionsForIssue,
  buildFlightDeckRows,
  continuationPresenceLine as sharedContinuationPresenceLine,
  type CollapsedSummary,
  type DeckIssueState,
  type DeckState,
  deckIssueState,
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
  issueContinuation,
  issueNote,
  issueOwnContentUnread,
  type MissionDeparture,
  machineViewsFromWire,
  missionDepartures,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  motionPhase,
  nativeSubagentRows,
  type PresenceNote,
  presenceNote,
  reposToViews,
  readFlightDeckFolds,
  reuseFlightDeckRows,
  type SessionRole,
  selectedMissionRoot,
  sessionAsksOnIssue,
  sessionNeedsHuman,
  sessionRole,
  sessionSettled,
  sessionUnreadEmphasized,
  subtreeUnread,
  treeGuides,
  writeFlightDeckFolds,
} from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model'
import type { IssueId, MachineId, SessionId, SessionMeta } from '@podium/model/browser'
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
  Search,
  UserPlus,
  X,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { GhostBar, GhostDot, GhostPreview, GhostSquare } from '@/components/GhostPreview'
import { UnreadDot } from '@/components/UnreadMark'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
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
import { PhaseTimer, useArrivals, WorkingMark } from '@/lib/motion'
import { SessionContextMenu } from '@/lib/SessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { useClickIntent } from './click-intent'
import { MissionGauge } from './MissionGauge'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useSessionHovered } from './session-hover'
import { OPEN_RIGHT_PANEL_EVENT, REVEAL_IN_DECK_EVENT } from './shell-state'
import { useReplicaIssues, useSessionDraft, useStoreSelector } from './store'

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full spine' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

/**
 * `Add agent` — one more agent onto the mission root.
 *
 * IT REFUSES WHAT IT CANNOT RUN (POD-1201). This menu listed every harness the
 * build knows about, so on a host with no Cursor installed `Add Cursor` looked
 * exactly as startable as `Add Claude Code` and produced a session that died on
 * a missing binary. The reading and the words come from `lib/agent-capability`,
 * shared with the tab strip's "+" and the sidebar's spawn menu.
 *
 * WHICH HOSTS COUNT: the issue's own, and only those. An issue that pins a
 * `machineId` runs its agents there — the harness being installed somewhere else
 * in the fleet is not an answer — and an unpinned one can land on any host
 * holding its repo, which is the same set `addSession`/`start` will choose from.
 */
function MissionAgentMenu({
  defaultAgent,
  repoPath,
  machineId,
  onAdd,
}: {
  defaultAgent: string
  repoPath: string
  /** Set = this issue's agents run on that host, so it is the only candidate. */
  machineId?: MachineId | null
  onAdd: (agentKind?: IssueAgentKind) => Promise<unknown>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const { repos, machines } = useStoreSelector(
    (s) => ({ repos: s.repos, machines: s.machines }),
    shallowEqual,
  )
  const options = issueAgentOptions(defaultAgent)
  /** The hosts this issue's agents could land on. Empty = unknowable (no machines
   *  recorded for the repo), which stays offered rather than guessing. */
  const hosts = useMemo(() => {
    const views = machineViewsFromWire(machines)
    if (machineId) return views.filter((view) => view.machine.id === machineId)
    const repo = reposToViews(repos).find((r) => r.path === repoPath)
    const ids = new Set((repo?.machines ?? []).map((m) => m.machineId))
    return views.filter((view) => ids.has(view.machine.id))
  }, [machines, machineId, repos, repoPath])
  const statusFor = (kind: IssueAgentKind, label: string): AgentRowStatus =>
    hosts.length === 0
      ? {}
      : agentFleetStatus(
          hosts.map((view) => candidateFromAvailability(view.machine, view.availability, kind)),
          label,
        )
  const add = (agentKind: string): void => {
    setBusy(true)
    void onAdd((agentKind || undefined) as IssueAgentKind | undefined)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Could not add agent'),
      )
      .finally(() => setBusy(false))
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[26px] flex-none gap-1.5 px-2.5"
            disabled={busy}
            aria-label="Add agent to mission"
          >
            <UserPlus size={13} aria-hidden="true" />
            {busy ? 'Adding…' : 'Add agent'}
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        }
      />
      {/* 224px, not the 192 it had: a row now carries a trailing `not installed`
          beside its label, and at w-48 the widest label truncated to "Add Cur…"
          — the row would have been refusing a click while hiding WHICH harness
          it was refusing (POD-1201). */}
      <DropdownMenuContent align="end" className="w-56">
        {options.map((option) => (
          <CapabilityAgentItem
            key={option.value || 'default'}
            icon={option.icon}
            label={`Add ${option.label}`}
            // The agent name for the refusal comes from `option.label`, not from
            // the row's copy: "Add Claude Code (default) is not installed" is not
            // a sentence.
            status={statusFor(
              option.value
                ? issueDefaultAgentKind(option.value)
                : issueDefaultAgentKind(defaultAgent),
              option.label,
            )}
            onSelect={() => add(option.value)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
 * `ownX` at depth 1). The root's own agent rows line up on it too, so the
 * mission's agents and its first child task hang on ONE line instead of the
 * mission being repeated as a strip above them (round 3 §4).
 *
 * NOTHING ABOVE THE LIST DRAWS HERE (POD-1306). It is also the header's own
 * padding, so a segment at this x in the header lands under the title rather
 * than beside it — see the note over `spineSegment`.
 */
const ROOT_RAIL = SPINE_PAD + RAIL_INSET
/**
 * The root block's inset, chosen so the root's sessions hang on ROOT_RAIL
 * EXACTLY: the list's top pad is not merely near their rail, it IS their rail,
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
const STATE_COL = 'deck-state-col'

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

const MISSION_RAIL: Rail = { className: 'deck-rail-mission', width: 2 }
const TASK_RAIL: Rail = { className: 'deck-rail-task', width: 2 }
const railFor = (tone: RailTone): Rail =>
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
export type FoldState = FlightDeckFoldState
export type FoldMap = FlightDeckFoldMap
export const readFolds = readFlightDeckFolds
export const writeFolds = writeFlightDeckFolds
type FoldableRow = Pick<FlightDeckRow, 'issue' | 'descendantIds' | 'sessions'>

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
  byId: ReadonlyMap<string, { updatedAt: string }>,
): boolean {
  if (row.workingAgentCount > 0) return false
  if (!collapsed) return issueOwnContentUnread(row.issue)
  return subtreeUnread({
    readAt: row.issue.readAt,
    updatedAt: row.issue.updatedAt,
    descendantUpdatedAts: row.descendantIds.flatMap((id) => {
      const child = byId.get(id)
      return child ? [child.updatedAt] : []
    }),
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
function IssueNoteChip({ note }: { note: IssueNote }): JSX.Element {
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
function CrewCensus({ crew }: { crew: readonly SessionMeta[] }): JSX.Element {
  const now = useStoreSelector((store) => store.coarseNow)
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
 * the spine, mono throughout, and they open the PARENT in its CLI view
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
function roleLabel(
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
        'deck-agent-role flex-none font-mono text-[9px] leading-none tracking-[0.14em] uppercase',
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
function SessionRow({
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
  session: SessionMeta
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
  const renameSession = useStoreSelector((store) => store.renameSession)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const intent = useClickIntent()
  const retired = session.archived || session.status === 'exited'
  const starting = session.status === 'starting' || session.status === 'reconnecting'
  const needs =
    !retired && (issue ? sessionAsksOnIssue(issue, session) : sessionNeedsHuman(session))
  const phase = motionPhase(session)
  const since = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  const now = useStoreSelector((store) => store.coarseNow)
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
        // The mission's own lead is the one agent row in the spine with a fill.
        // It owns the whole mission, so it is allowed to be the loudest thing
        // in the roster — and being the only one, the fill means exactly that.
        role?.kind === 'coordinator' && 'deck-lead-fill',
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
          A row the pointer is on FROM THE TAB STRIP takes the same tick held
          lightly — the rail's own 45% (`.deck-rail-mission`), which is the dose
          this column already uses for "traceable, not a selection". One device
          at two strengths: the strong one is where you ARE, the faint one is
          where you are POINTING, and a pointed row that is also the active one
          simply keeps the strong mark. */}
      {(active || pointed) && !flat && (
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: AGENT_RAIL - AGENT_INDENT + TICK_SELECTED_X,
            top: HUNG_MID - TICK_HEIGHT / 2,
            width: TICK_WIDTH,
            height: TICK_HEIGHT,
            background: 'var(--issue)',
            opacity: active ? 1 : 0.45,
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
            // The ONLY fill an agent ever gets is transient: hover, and nothing
            // else. No left padding — the row opens onto its rail.
            'deck-agent group/session shell-type-secondary grid min-h-7 w-full items-center gap-x-1.5 py-1 pr-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground',
            active && 'text-foreground',
            // The pointer is on the tab, so the row takes the fill it would
            // have taken under the pointer itself. Borrowing the row's OWN
            // hover rather than inventing a second wash is what keeps this
            // legible without being loud: the strip is simply reaching in and
            // hovering the row on the operator's behalf.
            pointed && 'bg-muted text-foreground',
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
          <span className="deck-agent-ref shell-type-micro flex-none text-right font-mono font-normal whitespace-nowrap text-text-faint">
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
      // tinting the roster. It carries provenance and nothing else now
      // (POD-1226): the ask has its own tick on the far side of the rail, so
      // there is no longer a claim here for amber to outrank.
      elbow={lead ? rail.className : 'bg-hairline-soft'}
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
            issue={ctx.issue}
            role={role}
            label={roleLabel(role, ctx.nameOf)}
            active={ctx.activeSessionId === session.sessionId}
            last={isLast()}
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
          <div key={session.sessionId}>{row}</div>
        )
      })}
    </div>
  )
}

const TaskRow = memo(
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
    onToggle,
    onSelectIssue,
    onSelectSession,
    onSelectNative,
    onMenu,
    onRenameIssue,
    onStatusPick,
    renaming,
    onRenameDone,
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
    onSelectSession: (session: SessionMeta, permanent: boolean) => void
    onSelectNative: (session: SessionMeta) => void
    /** Open the shared task menu at the cursor — right-click, or the ⋯ reveal. */
    onMenu: (event: ReactMouseEvent) => void
    /** The strip's status glyph is a picker (POD-1271) — the deck applies it. */
    onStatusPick: (value: string) => void
    /** Rename this task's title (POD-1077). Already trimmed and known-changed —
     *  the commit policy lives in the deck, next to the state that opens the
     *  editor, so the row has no rename decision of its own to get wrong. */
    onRenameIssue: (title: string) => void
    /** True while the deck's menu has this row's editor open. Rename state is
     *  the DECK's (one id), not the row's: the menu that starts a rename is
     *  mounted once for the whole column and cannot reach into a row's hook. */
    renaming: boolean
    /** Commit or cancel — either way the deck clears `renamingIssueId`. */
    onRenameDone: () => void
  }): JSX.Element {
    const intent = useClickIntent()
    const payload = hasPayload(row)
    const bandLeft = SPINE_PAD + row.depth * DEPTH_STEP
    const ownRailX = SPINE_PAD + (row.depth - 1) * DEPTH_STEP + RAIL_INSET
    const state = deckIssueState(row.issue, row.sessions, byId)
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
     * compete with it. `Active` is left alone — everything it keeps is live work
     * the operator is meant to read.
     */
    const context = mode === 'needs-you' && !row.matched
    // A PROPOSAL IS A DIFFERENT KIND OF ROW (round 3 §7b): nobody has accepted it,
    // so it holds no seat for an agent and takes the shorter band. Only one with
    // sub-tasks reaches this component — the childless ones leave the tree
    // entirely for the Proposed tail below it.
    const proposed = row.issue.stage === 'proposed'
    const bandHeight = proposed ? PROPOSED_BAND : BAND_HEIGHT
    const mid = proposed ? PROPOSED_MID : BAND_MID
    const note = issueNote(row.issue, byId, row.sessions)
    // The seat is held for work that could be picked up — never under a proposal,
    // and never to restate a dependency the strip has already named above it.
    const seat = proposed ? null : seatFor(presenceNote(row.issue, row.sessions, byId))
    // A FOLDED BRANCH REPORTS LIVE STATE, not the count already in its payload
    // chip: "2 running" is the thing the fold is hiding, and `3 tasks` is printed
    // two inches to the left of it.
    const folded = collapsed && payload
    const unread = deckTaskUnread(row, collapsed, byId)
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
          {/* RENAMING IN PLACE (POD-1077). The deck could not rename a task at
            all — it mounted the shared menu without `onRename`, which gates the
            entry — so the column the operator works in was the one column that
            could not fix a title. Same hook and same editor the sidebar row and
            the session row above already use. */}
          {renaming ? (
            <span className={cn('flex min-w-0 flex-1 items-center', proposed ? 'py-0.5' : 'py-1')}>
              <SessionNameEditor
                value={row.issue.title}
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
                  {row.issue.title}
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
              aria-label={`Task actions for ${row.issue.title}`}
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
            <HungRows
              issue={row.issue}
              sessions={sessions}
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
            />
          </div>
        </div>
      </div>
    )
  },
  (previous, next) =>
    previous.row === next.row &&
    previous.byId === next.byId &&
    previous.carries === next.carries &&
    previous.rails === next.rails &&
    previous.agentRail === next.agentRail &&
    previous.childFollows === next.childFollows &&
    previous.mode === next.mode &&
    previous.rootId === next.rootId &&
    previous.inMission === next.inMission &&
    previous.nameOf === next.nameOf &&
    previous.selected === next.selected &&
    previous.activeSessionId === next.activeSessionId &&
    previous.arrivals === next.arrivals &&
    previous.settle === next.settle &&
    previous.collapsed === next.collapsed &&
    previous.folds === next.folds,
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
function ProposalRow({
  issue,
  author,
  selected,
  onSelect,
  onMenu,
}: {
  issue: IssueNavigationModel
  /** The display ref of the session that filed it, when the deck can resolve it. */
  author: string | null
  selected: boolean
  onSelect: (permanent: boolean) => void
  /** A proposal is still a task: same right-click menu as a strip. */
  onMenu: (event: ReactMouseEvent) => void
}): JSX.Element {
  const intent = useClickIntent()
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
        <StageGlyph stage="proposed" size={12} />
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
          title={author ? `Proposed by ${author}` : undefined}
        >
          {author}
        </span>
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
  className,
  testId,
  children,
}: {
  label: string
  /** Printed beside the label when the region's size is the useful fact. */
  count?: number
  /** Class for the label, when the region has a hue of its own (proposals). */
  tone?: string
  /** Optional spacing override for a section that needs a stronger break. */
  className?: string
  testId: string
  children: ReactNode
}): JSX.Element {
  return (
    // THE SECTION STARTS WHERE THE SPINE STARTS. It used to sit at 8px while
    // every task strip began at GUTTER, so a proposal was visibly wider than the
    // tasks it was being offered against and its label rule started in the
    // rail's own gutter. Same left datum as a depth-1 strip, same right datum as
    // everything else in the column.
    <section
      className={cn('pr-2', className ?? 'mt-2.5')}
      style={{ paddingLeft: GUTTER }}
      data-testid={testId}
    >
      <div className="flex items-center gap-2">
        <h3
          className={cn(
            'font-mono shell-type-micro font-medium tracking-[0.16em] uppercase',
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

/** The state dot and word a departed task carries, in the spine's own state
 *  column — the same cell every strip and every agent row parks its state in,
 *  so the whole tail reads down the same edge as the tree above it. */
function DepartedState({ state }: { state: DeckIssueState }): JSX.Element {
  return (
    <span
      className={cn(
        'shell-type-micro flex flex-none items-center justify-end gap-1.5 overflow-hidden font-mono whitespace-nowrap',
        STATE_COL,
      )}
      data-attention={state.attention ? 'true' : undefined}
    >
      {state.attention && (
        <span aria-hidden className="size-[5px] flex-none rounded-full bg-attention" />
      )}
      <span className="truncate">{state.label.toLowerCase()}</span>
    </span>
  )
}

/**
 * WHERE THE WORK WENT — one region, one heading, one sentence (POD-679, POD-1146).
 *
 * Work discovered here and started as its own thing is not a member of this
 * mission any more: it holds no seat, wears no state mark, and does not move
 * the gauge. But a row that simply vanished would be a lie by omission — the
 * operator watched an agent file it here — so the mission keeps one line each,
 * and the line is a way back to it.
 *
 * THE REGION HAS TWO SHAPES AND ONLY ONE OF THEM AT A TIME.
 *
 *   still being worked — quiet ticks, no actions, because nothing here is
 *     finished and nothing is asking;
 *   the root itself vacated — the one destination is PROMOTED to a card with
 *     Open and Tuck away, because it is the only thing left to act on.
 *
 * They used to be two components that did not know about each other, and a
 * continuation target is by construction a started spin-off — so it always
 * qualified as a departure too, and POD-1016 rendered once as a card with two
 * buttons and again twelve pixels below as a faint mono tick in a different
 * voice. The continuation is now simply the departure that has an action
 * attached: it is filtered out of the ticks and drawn as the first row of the
 * same region, wearing the state its tick used to carry.
 *
 * The old heading named a departure ("Left this mission"); this one answers the
 * question the operator is actually asking.
 *
 * Deliberately OUTSIDE the tree: no rail, no elbow, and a label above rather
 * than an indent below. A guide line running into these would say the one thing
 * this whole change exists to stop saying — that they are still in here.
 */
export function WhereTheWorkWent({
  continuation,
  continuationState = null,
  continuationFinished = true,
  continuationSessions = [],
  departures,
  onOpen,
  onTuck,
}: {
  /** The promoted destination, when this mission's own root has been vacated. */
  continuation: IssueContinuation | null
  /** Folded in off the tick this row replaces, so nothing is lost with it. */
  continuationState?: DeckIssueState | null
  /** The vacated task's OWN sessions, so the card can check "vacated" rather
   *  than assume it (POD-1233). */
  continuationSessions?: readonly SessionMeta[]
  /** Whether the vacated task itself is already recorded as finished — the card
   *  names a different filing action when it is not (see {@link ContinuationCard}). */
  continuationFinished?: boolean
  /** Everything else that left — already filtered of the continuation target. */
  departures: readonly MissionDeparture[]
  onOpen: (issue: IssueNavigationModel) => void
  onTuck: () => void
}): JSX.Element | null {
  if (!continuation && departures.length === 0) return null
  return (
    <DeckSection
      label="Where the work went"
      count={departures.length + (continuation ? 1 : 0)}
      className="mt-4"
      testId="flight-departures"
    >
      {continuation && (
        <ContinuationCard
          continuation={continuation}
          state={continuationState}
          finished={continuationFinished}
          sessions={continuationSessions}
          onOpen={onOpen}
          onTuck={onTuck}
        />
      )}
      <div className={cn('flex flex-col', continuation && departures.length > 0 && 'mt-2')}>
        {departures.map((departure, index) => (
          <div key={departure.issue.id}>
            {/* A rule between ticks rather than a bare stack: two 26px rows
                twenty-two pixels apart read as two unrelated lines. */}
            {index > 0 && <div aria-hidden className="my-0.5 ml-1 h-px bg-hairline-soft" />}
            <button
              data-pressable
              type="button"
              data-testid="flight-departure"
              data-departure-issue={departure.issue.id}
              className="flex min-h-[26px] w-full items-center gap-2 rounded-md pr-2 pl-1 text-left text-text-faint hover:bg-muted hover:text-text-dim"
              title={`${issueDisplayRef(departure.issue)} runs on its own · ${departure.state.label}`}
              onClick={() => onOpen(departure.issue)}
            >
              <ArrowUpRight size={11} aria-hidden className="flex-none" />
              <span className="shell-type-micro flex-none font-mono">
                {issueDisplayRef(departure.issue)}
              </span>
              <span className="shell-type-secondary min-w-0 flex-1 truncate">
                {departure.issue.title}
              </span>
              <DepartedState state={departure.state} />
            </button>
          </div>
        ))}
      </div>
    </DeckSection>
  )
}

/**
 * The signpost's SECOND line — the only part of the card that says anything
 * about sessions, and therefore the only part that has to look at them.
 *
 * WHY THE FIX IS HERE AND NOT IN THE VIEWMODEL (POD-1233). The obvious repair
 * for "No session remains" appearing over a live agent is to hoist
 * `issueContinuation`'s live-session guard above its `supersededBy ??
 * duplicateOf` branch. That is wrong: four surfaces read that one function, and
 * three of them want the lineage even while somebody is still here — the
 * sidebar's `duplicate · POD-1160` line (`slices/worklist/rows.ts`), the deck
 * header's "continued in" chip (`issueNote`), and `row-attention`'s suppression
 * of a review ask nobody is waiting on. Returning `null` deletes the trail to
 * the canonical task from all of them. The headline is a LINEAGE fact and stays
 * true whoever is in the room; only this sentence was ever a session claim.
 *
 * PARKED IS PRESENT. `sessionPresentOnTask` is `!archived && status !==
 * 'exited'`, so a hibernated agent still holds the task — the roster draws it
 * ghosted, not gone. That is not a detail: sessions here park far more often
 * than they exit, so "wait for it to end" is a state most tasks never reach,
 * and a guard written against it would suppress the signpost forever.
 *
 * ALL THREE KINDS, deliberately. A duplicate is what surfaced this, but the
 * sentence is equally unchecked on `superseded`, and `spinoff` only escapes it
 * because its own guard fires upstream. Nothing here changes WHICH cards
 * appear — a superseded task with an agent on it still gets its signpost, and
 * still gets to say so honestly.
 */
export function continuationPresenceLine(
  kind: IssueContinuation['kind'],
  sessions: readonly SessionMeta[],
): string {
  return sharedContinuationPresenceLine(kind, sessions)
}

/**
 * THE SIGNPOST BOX — one panel for "this mission is over", however it ended
 * (POD-1268).
 *
 * Two cards say that now, in the same slot of the same column: the continuation
 * ("work carried on in POD-815") and the retirement ("finished, nobody left
 * here"). They are the same kind of statement, so the frame is written once and
 * the words are the only thing that differs between them — an operator who has
 * read one should not have to re-learn the layout to read the other.
 *
 * Presentational only: it holds no lifecycle opinion, which is what keeps the
 * two callers free to name their own action.
 */
function SignpostBox({
  icon,
  headline,
  aside = null,
  detail,
  actions,
  testId,
}: {
  icon: ReactNode
  headline: string
  /** The state word folded in off a departure tick, where there is one. */
  aside?: ReactNode
  detail: string
  actions: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="rounded-[8px] border border-border bg-card/55 p-3" data-testid={testId}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-[22px] flex-none items-center justify-center rounded-full bg-muted text-text-dim">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="shell-type-secondary min-w-0 flex-1 font-semibold text-text-strong">
              {headline}
            </p>
            {aside}
          </div>
          <p className="shell-type-micro mt-1 text-text-dim">{detail}</p>
        </div>
      </div>
      {/* WRAPPING, because this column resizes down to 300px and two labels
          together do not fit there. A clipped action is worse than a stacked one. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[30px]">{actions}</div>
    </div>
  )
}

/**
 * A resolved empty task is not an empty mission. It is a signpost.
 *
 * This stays in the spine instead of becoming a toast: the destination must
 * still be understandable after reload, from another device, and when the
 * operator opens the old task hours later. Tucking is offered here because it
 * is the only remaining lifecycle choice; leaving the card alone keeps the
 * closed task in the sidebar.
 *
 * It is the FIRST ROW of the departures region rather than a card of its own
 * (see {@link WhereTheWorkWent}), and it carries the state word its departure
 * tick used to carry — so the destination is stated exactly once.
 *
 * THE FILING ACTION SAYS WHICH ONE IT IS (POD-1212). "Tuck away" is only
 * truthful on a task that is already finished: the fold is for finished work, so
 * `issues.setTucked` REFUSES an open one and the sidebar's own fold predicate
 * reads the same `closedReason`. A hopscotch origin left standing at `review`
 * with its work carried on elsewhere is exactly the case this card exists for,
 * and there the one button drew a promise the server threw out. So an unfinished
 * task is offered the ending as well as the fold, in one label — never a "Tuck
 * away" that quietly closes, because the tuck chip's own tooltip promises the
 * opposite ("Nothing is killed or closed").
 *
 * IT MUST NOT CLAIM THE TASK IS EMPTY WITHOUT LOOKING (POD-1233). The second
 * line used to be the constant "No session remains on this closed task", and on
 * a DUPLICATE that is a sentence nobody checked: `issueContinuation` reaches its
 * live-session guard only on the hopscotch path, so a task marked
 * `duplicateOf` drew this card with its agent still sitting in the roster
 * directly below. See {@link continuationPresenceLine}.
 */
export function ContinuationCard({
  continuation,
  state = null,
  finished = true,
  sessions = [],
  onOpen,
  onTuck,
}: {
  continuation: IssueContinuation
  /** What the destination is doing now, folded in off its own tick. */
  state?: DeckIssueState | null
  /** Whether THIS task is already closed or done. */
  finished?: boolean
  /** THIS task's own sessions — the only thing that can answer whether anyone
   *  is still here. Unfiltered: the view bar narrows what the spine DRAWS, and
   *  a sentence of fact must not change with a display toggle. */
  sessions?: readonly SessionMeta[]
  onOpen: (issue: IssueNavigationModel) => void
  /** File this signpost away — which on an unfinished task also records the
   *  ending, because tucking alone cannot fold it (see above). */
  onTuck: () => void
}): JSX.Element {
  const target = continuation.target
  return (
    <SignpostBox
      testId="flight-continuation"
      icon={<ArrowRight size={12} aria-hidden="true" />}
      headline={continuation.full}
      aside={state ? <DepartedState state={state} /> : null}
      detail={`${continuationPresenceLine(continuation.kind, sessions)}${
        target ? ` ${target.title} is where it carried on.` : ''
      }`}
      actions={
        <>
          {target && (
            <Button type="button" size="sm" className="h-[26px]" onClick={() => onOpen(target)}>
              Open {issueDisplayRef(target)}
            </Button>
          )}
          {finished ? (
            <Button type="button" variant="outline" size="sm" className="h-[26px]" onClick={onTuck}>
              <ArrowDown size={12} aria-hidden="true" /> Tuck away
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-[26px]"
              title={`Record this task as done — the work carried on in ${
                target ? issueDisplayRef(target) : 'another task'
              } — and tuck it down into Closed.`}
              onClick={onTuck}
            >
              <Check size={12} aria-hidden="true" /> Done &amp; tuck
            </Button>
          )}
        </>
      }
    />
  )
}

/**
 * A CLOSED MISSION WITH NOBODY LEFT ON IT (POD-1268).
 *
 * The other ending. Work that carried on elsewhere gets {@link ContinuationCard}
 * — a destination and a way back to it — but work that simply ENDED here used
 * to get `presenceNote`'s bare status line ("Cancelled · session retired") in
 * faint grey, floating alone in an otherwise empty column. Two things are wrong
 * with that: it reads as a caption on nothing, and the one decision left on the
 * task — put it away — was nowhere on this screen, so the operator had to go
 * find the row in the sidebar to act on what the deck had just told them.
 *
 * So the same box says it, in the same slot, with the fold attached. The two
 * ways a mission can be over now read as one family.
 *
 * THE TUCK IS DIRECT, never {@link ContinuationCard}'s "Done & tuck": this card
 * draws only where `presenceNote` reached `done`, which it reaches only through
 * `issueClosed`. There is no ending left to record, so `issues.setTucked` cannot
 * refuse it and the button may promise the plain fold.
 */
export function RetiredSignpost({
  abandoned,
  onTuck,
}: {
  /** Cancelled or won't-fix rather than completed — the one word that changes.
   *  "Finished" over a task the operator withdrew would be the deck telling a
   *  small lie about their own decision. */
  abandoned: boolean
  onTuck: () => void
}): JSX.Element {
  return (
    <SignpostBox
      testId="flight-retired"
      icon={abandoned ? <X size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
      headline={abandoned ? 'This task was cancelled.' : 'This task is finished.'}
      detail="No session remains on it. Tuck it away to fold it into Closed."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[26px]"
          title="Tuck this finished task down into Closed — it stays reachable there (click to reopen, or start an agent to pick it back up). Nothing is killed or closed."
          onClick={onTuck}
        >
          <ArrowDown size={12} aria-hidden="true" /> Tuck away
        </Button>
      }
    />
  )
}

/**
 * THE DECK WHILE ITS MISSION IS STILL ARRIVING (POD-1139).
 *
 * A LOAD, NOT A STATE — and therefore WORDLESS. The session already carries an
 * `issueId`: the composer's spawn paints the draft vessel and the session
 * together (`optimisticDraftIssue` / `optimisticStartingSession`), so a root
 * exists and this column is only waiting for the selection to catch up. What
 * follows is a real tree a beat later, so anything written here is a sentence
 * the operator watches get taken away.
 *
 * ONE TASK, ONE SESSION — not `EmptyDeck`'s four rows. That ghost teaches the
 * shape of the pane to someone who has never loaded it; this one stands in for
 * a specific tree that is exactly one strip deep, and a ghost that COLLAPSES on
 * resolve reads worse than no ghost at all.
 */
function SettlingDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-settling">
      <GhostPreview
        className="mt-6 flex flex-none flex-col gap-[15px] pr-6"
        testId="flight-ghost-settling"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--success)" width="46%" tier={2} meta={22} />
        </div>
      </GhostPreview>
    </div>
  )
}

/**
 * THE DECK BEHIND A SHELL (POD-1139).
 *
 * A shell reaches this column for real and durably: "New Shell" in the panel
 * menu creates a session with no `issueId` and no draft vessel, and it lands in
 * pane A like any other panel. It used to inherit the agent intake canvas,
 * which told the operator that "the agent will organize this workspace as you
 * talk" over a bash prompt that will do nothing of the kind.
 *
 * So it says the shell thing instead, in the shape `standbyCopy` already uses
 * for this exact case ("A shell keeps no transcript"): state the limit, then
 * point at where the answer actually is. The ghost stays — the column is still
 * a task tree, and picking one is what fills it.
 */
function ShellDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-shell">
      <div className="flex-none px-[26px] pt-6 pr-11">
        <h2 className="shell-type-column-title font-semibold tracking-[-.02em] text-text-strong">
          A shell joins no task
        </h2>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground text-pretty">
          This pane runs commands beside the work, not on it. Pick a task on the left to see the
          agents on it here.
        </p>
      </div>
      <GhostPreview
        className="mt-6 flex min-h-0 flex-1 flex-col gap-[15px] pr-6"
        fadeTo="92%"
        testId="flight-ghost-shell"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--ghost-3)" width="52%" tier={3} />
        </div>
        <GhostTaskRow tier={3} />
      </GhostPreview>
    </div>
  )
}

/**
 * A dead session row, hung under a ghost task at the tree's own indent.
 *
 * The DOT IS THE POINT. Two coloured dots — one working, one waiting on you —
 * are the fastest way for this column to say "I am a status readout" before
 * there is any status to read. They take the semantic status tokens and nothing
 * else: never an issue colour, the same rule the live rows follow, because a
 * hue that means "stage" in one row and "which task" in another means neither.
 */
function GhostSessionRow({
  tone,
  width,
  tier,
  meta,
}: {
  tone: string
  width: string
  tier: 1 | 2 | 3 | 4
  meta?: number
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5" style={{ paddingLeft: GUTTER + DEPTH_STEP }}>
      <GhostDot tone={tone} />
      <GhostBar tier={tier} width={width} height={8} />
      {meta !== undefined && <GhostBar tier={4} width={`${meta}px`} height={8} />}
    </div>
  )
}

/** A dead task strip: fold square, id chip, title, and the meta a live strip
 *  carries on its right. */
function GhostTaskRow({
  tier,
  dashed,
}: {
  tier: 1 | 2 | 3 | 4
  /** The last row stands for a PROPOSED task — the deck's own dashed id chip.
   *  Proposals are part of what this pane is for, so the ghost says so. */
  dashed?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5" style={{ paddingLeft: GUTTER }}>
      {dashed ? (
        <span className="block h-[13px] w-[34px] flex-none rounded-[4px] border border-dashed border-(--ghost-1)" />
      ) : (
        <>
          <GhostSquare tier={tier} className="rounded-[2px]" />
          <GhostBar tier={tier} width="34px" height={13} className="flex-none" />
        </>
      )}
      <GhostBar tier={(tier + 1) as 1 | 2 | 3 | 4} height={9} className="min-w-0 flex-1" />
      {!dashed && <GhostBar tier={4} width="14px" height={9} className="flex-none" />}
    </div>
  )
}

/**
 * THE DECK WITH NO MISSION IN IT (POD-1058, "ADE Empty States" 2a/2b).
 *
 * A GHOST TREE, NOT A GHOST STREAM. What this column is — `buildFlightDeckRows`
 * — is a tree of tasks with their agent sessions hanging under them, plus the
 * proposals they throw off. It is not a message log and not a diff feed; those
 * live in the panel. So the ghost draws two task strips with sessions under a
 * guide line and one dashed proposal, at the tree's real indents (GUTTER,
 * DEPTH_STEP), and a reader who has never seen a loaded deck still learns the
 * shape.
 *
 * NO BUTTON, AND NO HEADER TITLE. The work list and the composer own both ways
 * in; a third one here would be a third thing to explain.
 *
 * ALSO THE DECK BEHIND A SESSION ON NO TASK (POD-1139). "Pick a task on the
 * left or start a new one" is not first-run advice — it is the whole answer for
 * a panel-menu agent or a resumed conversation, neither of which gets a draft
 * vessel. That case used to have a screen of its own (`IntakeCanvas`) that said
 * a softer version of the same thing over a duplicate of the right dock's
 * Task/Plan/Team rows; two surfaces for one sentence is one surface too many.
 */
function EmptyDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-empty">
      <div className="flex-none px-[26px] pt-6 pr-11">
        <h2 className="shell-type-column-title font-semibold tracking-[-.02em] text-text-strong">
          Every agent, in one tree
        </h2>
        {/* Names BOTH ways in, like the work list: picking a task is the
            everyday case, starting one is the first-run case. */}
        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground text-pretty">
          Pick a task on the left or start a new one. You’ll see the agents on it, what each is
          doing, and the follow-ups they propose.
        </p>
      </div>
      <GhostPreview
        className="mt-6 flex min-h-0 flex-1 flex-col gap-[15px] pr-6"
        fadeTo="92%"
        testId="flight-ghost-tree"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          {/* The guide line the live tree draws, on the live tree's own rail —
              a ghost that mirrors the component it stands in has to land on the
              same x, or the first real row will visibly step sideways. */}
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--success)" width="46%" tier={2} meta={22} />
          <GhostSessionRow tone="var(--attention)" width="60%" tier={3} />
        </div>
        <GhostTaskRow tier={3} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--ghost-3)" width="52%" tier={4} />
        </div>
        <GhostTaskRow tier={4} dashed />
      </GhostPreview>
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
    focusIssueSession,
    setPanelMode,
    setView,
    markIssueRead,
    markSessionRead,
    setIssueTucked,
    closeIssue,
    updateIssue,
    trpc,
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
      focusIssueSession: store.focusIssueSession,
      setPanelMode: store.setPanelMode,
      setView: store.setView,
      markIssueRead: store.markIssueRead,
      markSessionRead: store.markSessionRead,
      setIssueTucked: store.setIssueTucked,
      // The signpost card's own filing action closes an unfinished task before
      // it can be tucked (POD-1212) — the fold is for finished work.
      closeIssue: store.closeIssue,
      updateIssue: store.updateIssue,
      trpc: store.trpc,
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
  // `selectedMissionRoot`, not `missionRootFor`: a persisted selection left
  // pointing at an empty draft vessel is not a mission, and this column shows
  // `EmptyDeck` for it rather than a header and a gauge over nothing (POD-1112).
  const root = selectedMissionRoot(issues, sessions, selectedIssueId)
  const rootIssue = root ? issues.find((issue) => issue.id === root.id) : undefined
  // Every strip's status glyph is a picker (POD-1271). The deck holds the apply
  // and its close guard once; a strip carries the id, and the REPLICA's model is
  // what the guard is handed — the mission tree's own row model is a navigation
  // shape, not the one `issueCloseConcerns` reads.
  const rowStatus = useIssueStatusApply()
  const pickRowStatus = (id: string, value: string): void => {
    const issue = issues.find((candidate) => candidate.id === id)
    if (issue) rowStatus.pick(issue, value)
  }
  const computedRows = useMemo(
    () => (root ? buildFlightDeckRows(issues, sessions, root.id, mode, allWorktreePaths) : []),
    [issues, sessions, root, mode, allWorktreePaths],
  )
  const stableRowsRef = useRef<FlightDeckRow[]>([])
  const rows = useMemo(() => {
    const stable = reuseFlightDeckRows(stableRowsRef.current, computedRows)
    stableRowsRef.current = stable
    return stable
  }, [computedRows])
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
  const allDepartures = useMemo(
    () => missionDepartures(issues, sessions, root?.id, allWorktreePaths),
    [issues, sessions, root, allWorktreePaths],
  )
  const liveCount = rows[0]?.liveAgentCount ?? 0
  const workingCount = rows[0]?.workingAgentCount ?? 0
  // NO COUNT ON "Needs you" (POD-1072). A mission is almost always ONE issue with
  // one agent, so the roll-up had nothing to roll up: it was a boolean printed as
  // a number, and the "1" it printed was the same fact the row's own amber mark
  // already carries. The view bar names the view; the tree says how much.
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
    (sessionId: SessionId): string | undefined => missionSessionNames.get(sessionId),
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
  const rootContinuation = root ? issueContinuation(root, byId, sessions) : null
  /**
   * THE CONTINUATION IS A DEPARTURE — the one with an action attached.
   *
   * `missionDepartures` knows nothing about `issueContinuation`, and a
   * continuation target is by construction a started spin-off, so it always
   * qualified as a departure too: the same task rendered once as a card with two
   * buttons and again as a faint mono tick twelve pixels below it, in a
   * different voice. Filtering it out here and promoting it to the first row of
   * the same region is what makes the tail say it once.
   *
   * Its tick's own state comes with it, so folding the two together loses
   * nothing.
   */
  const continuationTargetId = rootContinuation?.target?.id
  const departures = useMemo(
    () => allDepartures.filter((departure) => departure.issue.id !== continuationTargetId),
    [allDepartures, continuationTargetId],
  )
  const continuationState =
    allDepartures.find((departure) => departure.issue.id === continuationTargetId)?.state ?? null
  const rootNote = root ? issueNote(root, byId, sessions) : null
  /**
   * The mission header's roster — content, and therefore the view bar's (POD-1356).
   *
   * It used to be read with `matched` forced true, on the argument that the root
   * is the column's statement of which mission is on screen rather than one of
   * the rows POD-1245 quietened. The statement is the header; the CREW under it
   * is not. Forcing it meant every agent on the mission survived every view, so
   * on a mission with no sub-tasks — most of them — `Full`, `Active` and
   * `Needs you` drew the identical column and the bar looked inert.
   *
   * The sentence that branch was protecting is handled where it belongs: the
   * empty line below now says WHICH view emptied the spine, instead of claiming
   * a fully staffed mission has nobody on it.
   */
  const rootSessions = useMemo(() => (rootRow ? deckSessions(rootRow, mode) : []), [rootRow, mode])
  // The whole slice as the fourth argument — the root's OWN sessions cannot see
  // a spin-off its agent hopped to (see `staffedSpinOff`).
  const rootSeat = rootRow
    ? seatFor(presenceNote(rootRow.issue, rootRow.sessions, byId, sessions))
    : null
  /**
   * Why the spine is empty, when it is — and the root's OWN sessions answer it,
   * never the view-narrowed `rootSessions`. A "nobody is here" drawn because you
   * filtered the column down to working agents is the POD-1233 bug in a new
   * costume; a parked agent still holds the task and this must keep saying so.
   */
  const rootEmptyNote = root ? presenceNote(root, rootRow?.sessions ?? [], byId, sessions) : null
  /** `done` is the note's word for "closed, and nobody is on it" — the one
   *  empty-spine state that still has a decision left in it. */
  const rootRetired = rootEmptyNote?.kind === 'done'
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
    (issueId: IssueId | undefined): RailTone =>
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
      for (let level = 1; level <= row.depth; level += 1)
        tones.push(
          leadTone(
            trail[level - 1] === undefined ? undefined : asIssueId(trail[level - 1] as string),
          ),
        )
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
  const rootDraft = useSessionDraft(draftFilling ? rootSession?.sessionId : undefined)
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

  /**
   * REVEAL A SESSION'S ROW (POD-1077) — what the tab menu asks for when the
   * operator wants the verbs a tab deliberately does not carry.
   *
   * Three steps, and skipping any one leaves the reveal a lie:
   *  1. RE-ROOT if the session belongs to another mission, or the deck would
   *     scroll a spine that does not contain it.
   *  2. UNFOLD every ancestor. A row inside a closed fold is not in the DOM at
   *     all, so scrolling to it would silently find nothing — the failure mode
   *     that makes a "reveal" feel broken rather than absent.
   *  3. SCROLL, after paint. The unfold above is a state write, and the row it
   *     creates does not exist until React has rendered it.
   */
  useEffect(() => {
    const onReveal = (event: Event): void => {
      const sessionId = (event as CustomEvent<string>).detail
      if (!sessionId) return
      const target = sessions.find((session) => session.sessionId === sessionId)
      if (!target) return
      if (target.issueId) {
        const owner = issues.find((issue) => issue.id === target.issueId)
        if (owner) setSelectedIssueId(missionRootFor(issues, owner.id)?.id ?? owner.id)
        setFocusedIssueId(target.issueId)
        // Every row whose subtree contains the owner is an ancestor of it, plus
        // the owner itself — one pass over the rows rather than walking parents,
        // because `descendantIds` is already the closure the deck computed.
        const open = new Map(folds)
        for (const row of rows) {
          if (row.issue.id === target.issueId || row.descendantIds.includes(target.issueId)) {
            open.set(row.issue.id, 'open')
          }
        }
        setFolds(open)
      }
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-flight-session="${sessionId}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      })
    }
    window.addEventListener(REVEAL_IN_DECK_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_IN_DECK_EVENT, onReveal)
  }, [sessions, issues, rows, folds, setFolds, setSelectedIssueId, setFocusedIssueId])

  const selectIssue = (row: FlightDeckRow, permanent: boolean): void => {
    setFocusedIssueId(row.issue.id)
    // A deliberate task pick asks to SEE its inspector, not merely retarget an
    // inspector that happens to be open. Reopen the Task dock even when the
    // operator previously dismissed it; the provider follows the focus update
    // above and retargets the explorer to this issue.
    window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'issue' }))
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
  /**
   * THE TASK MENU, HOSTED ONCE (POD-771).
   *
   * One menu for the whole column rather than one per strip: a spine can carry
   * fifty rows, and fifty mounted portals to serve the one the cursor is over is
   * a cost paid on every render of a list that re-renders on every clock tick.
   * The strips report a cursor and an id; this resolves the id against the
   * replica's own issues, because `row.issue` is the deck's navigation
   * projection and the shared menu acts on the full view model.
   */
  const [issueMenu, setIssueMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null)
  const openIssueMenu = useCallback((issueId: IssueId, event: ReactMouseEvent): void => {
    event.preventDefault()
    setIssueMenu({ id: issueId, anchor: { x: event.clientX, y: event.clientY } })
  }, [])
  const menuIssue = issueMenu ? issues.find((issue) => issue.id === issueMenu.id) : undefined
  /**
   * WHICH STRIP IS RENAMING (POD-1077) — deck state, for the same reason the
   * menu is: the menu is mounted once for the column, so the row it names has to
   * be addressed by id rather than by reaching into that row's own hook.
   */
  const [renamingIssueId, setRenamingIssueId] = useState<string | null>(null)
  /**
   * The shared commit policy (POD-407), applied here so no strip carries a
   * second copy: trim, then no-op on empty or unchanged. The no-op is the part
   * that matters — the editor commits on BLUR, so clicking away from an editor
   * opened by accident must not spend a write, a revision bump and a feed entry
   * on a title that did not change.
   */
  const renameIssue = useCallback(
    (issueId: string, next: string): void => {
      const trimmed = next.trim()
      const current = issues.find((issue) => issue.id === issueId)?.title
      if (!trimmed || trimmed === current) return
      void updateIssue(issueId, { title: trimmed })
    },
    [issues, updateIssue],
  )

  /**
   * FILING THE SIGNPOST AWAY — recording the ending first when there is one
   * still to record (POD-1212).
   *
   * `issues.setTucked` REFUSES an unfinished issue ("issue … is not finished"),
   * and the sidebar's fold predicate reads the same `closedReason`. So on the
   * mission this card exists for — a hopscotch origin standing at `review`, its
   * work carried on in a spin-off, no session left here — the lone "Tuck away"
   * painted a fold the server threw out and the row came straight back. The
   * unfinished task is therefore closed as `done` and THEN tucked.
   *
   * TWO WRITES, ONE PARTITION. Both are queued outbox kinds routed on
   * `issue:<id>` (wiring.ts), which is what makes the pair safe rather than
   * racy: the close is applied before the tuck reaches the guard that reads it.
   * The `.then` chain is the enqueue order, not a round-trip wait.
   *
   * The guard interrupts only when a close would actually raise something —
   * stranded commits, an open sub-task, a standing decision. POD-1129's rule is
   * that every surface must name the SAME concerns, not that every surface must
   * stop to report none: this button already says what it will do, and a dialog
   * that rises to answer "nothing found" is a tax on the ordinary case.
   */
  const rootFinished = Boolean(root && (root.closedReason || root.stage === 'done'))
  const [signpostClosing, setSignpostClosing] = useState(false)
  const needsCloseGuard = useIssueCloseGuard()
  const closeAndTuckRoot = (): void => {
    if (!root) return
    const id = root.id
    setSignpostClosing(false)
    void closeIssue(id, 'done')
      .then(() => setIssueTucked(id, true))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
  }
  const tuckResolvedRoot = (): void => {
    if (!root) return
    if (!rootContinuation && !rootFinished) return
    if (rootFinished) {
      void setIssueTucked(root.id, true)
      return
    }
    // The same question every close path now asks before raising the guard
    // (POD-1278) — this column has asked it since POD-1212, and the hook is where
    // it lives now.
    if (rootIssue && needsCloseGuard(rootIssue)) {
      setSignpostClosing(true)
      return
    }
    closeAndTuckRoot()
  }
  const addMissionAgent = async (agentKind?: IssueAgentKind): Promise<void> => {
    if (!rootIssue) return
    const input = agentKind ? { id: rootIssue.id, agentKind } : { id: rootIssue.id }
    const existingSessionIds = sessions
      .filter((session) => session.issueId === rootIssue.id && !session.archived)
      .map((session) => session.sessionId)
    await (rootIssue.worktreePath
      ? trpc.issues.addSession.mutate(input)
      : trpc.issues.start.mutate(input))
    await focusIssueSession(rootIssue.id, { excludeSessionIds: existingSessionIds })
  }
  const selectSession = (
    issueId: IssueId | null,
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

  /**
   * THE MISSION'S SPINE IS ONE LINE, DRAWN ONCE (POD-1226).
   *
   * The header's descent, the view bar, the search bar and the list's top pad
   * each drew their own `w-px bg-hairline-soft` at `ROOT_RAIL` (the first three
   * are gone now — see below), while the root's
   * agent block below them drew `railFor(leadTone(root.id))` — 2px in the
   * mission's accent whenever the mission has a coordinator. Same left edge,
   * different width and different ink: the line ran 1px and grey through the
   * chrome and then stepped a pixel wider and changed colour at the first agent
   * row, which is exactly where the design says it must read as unbroken.
   *
   * So the rail is resolved ONCE here and every segment of it is drawn from that
   * one object. A jog cannot come back without changing this line.
   *
   * AND IT STARTS AT THE LIST, NOT IN THE HEADER (POD-1306).
   *
   * Round 3 §4 had the spine leave the mission header, on the argument that the
   * header IS the root node and a node's line descends from it. On screen it
   * never said that. The header is padded to 16px, which is `ROOT_RAIL` itself,
   * so the title, the description and the gauge chip's left border all stood ON
   * the rail's x rather than beside it — and the descent below them was sixteen
   * pixels long. What the operator saw was not a spine leaving a node but a
   * stray tick hanging off the gauge chip's bottom-left corner, clipped by the
   * view bar's top rule, and they filed it twice.
   *
   * There were two ways out: give the header the same 8px gutter every row
   * below it has, or stop claiming the header is on the tree. This is the
   * second. The header is a header, the view bar is a band cut through the
   * column, and the spine begins where the tree begins — the list's own top
   * pad, which is the first thing above the root's agents. Nothing above that
   * pad draws at `ROOT_RAIL`, and nothing above it may: the header's 16px
   * padding is that same x, so any segment there lands under the text.
   */
  const spineRail = railFor(leadTone(root?.id))
  const spineSegment = (className: string, style?: CSSProperties): JSX.Element => (
    <span
      aria-hidden
      className={cn('pointer-events-none absolute', spineRail.className, className)}
      style={{ left: ROOT_RAIL, width: spineRail.width, ...style }}
    />
  )

  /**
   * THE COLLAPSE CHEVRON IS A MEMBER OF THE EYEBROW ROW (POD-1146).
   *
   * It used to be `absolute top-1 right-2` on the column itself, and the eyebrow
   * then reserved `pr-11` to dodge a control that was floating over it. Two
   * consequences: the eyebrow had an eleven-pixel hole in it that nothing
   * explained, and the chevron's centre did not line up with the ⌕ and the
   * fold-all control directly below it.
   *
   * As the last flex child of a row padded to 8px it is simply a 24px button
   * like those two, so every glyph centre in the column stands 20px from the
   * edge and the reservation goes away.
   *
   * The empty states have no eyebrow to sit in, so they keep the floating one —
   * the column must always be collapsible, mission or no mission.
   */
  const collapseButton = (floating: boolean): JSX.Element => (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        'deck-eyebrow-chevron size-6 flex-none text-text-faint',
        floating && 'absolute top-1 right-2 z-20',
      )}
      aria-label="Collapse Flight Deck"
      title="Collapse Flight Deck"
      onClick={onCollapse}
    >
      <ChevronLeft size={14} aria-hidden="true" />
    </Button>
  )

  return (
    <aside className="engraved-column relative" aria-label="Flight Deck">
      {!root && collapseButton(true)}

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
          {/* The header IS the root's strip (round 3 §4), so it takes the strips'
              menu as well as their click: right-clicking the mission has to
              reach the mission's own actions, or the one task in the column with
              no strip would be the one task with no menu. */}
          <div
            className="deck-header relative flex-none"
            onContextMenu={(event) => openIssueMenu(root.id, event)}
          >
            {/* THE EYEBROW MAY TAKE A SECOND LINE (POD-1146). Nothing in this
                header could wrap, so a mission with a relation note, a held seat
                and a long stage word simply collided at the column's 300px
                floor. Identity and the chevron own line 1 and never shrink; the
                note and the seat drop underneath them, left-aligned on the same
                16px datum, where they can never run into the chevron. A flight
                deck may spend a line to keep a fact. */}
            <div className="shell-type-micro flex min-h-8 flex-wrap items-center gap-x-1.5 py-1 pr-2 pl-4 font-mono text-text-dim">
              {/* Identity NEVER shrinks and never leaves line 1: the glyph, the
                  ref and the stage word are what this row is for. */}
              {rootIssue ? (
                <IssueStatusPicker
                  issue={rootIssue}
                  onPick={(value) => rowStatus.pick(rootIssue, value)}
                />
              ) : (
                <StageGlyph stage={root.stage} size={12} />
              )}
              <span className="flex-none leading-[24px]">{issueDisplayRef(root)}</span>
              <span className="flex-none leading-[24px]">
                {STAGE_LABELS[root.stage].toLowerCase()}
              </span>
              <span aria-hidden className="min-w-[8px] flex-1" />
              {/* The mission's own dependency or provenance, and the seat it is
                  holding if nobody is on it — in the same chips a strip wears.
                  The header IS a node, so it says what a node says, in the same
                  slot: a strip carries these on its right, and so does this. */}
              {(rootNote || rootSeat) && (
                <span className="deck-eyebrow-note flex min-w-0 shrink items-center gap-1.5 pl-2">
                  {rootNote && <IssueNoteChip note={rootNote} />}
                  {rootSeat && <SeatChip note={rootSeat} />}
                </span>
              )}
              {collapseButton(false)}
            </div>
            {/* THE HEADER IS NOT ON THE SPINE (POD-1306) — see the note over
                `spineSegment`. Its 16px padding is ROOT_RAIL's own x, which is
                exactly why no rail may be drawn under it. */}
            <div className="px-4 pt-0.5 pb-3.5">
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
                  ? rootDraft
                    ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
                    : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
                  : root.description?.trim() ||
                    root.activityNotes?.trim() ||
                    'Mission work, agents, and dependencies in one live execution view.'}
              </p>
              {/* ONE 26px FAMILY, ON ONE BASELINE (POD-1146). The gauge, the
                  crew chip and the mission's one action were three heights on
                  two alignments; they are one row of 26px radius-8 objects now.
                  The gauge takes all the slack and the action never shrinks —
                  and when there is no longer room for both, the row WRAPS rather
                  than crushing either. Add agent keeps its word at every width:
                  it is the header's only action, and a bare glyph makes the
                  operator guess. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="min-w-[9rem] flex-[1_1_9rem]">
                  <MissionGauge progress={progress} live={liveCount} working={workingCount} />
                </div>
                {rootIssue && !rootIssue.closedReason && !rootIssue.deletedAt && (
                  <MissionAgentMenu
                    defaultAgent={rootIssue.defaultAgent}
                    repoPath={rootIssue.repoPath}
                    machineId={rootIssue.machineId}
                    onAdd={addMissionAgent}
                  />
                )}
              </div>
            </div>
          </div>
          {/* Rules TOP AND BOTTOM, both in the soft tier: the bar is a band cut
              through the column, and its top rule is the seam the header no
              longer draws for itself. */}
          <div
            className="relative flex h-8 flex-none items-center gap-1 border-y border-hairline-soft pr-2"
            style={{ paddingLeft: GUTTER }}
          >
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
                  'shell-type-micro inline-flex items-center self-stretch px-2 font-medium text-text-faint hover:text-text-strong',
                  mode === option.id && 'text-text-strong shadow-[inset_0_-2px_0_var(--issue)]',
                )}
                onClick={() => setMode(option.id)}
              >
                {option.label}
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
              className="relative flex h-8 flex-none items-center gap-2 border-b border-hairline-soft pr-2"
              style={{ paddingLeft: GUTTER }}
            >
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
          {/* THE ROSTER CHANGES COMPOSITION AS ONE UNIT (POD-1226).
              `deck-rows` is the query container for every agent row, so nested
              rows do not switch early merely because their branch indent made
              them a few pixels narrower. One panel width means one scan rhythm. */}
          <div
            className="deck-rows min-h-0 flex-1 overflow-y-auto pb-1.5 pr-2"
            data-testid="flight-deck-rows"
          >
            {/* WHERE THE SPINE STARTS (POD-1306). The list's own top padding is
                the first six pixels of the line, so the tree opens with a rail
                rather than with an elbow arriving out of nothing. Everything
                above this — the header, the view bar, the search bar — is chrome
                the spine does not cross; see the note over `spineSegment`. */}
            <div className="relative h-1.5">{spineSegment('inset-y-0')}</div>
            {/* THE MISSION'S OWN AGENTS, hanging off the header (round 3 §4).
                Not a strip — the header above IS their task. Their rail lands on
                ROOT_RAIL exactly, so one line runs through their elbows and
                carries on into the first child below. */}
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
                  inset={ROOT_BLOCK_INSET}
                  rail={spineRail}
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
                    {spineSegment('inset-y-0')}
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
                folds={folds}
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
                onMenu={(event) => openIssueMenu(row.issue.id, event)}
                onStatusPick={(value) => pickRowStatus(row.issue.id, value)}
                renaming={renamingIssueId === row.issue.id}
                onRenameIssue={(title) => renameIssue(row.issue.id, title)}
                onRenameDone={() => setRenamingIssueId(null)}
              />
            ))}
            {visibleRows.length === 0 &&
              proposedRows.length === 0 &&
              (query ? (
                <p className="shell-type-secondary px-4 py-6 text-text-dim">
                  Nothing in this mission matches that.
                </p>
              ) : // A vacated root is not an empty spine — the region below says
              // where the work went, and it says it once. This branch used to
              // draw the continuation card itself, which is half of why the same
              // destination appeared twice.
              rootContinuation || rootSessions.length > 0 ? null : rootRetired ? (
                // THE MISSION ENDED HERE — a card, not a caption (POD-1268).
                // Every other note below is a state the operator reads and
                // leaves alone; this one is the only one still asking for a
                // decision, and the decision is the fold.
                <div className="py-4 pr-2" style={{ paddingLeft: GUTTER }}>
                  <RetiredSignpost abandoned={issueAbandoned(root)} onTuck={tuckResolvedRoot} />
                </div>
              ) : (
                <p className="shell-type-secondary px-4 py-6 text-text-dim">
                  {/* WHICH VIEW EMPTIED IT (POD-1356). `rootEmptyNote` is about
                      the mission — "nobody is on this" — and printing it under a
                      narrowed view says that about a task with a live agent on
                      it. The view's own sentence comes first, and only `full`
                      falls through to the note. */}
                  {deckViewEmptyLine(mode) ??
                    rootEmptyNote?.text ??
                    'No sessions or sub-tasks are attached.'}
                </p>
              ))}
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
                      onMenu={(event) => openIssueMenu(row.issue.id, event)}
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
                controls narrow the spine.
                The continuation card lives HERE now rather than in the tree's
                empty branch above — one region, one heading, one sentence. */}
            <WhereTheWorkWent
              continuation={rootContinuation}
              continuationState={continuationState}
              continuationFinished={rootFinished}
              // `rootRow.sessions`, NOT `rootSessions`: the latter is
              // `deckSessions(row, mode)`, which the view bar narrows. A card
              // that said "nobody is here" because you filtered the spine down
              // to working agents would be the same bug in a new costume.
              continuationSessions={rootRow?.sessions ?? []}
              departures={departures}
              onOpen={openDeparture}
              onTuck={tuckResolvedRoot}
            />
          </div>
        </>
      ) : focusedSession?.agentKind === 'shell' ? (
        // A shell will never become a task, so it never gets agent words.
        <ShellDeck />
      ) : focusedSession?.issueId ? (
        // The session already knows its task; only the selection is behind. A
        // load, so a ghost — never a sentence the resolve then contradicts.
        <SettlingDeck />
      ) : (
        // NO SESSION, or a session on no task at all ("New Shell"'s agent
        // siblings in the panel menu, and every resume, create one with no
        // vessel). Both want the same words — pick a task or start one — which
        // is what `EmptyDeck` already says, so it says them for both.
        <EmptyDeck />
      )}
      {issueMenu && menuIssue && (
        <IssueContextMenu
          issues={[menuIssue]}
          allIssues={issues}
          // `deck`, not `sidebar` (POD-1077). It was `sidebar` because that kept
          // the board-only triage items ("Duplicate of…") where POD-100 put them
          // — still true — but it also meant a SUB-TASK strip rendered the
          // identical menu to a MISSION row, offering Pin (which orders a column
          // this is not) and Archive (which hides a row this column cannot get
          // back). The deck is its own surface because it has its own answers.
          surface="deck"
          primaryStart={menuIssue.stage === 'proposed'}
          anchor={issueMenu.anchor}
          onClose={() => setIssueMenu(null)}
          onRename={(id) => {
            setIssueMenu(null)
            setRenamingIssueId(id)
          }}
          onOpen={(id) => {
            setIssueMenu(null)
            const row = rows.find((candidate) => candidate.issue.id === id)
            // Open is the strip's own double click — the permanent one.
            if (row) selectIssue(row, true)
          }}
        />
      )}
      {/* The SAME guard every other close path raises (POD-1129), mounted for the
          one close this column can start: the signpost card's "Done & tuck". It
          appears only when that close would strand something — see
          `tuckResolvedRoot`. */}
      {rootIssue && (
        <IssueCloseDialog
          issue={rootIssue}
          reason={signpostClosing ? 'done' : null}
          onOpenChange={(open) => setSignpostClosing(open)}
          onConfirm={closeAndTuckRoot}
        />
      )}
      {/* The guard for an ending picked from a strip's glyph — the same dialog,
          raised for whichever task was picked from rather than for the root. */}
      {rowStatus.dialog}
    </aside>
  )
}
