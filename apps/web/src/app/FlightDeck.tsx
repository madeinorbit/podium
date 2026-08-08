import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  buildFlightDeckRows,
  type CollapsedSummary,
  type DeckIssueState,
  deckIssueState,
  deckSessions,
  type DeckState,
  type FlightDeckMode,
  type FlightDeckRow,
  type IssueNavigationModel,
  type IssueNote,
  issueNote,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  motionPhase,
  nativeSubagentRows,
  type PresenceNote,
  presenceNote,
  reposToViews,
  sessionNeedsHuman,
  type SessionRole,
  sessionRole,
  treeGuides,
} from '@podium/client-core/viewmodels'
import type { AgentKind, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
  ArrowDown,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  Hourglass,
  Search,
  X,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { BrailleSpinner, PhaseTimer, useArrivals } from '@/lib/motion'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
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
 * A session hangs further in than one issue step, so a CHILD task always lands
 * left of its parent's agents: issue depth reads as issue depth and a session
 * never looks like it is parenting the task below it.
 */
const SPINE_PAD = 8
const DEPTH_STEP = 14
/** Where a nesting level's rail sits inside its own step. */
const RAIL_INSET = 6
/** A task strip's height, and its vertical centre — where its elbow lands. */
const BAND_HEIGHT = 30
const BAND_MID = BAND_HEIGHT / 2
/**
 * A PROPOSED strip is shorter — nobody has accepted it, so it holds no space for
 * an agent and needs none for itself (POD-516 round 3 §7b). Its elbow moves with
 * it: a rail that met a 30px band's centre would enter a 24px one three pixels
 * low, which is exactly the kind of near-miss that makes a tree look drawn
 * rather than computed.
 */
const PROPOSED_BAND = 24
const PROPOSED_MID = PROPOSED_BAND / 2
/** A session band's inset inside its task strip, and its own rail. */
const AGENT_INDENT = 22
const AGENT_RAIL = 8
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
/** Vertical centre of every row hung under a task strip (min-height 24px). */
const HUNG_MID = 12
/** A native worker's inset inside its session band, and its own rail. */
const NATIVE_INDENT = 20
const NATIVE_RAIL = 7
/** Vertical centre of a native row (height 20px). */
const NATIVE_MID = 10

const readMode = (raw: string | null): FlightDeckMode =>
  raw === 'active' || raw === 'needs-you' ? raw : 'full'
const writeMode = (mode: FlightDeckMode): string | null => (mode === 'full' ? null : mode)

const EMPTY_FOLDS: ReadonlySet<string> = new Set<string>()
const readFolds = (raw: string | null): ReadonlySet<string> => {
  if (!raw) return EMPTY_FOLDS
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : EMPTY_FOLDS
  } catch {
    return EMPTY_FOLDS
  }
}
const writeFolds = (folds: ReadonlySet<string>): string | null =>
  folds.size === 0 ? null : JSON.stringify([...folds])

/**
 * THE MISSION GAUGE — progress and fleet as one instrument (round 3 §3, §11).
 *
 * The reading used to sit BESIDE the track, and the fleet ("21 live / 0 coords")
 * a line below it as a pair of mono footnotes. Three facts, three places, none
 * of them composed. This is one carved well: the extent is the well's own
 * ground, the reading sits inside it, and the fleet closes it on the right.
 *
 * The extent is drawn twice on purpose, the way a real gauge is — a soft tinted
 * REGION says roughly how far, and a saturated 2px rule along the floor says
 * exactly where it ends. That is also what buys the contrast: the words sit over
 * a 22% tint rather than over a solid fill, so they stay full-strength ink.
 *
 * COLOUR. Meters are data (DESIGN.md §5). Done takes Accent Blue, running takes
 * the working blue the spinner already uses, and BLOCKED TAKES NO HUE AT ALL:
 * `--warning` IS `--attention` in Superade, so the old warning-toned segment was
 * spending the one signal colour on work that is asking nothing. It reads as the
 * same diagonal hatch a blocked strip wears instead — one idea, both places.
 *
 * MOTION. The spinner appears only while an agent in this mission is genuinely
 * computing, which is the folded rail's rule and the app's only perpetual
 * motion; the live count beside it stays neutral, because agents being present
 * asks nothing of the operator.
 */
function MissionGauge({
  progress,
  live,
  working,
}: {
  progress: ReturnType<typeof missionProgress>
  live: number
  working: number
}): JSX.Element {
  const { total, done, run, block } = progress
  const pct = (n: number): string => `${total === 0 ? 0 : (n / total) * 100}%`
  const words = [`${done} done`, `${run} running`, block > 0 ? `${block} blocked` : null]
    .filter(Boolean)
    .join(' · ')
  const reading =
    `${done} of ${total} task${total === 1 ? '' : 's'} done, ${run} running` +
    `${block > 0 ? `, ${block} blocked` : ''} · ${live} agent${live === 1 ? '' : 's'} live` +
    `${working > 0 ? `, ${working} working` : ''}`
  const segment = (width: string, tone: string, hatch = false): JSX.Element => (
    <span
      className={cn(
        'h-full transition-[width] duration-300 motion-reduce:transition-none',
        tone,
        hatch && 'deck-hatch',
      )}
      style={{ width }}
    />
  )
  return (
    <div
      className="relative mt-3 flex h-[22px] items-center overflow-hidden rounded-lg bg-secondary/70 shadow-[inset_0_1px_2px_var(--carve-drop)]"
      data-testid="mission-gauge"
      role="img"
      aria-label={reading}
      title={reading}
    >
      {/* The region: the well's ground, tinted as far as the work has come. */}
      <span aria-hidden className="absolute inset-0 flex">
        {segment(pct(done), 'bg-success/22')}
        {segment(pct(run), 'bg-live/22')}
        {segment(pct(block), 'bg-transparent', true)}
      </span>
      {/* The floor rule: the same datum, said exactly. */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 flex h-[2px]">
        {segment(pct(done), 'bg-success')}
        {segment(pct(run), 'bg-live')}
        {segment(pct(block), 'bg-text-faint')}
      </span>
      <span className="shell-type-micro relative min-w-0 flex-1 truncate pl-2.5 font-mono tabular-nums text-foreground">
        {words}
      </span>
      <span className="shell-type-micro relative flex flex-none items-center gap-1.5 pr-2.5 pl-2 font-mono tabular-nums text-text-dim">
        {working > 0 ? (
          <BrailleSpinner size={9} />
        ) : (
          <span aria-hidden className="size-[5px] flex-none rounded-full bg-live/60" />
        )}
        {live} live
      </span>
    </div>
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
function StateMark({ state }: { state: DeckState }): JSX.Element {
  // The spinner carries its own reserved working blue (`--motion-working`);
  // nothing here retints it.
  if (state === 'working') return <BrailleSpinner size={9} className="flex-none" />
  if (state === 'done') return <Check size={11} aria-hidden className="flex-none text-success" />
  if (state === 'blocked') return <Ban size={11} aria-hidden className="flex-none text-text-dim" />
  if (state === 'moved') {
    return <ArrowRight size={11} aria-hidden className="flex-none text-text-dim" />
  }
  // A proposal is not a queued job, so it does not get the queue's hourglass —
  // its stage glyph on the left already says `proposed`, and the word carries it.
  if (state === 'proposed') return <span aria-hidden className="w-px flex-none" />
  return <Hourglass size={10} aria-hidden className="flex-none text-text-faint" />
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
  const Glyph =
    note.kind === 'blocked' ? Ban : note.kind === 'waiting' ? ArrowDown : CornerDownRight
  return (
    <span
      className="shell-type-micro flex max-w-[10rem] flex-none items-center gap-1 font-mono text-text-faint"
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
function StateLabel({ value }: { value: DeckIssueState }): JSX.Element {
  return (
    <span
      className="flex flex-none items-center gap-1.5"
      data-operational-state={value.state}
      data-attention={value.attention ? 'true' : undefined}
      title={value.attention ? `${value.label} · a session in here needs you` : value.label}
    >
      {value.attention && (
        <span aria-hidden className="size-[5px] flex-none rounded-full bg-attention" />
      )}
      <StateMark state={value.state} />
      <span className="shell-type-micro truncate font-mono text-text-dim">{value.label}</span>
    </span>
  )
}

/**
 * One rail segment plus the elbow into the row hanging on it.
 *
 * `last` stops the rail at the elbow, which is what makes the final child of a
 * branch read as final rather than as a line running off into the next block.
 * `tone` is a background class: a lit rail is how a focused or asking row says
 * so without a coloured 2px border, which is the callout-card tell this system
 * refuses.
 */
function Hung({
  railX,
  indent,
  mid,
  last,
  tone,
  children,
}: {
  railX: number
  indent: number
  mid: number
  last: boolean
  tone: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="relative">
      <span
        aria-hidden
        className={cn('pointer-events-none absolute w-px', tone)}
        style={{ left: railX, top: 0, height: last ? mid : '100%' }}
      />
      <span
        aria-hidden
        className={cn('pointer-events-none absolute h-px', tone)}
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
  mid = BAND_MID,
}: {
  carries: readonly boolean[]
  mid?: number
}): JSX.Element | null {
  const depth = carries.length
  if (depth === 0) return null
  const ownX = SPINE_PAD + (depth - 1) * DEPTH_STEP + RAIL_INSET
  return (
    <>
      {carries.slice(0, -1).map((carry, level) => {
        const left = SPINE_PAD + level * DEPTH_STEP + RAIL_INSET
        return carry ? (
          <span
            key={left}
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-hairline-soft"
            style={{ left }}
          />
        ) : null
      })}
      <span
        aria-hidden
        className="pointer-events-none absolute w-px bg-hairline-soft"
        style={{ left: ownX, top: 0, height: carries[depth - 1] ? '100%' : mid }}
      />
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
function CollapsedPayload({ summary }: { summary: CollapsedSummary }): JSX.Element {
  const { tasks, done, run, kinds, needsYou } = summary
  const pct = (n: number): string => `${tasks === 0 ? 0 : (n / tasks) * 100}%`
  return (
    <span
      className="flex flex-none items-center gap-1.5"
      data-testid="flight-collapse-payload"
      title={`${tasks} task${tasks === 1 ? '' : 's'} · ${run} active${needsYou ? ' · needs you' : ''}`}
    >
      <span className="shell-type-micro rounded border border-hairline-bar px-1 font-mono text-text-dim">
        {tasks} task{tasks === 1 ? '' : 's'}
      </span>
      <span className="flex h-1 w-7 flex-none overflow-hidden rounded-full bg-secondary">
        <span className="h-full bg-success" style={{ width: pct(done) }} />
        <span className="h-full bg-info" style={{ width: pct(run) }} />
      </span>
      {kinds.length > 0 && (
        <span className="flex flex-none items-center pl-0.5">
          {kinds.map((kind, index) => (
            <span key={kind} className={index > 0 ? '-ml-1.5' : undefined}>
              <KindIcon kind={kind} chip />
            </span>
          ))}
        </span>
      )}
      {needsYou && <span aria-hidden className="size-1.5 flex-none rounded-full bg-attention" />}
    </span>
  )
}

/**
 * THE EMPTY SEAT — the slot a session will land in, drawn as a slot (round 3 §6).
 *
 * The operator asked for two things that pull in opposite directions: stop this
 * looking like an agent row, and KEEP the held space, because the space is what
 * teaches where you will click to enter a session once one is on this task.
 *
 * So the space stays exactly the height a session row occupies, and everything
 * that made it read as an agent goes: no filled band, no raised surface, no
 * agent chip — in its place the same 20px silhouette the harness tile would fill,
 * drawn as a hole. A hole where a face goes is unmistakably an empty seat, and
 * unmistakably not somebody sitting in it. A PROPOSED task gets no seat at all
 * (see §7b): nobody has accepted it, so there is nothing yet to hold space for.
 *
 * The one arm that keeps a voice is `attention` — vacated in-progress work with
 * no handoff is genuinely asking, and that is what amber is for.
 */
function ReservedSlot({ note, last }: { note: PresenceNote; last: boolean }): JSX.Element {
  return (
    <Hung
      railX={AGENT_RAIL}
      indent={AGENT_INDENT}
      mid={HUNG_MID}
      last={last}
      tone={note.attention ? 'bg-attention/70' : 'bg-hairline-soft'}
    >
      <div
        className={cn(
          'shell-type-micro flex min-h-6 items-center gap-1.5 py-0.5 pr-2 font-mono',
          note.attention ? 'font-semibold text-attention' : 'text-text-faint',
        )}
        style={{ marginLeft: AGENT_INDENT }}
        data-presence={note.kind}
        data-testid="flight-reserved-slot"
      >
        <span
          aria-hidden
          className={cn(
            'size-5 flex-none rounded-[6px] border border-dashed',
            note.attention ? 'border-attention/60' : 'border-hairline-bar',
          )}
        />
        {note.kind === 'moved' && <ArrowRight size={11} aria-hidden className="flex-none" />}
        <span className="truncate">{note.text}</span>
      </div>
    </Hung>
  )
}

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
          tone="bg-border/70"
        >
          <button
            data-pressable
            type="button"
            className="shell-type-micro flex h-5 w-full items-center gap-1.5 rounded-r-md pr-2 text-left font-mono text-text-faint hover:bg-muted hover:text-text-dim"
            style={{ paddingLeft: NATIVE_INDENT + 4 }}
            onClick={onOpen}
            title={`Focus ${sessionDisplayName(session)} in Native · ${agent.anonymous ? 'unnamed worker' : agent.id}`}
          >
            <KindIcon kind={session.agentKind} dimmed />
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
  'phase-lead': 'phase lead',
  peer: 'operator-added peer',
}

/** The role as the dim mono word after the name. A spawn edge is named by its
 *  PARENT — "by Spine designer" is the fact the operator can act on; the parent
 *  session id is not. An unresolvable parent gets no word rather than an id.
 *  The mission's coordinator is the one role that takes a badge instead
 *  (`CoordinatorBadge`), so it returns nothing here rather than saying it twice. */
function roleLabel(
  role: SessionRole | null,
  nameOf: (sessionId: string) => string | undefined,
): string | null {
  if (role === null || role.kind === 'coordinator') return null
  if (role.kind !== 'spawned') return ROLE_LABEL[role.kind]
  const parent = nameOf(role.parentSessionId)
  return parent ? `by ${parent}` : null
}

/**
 * WHO DRIVES THIS MISSION, shown in the spine (round 3 §11).
 *
 * The header used to count coordinators ("0 coords") — a number that tells the
 * operator nothing they can act on, about sessions that are all right there.
 * The count is gone and the fact moved onto the session it is about, in the
 * app's existing vocabulary: the same word, the same title, the same testid as
 * the sidebar roster's badge (features/worklist/sidebar-common.tsx).
 *
 * Deliberately NOT the same classes. That badge is drawn in raw `sky-500`, which
 * is not a token and not in this theme's palette (navy · yellow · red · blue);
 * here it takes `--info`, the palette's Accent Blue. Both should be the token —
 * that file belongs to another surface, so this one leads.
 */
function CoordinatorBadge(): JSX.Element {
  return (
    <span
      className="shell-type-micro flex-none rounded border border-info/45 bg-info/10 px-1 font-semibold tracking-wide text-info uppercase"
      data-testid="coordinator-badge"
      title="Coordinator session — drives this issue"
    >
      coord
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
 */
function SessionRow({
  session,
  role,
  label,
  active,
  last,
  now,
  onOpen,
  onOpenNative,
}: {
  session: SessionMeta
  role: SessionRole | null
  /** The role as a word, already resolved (a spawn parent needs a name). */
  label: string | null
  active: boolean
  last: boolean
  now: number
  onOpen: () => void
  onOpenNative: () => void
}): JSX.Element {
  const retired = session.archived || session.status === 'exited'
  const starting = session.status === 'starting' || session.status === 'reconnecting'
  const needs = !retired && sessionNeedsHuman(session)
  const phase = motionPhase(session)
  const since = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  const stamp = relativeTime(session.lastActiveAt, now)
  const total = session.agentState?.workingMsTotal
  return (
    <Hung
      railX={AGENT_RAIL}
      indent={AGENT_INDENT}
      mid={HUNG_MID}
      last={last}
      tone={needs ? 'bg-attention/80' : active ? 'bg-info/80' : 'bg-hairline-bar'}
    >
      <div
        className={cn('rounded-r-md', needs || active ? 'bg-muted' : 'bg-bar')}
        style={{ marginLeft: AGENT_INDENT }}
        data-flight-session={session.sessionId}
        data-needs-you={needs ? 'true' : undefined}
      >
        <button
          data-pressable
          type="button"
          className={cn(
            // One tier quieter than a task strip, and recessed rather than
            // raised: the strips are the spine, the agents working them are the
            // roster (sidebar-common's row idiom).
            'group/session shell-type-secondary flex min-h-6 w-full items-center gap-2 rounded-r-md px-2 py-1 text-left text-text-dim hover:text-foreground',
            active && 'text-foreground',
            retired && 'opacity-60',
          )}
          onClick={onOpen}
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
            {role?.kind === 'coordinator' && <CoordinatorBadge />}
            {label && (
              <span
                className="shell-type-micro min-w-0 shrink-[8] truncate font-mono font-normal text-text-faint"
                data-session-role={role?.kind}
                title={label}
              >
                {label}
              </span>
            )}
          </span>
          <span className="flex flex-none items-center gap-1.5">
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
        <NativeRows session={session} onOpen={onOpenNative} />
      </div>
    </Hung>
  )
}

/** Everything that hangs under a task: the agents on it, then the seat held for
 *  the one that is not there yet. Shared by the strips and by the MISSION
 *  HEADER, which is now the root of the tree and hangs its own agents the same
 *  way (round 3 §4) — one idiom, so the root reads as a node and not as a
 *  special case. */
interface HungContext {
  issue: IssueNavigationModel
  sessions: SessionMeta[]
  /** The seat, or null when the task holds none (proposed work, or a task whose
   *  agents already speak for it). */
  presence: PresenceNote | null
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
  /** Keep the last row's rail running to the block's bottom edge, because the
   *  tree carries on below it. The root block sets this; a strip never does. */
  tail: boolean
  /**
   * The roster's own disclosure, for a block big enough to bury the tree.
   *
   * The mission header is the root of the spine now, so EVERY session ever
   * attached to the mission hangs directly off it — sixteen of them on this
   * issue, which pushed the first actual task a screen and a half down. The
   * root strip used to be foldable and is gone, so this is where that control
   * has to live. `sessions` arrives already trimmed; this only draws the line
   * that says what was trimmed and takes the click.
   */
  fold?: { hidden: number; open: boolean; onToggle: () => void }
  onSelectSession: (session: SessionMeta) => void
  onSelectNative: (session: SessionMeta) => void
}

function HungRows(ctx: HungContext): JSX.Element | null {
  const reduce = useReducedMotion()
  // Held across a change so the seat can COLLAPSE with its words still in it (a
  // task leaving proposed, or an agent finally arriving on an empty one) rather
  // than emptying first and then closing.
  const lastPresence = useRef<PresenceNote | null>(null)
  if (ctx.presence) lastPresence.current = ctx.presence
  const shown = ctx.presence ?? lastPresence.current
  const { sessions, presence, fold } = ctx
  const disclosure = fold && fold.hidden > 0 ? fold : null
  if (sessions.length === 0 && shown === null && !disclosure) return null
  const count = sessions.length + (presence ? 1 : 0) + (disclosure ? 1 : 0)
  let placed = 0
  const isLast = (): boolean => {
    placed += 1
    return !ctx.tail && placed === count
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
            onOpen={() => ctx.onSelectSession(session)}
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
      {/* The roster's own line, hung on the same rail as the agents it stands
          for so it reads as part of the block rather than as a control bolted
          under it. Quieter than a session and it carries no state mark: it is
          not an agent, it is the count of the ones being held back. */}
      {disclosure && (
        <Hung
          railX={AGENT_RAIL}
          indent={AGENT_INDENT}
          mid={HUNG_MID}
          last={isLast()}
          tone="bg-hairline-soft"
        >
          <button
            data-pressable
            type="button"
            data-testid="flight-roster-fold"
            aria-expanded={disclosure.open}
            className="shell-type-micro flex min-h-6 w-full items-center gap-1.5 rounded-r-md py-1 text-left font-mono text-text-faint hover:text-text-dim"
            style={{ paddingLeft: AGENT_INDENT + 2 }}
            onClick={disclosure.onToggle}
          >
            {disclosure.open ? (
              <ChevronDown size={10} aria-hidden className="flex-none" />
            ) : (
              <ChevronRight size={10} aria-hidden className="flex-none" />
            )}
            <span className="truncate">
              {disclosure.open
                ? `Hide ${disclosure.hidden} finished`
                : `${disclosure.hidden} finished agent${disclosure.hidden === 1 ? '' : 's'}`}
            </span>
          </button>
        </Hung>
      )}
      {/* THE SEAT MAKES AND GIVES BACK ITS OWN SPACE (round 3 §7c). Always
          mounted, so a plain grid-rows transition carries both directions and
          nothing animates on first paint — a transition only fires on a change. */}
      {shown && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          style={{ gridTemplateRows: presence ? '1fr' : '0fr' }}
        >
          <div className="min-h-0 overflow-hidden">
            <ReservedSlot note={shown} last={isLast()} />
          </div>
        </div>
      )}
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
  onSelectIssue: () => void
  onSelectSession: (session: SessionMeta) => void
  onSelectNative: (session: SessionMeta) => void
}): JSX.Element {
  const hasPayload = row.descendantIds.length > 0 || row.sessions.length > 0
  const bandLeft = SPINE_PAD + row.depth * DEPTH_STEP
  const state = deckIssueState(row.issue, row.sessions, byId)
  const sessions = deckSessions(row, mode)
  // A PROPOSAL IS A DIFFERENT KIND OF ROW (round 3 §7b): nobody has accepted it,
  // so it holds no seat for an agent and takes the shorter band.
  const proposed = row.issue.stage === 'proposed'
  const note = issueNote(row.issue, byId)
  // The seat is held for work that could be picked up — never under a proposal,
  // and never to restate a dependency the strip has already named above it.
  const rawPresence = proposed ? null : presenceNote(row.issue, row.sessions, byId)
  const presence =
    rawPresence && (rawPresence.kind === 'blocked' || rawPresence.kind === 'waiting')
      ? null
      : rawPresence
  return (
    <div className="relative" data-flight-issue={row.issue.id} data-depth={row.depth}>
      <BranchGuides carries={carries} mid={proposed ? PROPOSED_MID : BAND_MID} />
      {/* The strip is a BAND: a tonal step up from the engraved column plus a
          hairline, never a lift — DESIGN.md's carved rule. Selection is the
          issue tint over that same engraved base (with its slate pair, so an
          uncoloured mission still reads) and a 2px inset edge in the issue's own
          colour, which is this app's focus language rather than the artifact's
          borrowed blue.
          BLOCKED WEARS A HATCH (round 3 §8) — a shallow diagonal rule over
          whatever ground the band already has. No border, no hue: blocked is a
          stopped state, and `--warning` IS `--attention` in this theme, so any
          warning tone here would read as "answer me".
          The band's own HEIGHT transitions, so a task leaving `proposed` grows
          into its full strip rather than snapping (§7c). */}
      <div
        className={cn(
          'group/task relative flex items-center gap-1 rounded-md border pr-1.5 transition-[background-color,border-color,min-height] duration-200 ease-out motion-reduce:transition-none',
          state.state === 'blocked' && 'deck-hatch',
          selected
            ? 'issue-mix-28 issue-mix-slate-22 issue-base-engraved issue-hairline-50 issue-hairline-slate-40 shadow-[inset_2px_0_0_var(--issue)]'
            : 'border-hairline-soft bg-rail hover:border-hairline-bar hover:bg-chip',
        )}
        style={{ marginLeft: bandLeft, minHeight: proposed ? PROPOSED_BAND : BAND_HEIGHT }}
      >
        {hasPayload ? (
          <button
            data-pressable
            type="button"
            className="flex size-5 flex-none items-center justify-center text-text-dim hover:text-text-strong"
            aria-label={collapsed ? `Expand ${row.issue.title}` : `Collapse ${row.issue.title}`}
            aria-expanded={!collapsed}
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
            'flex min-w-0 flex-1 items-center gap-2 text-left',
            proposed ? 'py-0.5' : 'py-1',
          )}
          onClick={onSelectIssue}
        >
          <StageGlyph stage={row.issue.stage} size={13} />
          {/* Ref THEN title, in one truncating label: the ref is how the
              operator addresses the task everywhere else in Podium, and a
              right-aligned ref made the column read right-to-left. */}
          <span className="shell-type-secondary min-w-0 flex-1 truncate font-medium">
            <span className="shell-type-micro mr-1.5 font-mono font-normal text-text-faint">
              {issueDisplayRef(row.issue)}
            </span>
            {row.issue.title}
          </span>
          {note && !collapsed && <IssueNoteChip note={note} />}
          {collapsed && hasPayload ? (
            <CollapsedPayload summary={row.collapsedSummary} />
          ) : (
            <StateLabel value={state} />
          )}
        </button>
      </div>
      {/* THE FOLD GROWS AND SHRINKS (round 3 §7c) — a grid-rows collapse, the
          app's existing height idiom (DockSection). It needs no measurement and
          no mount, so nothing choreographs on first paint: a transition only
          runs when a value actually changes. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <HungRows
            issue={row.issue}
            sessions={sessions}
            presence={presence}
            rootId={rootId}
            inMission={inMission}
            nameOf={nameOf}
            activeSessionId={activeSessionId}
            arrivals={arrivals}
            settle={settle}
            now={now}
            inset={bandLeft}
            tail={false}
            onSelectSession={onSelectSession}
            onSelectNative={onSelectNative}
          />
        </div>
      </div>
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
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6" data-testid="flight-intake">
      <div className="shell-type-micro flex items-center gap-2 font-mono tracking-wide text-text-dim uppercase">
        <KindIcon kind={kind} chip />
        {session ? sessionDisplayName(session) : 'New session'}
      </div>
      <h2 className="shell-type-reading mt-2.5 font-semibold tracking-[-0.01em] text-text-strong">
        Ready when you are
      </h2>
      <p className="shell-type-secondary mt-1.5 leading-[1.5] text-text-dim">
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
    setPane,
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
      setPane: store.setPane,
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
  const [collapsed, setCollapsed] = usePersistedUiState<ReadonlySet<string>>(
    FLIGHT_DECK_FOLDS_KEY,
    readFolds,
    writeFolds,
  )
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
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
   * But "always show" cannot mean "always show ALL". Every session the mission
   * has ever had hangs off this header, and on a long-running mission that is
   * sixteen rows — most of them finished — between the operator and the first
   * actual task. So the FINISHED ones fold away behind their own count, and
   * what is left standing is what is still happening. The live roster is never
   * hidden, whatever its size; only the settled part is.
   */
  const rootRow = rows[0]
  const rootNote = root ? issueNote(root, byId) : null
  const rootSessions = useMemo(
    () => (rootRow ? deckSessions(rootRow, mode) : []),
    [rootRow, mode],
  )
  const [rosterOpen, setRosterOpen] = useState(false)
  const rootLive = useMemo(
    () =>
      rootSessions.filter((session) => {
        const retired = session.archived || session.status === 'exited'
        return !retired && motionPhase(session) !== 'done'
      }),
    [rootSessions],
  )
  const rootFinished = rootSessions.length - rootLive.length
  // Below this the fold costs a row to save fewer, which is the fold that hides
  // nothing — the same rule the collapsed payload follows.
  const rosterFoldable = rootFinished > 2
  const rootShown = !rosterFoldable || rosterOpen ? rootSessions : rootLive
  // Search keeps a match's ANCESTORS as context, the same rule the mode filters
  // follow — an exception that loses its path is an exception you cannot place.
  const visibleRows = useMemo(() => {
    const hiddenByAncestor = new Set<string>()
    for (const row of rows) {
      if (row.depth === 0 || !collapsed.has(row.issue.id)) continue
      for (const id of row.descendantIds) hiddenByAncestor.add(id)
    }
    const unfolded = rows.filter((row) => row.depth > 0 && !hiddenByAncestor.has(row.issue.id))
    const needle = query.trim().toLowerCase()
    if (!needle) return unfolded
    const matches = (row: FlightDeckRow): boolean =>
      row.issue.title.toLowerCase().includes(needle) ||
      issueDisplayRef(row.issue).toLowerCase().includes(needle) ||
      row.sessions.some((session) => sessionDisplayName(session).toLowerCase().includes(needle))
    const keep = new Set<string>()
    const trail: FlightDeckRow[] = []
    for (const row of unfolded) {
      trail.length = row.depth
      trail[row.depth] = row
      if (matches(row)) for (const ancestor of trail) if (ancestor) keep.add(ancestor.issue.id)
    }
    return unfolded.filter((row) => keep.has(row.issue.id))
  }, [rows, collapsed, query])
  // Computed over the rows that ACTUALLY render: a fold or a filter changes which
  // strip is the last child of its branch, and a rail that outlives its last
  // child is the tell that the tree was drawn from data rather than from layout.
  const guides = useMemo(() => treeGuides(visibleRows), [visibleRows])
  const missionSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows) for (const session of row.sessions) ids.add(session.sessionId)
    return ids
  }, [rows])
  const rootSession = root ? rows[0]?.sessions[0] : focusedSession
  const draftFilling = Boolean(root?.draft && rootSession)
  const repoName = useMemo(() => reposToViews(repos)[0]?.name ?? null, [repos])
  // The root is never in the fold set — see `rootRow`.
  const foldable = useMemo(
    () =>
      rows.filter(
        (row) => row.depth > 0 && (row.descendantIds.length > 0 || row.sessions.length > 0),
      ),
    [rows],
  )
  const anyFoldable = foldable.length > 0
  const allFolded = anyFoldable && foldable.every((row) => collapsed.has(row.issue.id))
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

  const toggleFold = useCallback(
    (id: string): void => {
      const next = new Set(collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setCollapsed(next)
    },
    [collapsed, setCollapsed],
  )

  const selectIssue = (row: FlightDeckRow): void => {
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
      setPane('A', target.sessionId)
      void markSessionRead(target.sessionId)
    }
    setView('workspace')
  }
  const selectSession = (row: FlightDeckRow, session: SessionMeta, native = false): void => {
    setFocusedIssueId(row.issue.id)
    if (session.cwd) setSelectedWorktree(session.cwd)
    setPane('A', session.sessionId)
    if (native) setPanelMode(session.sessionId, 'native')
    void markIssueRead(row.issue.id)
    void markSessionRead(session.sessionId)
    setView('workspace')
  }

  return (
    <aside className="engraved-column" aria-label="Flight Deck">
      <div className="flex h-(--section-bar-h) flex-none items-center border-b border-hairline-bar bg-bar px-3">
        <div className="min-w-0 flex-1">
          <div className="shell-type-primary font-semibold text-text-strong">Flight Deck</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-text-dim"
          title="Collapse Flight Deck"
          onClick={onCollapse}
        >
          <ChevronLeft size={12} aria-hidden="true" />
        </Button>
      </div>

      {root ? (
        <>
          {/* THE MISSION HEADER IS THE ROOT OF THE TREE (round 3 §2, §4, §10).
              Roomy because it is read once where the strips below are scanned,
              and now carrying the mission's OWN colour: the issue tint over the
              tabstrip tier, which is one tonal step up from the engraved column,
              so the head of the spine reads as the head of the spine. `--issue`
              is scoped once on `.desktop-shell` and IS the mission's colour, and
              every tint here is paired with its slate value so an uncoloured
              mission still reads.
              The `1 / 16` that used to sit after the title is gone (§10) — the
              gauge below says it in words. */}
          <div className="relative flex-none border-b issue-hairline-50 issue-hairline-slate-45 issue-mix-18 issue-mix-slate-14 issue-base-tabstrip px-4 pt-4 pb-4">
            <div className="shell-type-micro flex items-center gap-1.5 font-mono text-text-faint">
              <StageGlyph stage={root.stage} size={12} />
              <span>{issueDisplayRef(root)}</span>
              <span className="text-text-dim">{STAGE_LABELS[root.stage].toLowerCase()}</span>
              {/* The mission's own dependency or provenance, in the same chip a
                  strip wears — the header is a node, so it says what a node says. */}
              {rootNote && (
                <span className="ml-auto flex min-w-0 pl-2">
                  <IssueNoteChip note={rootNote} />
                </span>
              )}
            </div>
            <button
              data-pressable
              type="button"
              className="mt-1.5 block w-full min-w-0 text-left"
              onClick={() => rootRow && selectIssue(rootRow)}
              title={`Focus ${issueDisplayRef(root)}`}
            >
              <h2 className="shell-type-reading font-semibold tracking-[-0.01em] text-text-strong">
                {draftFilling ? sessionDisplayName(rootSession as SessionMeta) : root.title}
              </h2>
            </button>
            <p className="shell-type-secondary mt-2 line-clamp-4 leading-[1.5] text-text-dim">
              {draftFilling
                ? drafts[rootSession?.sessionId ?? '']
                  ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
                  : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
                : root.description?.trim() ||
                  root.activityNotes?.trim() ||
                  'Mission work, agents, and dependencies in one live execution view.'}
            </p>
            <MissionGauge progress={progress} live={liveCount} working={workingCount} />
            {/* THE DESCENT. The spine leaves the header on the mission's own
                rail and is picked up, unbroken, by the view bar and then by the
                root's agents — whose rail IS this one (see ROOT_BLOCK_INSET). */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-0 h-4 w-px bg-hairline-soft"
              style={{ left: ROOT_RAIL }}
            />
          </div>
          <div
            className="relative flex h-10 flex-none items-center gap-1 border-b border-hairline-bar pr-3"
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
                className={cn(
                  'shell-type-micro inline-flex h-6 items-center gap-1 rounded-md px-2 text-text-dim hover:bg-muted hover:text-text-strong',
                  mode === option.id && 'bg-muted font-semibold text-text-strong',
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
                className="size-6 text-text-dim"
                aria-pressed={searchOpen}
                title="Search this mission"
                onClick={() => {
                  setSearchOpen((open) => !open)
                  if (searchOpen) setQuery('')
                }}
              >
                <Search size={11} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-text-dim"
                title={allFolded ? 'Expand every branch' : 'Fold every branch'}
                disabled={!anyFoldable}
                onClick={() =>
                  setCollapsed(
                    allFolded ? new Set<string>() : new Set(foldable.map((row) => row.issue.id)),
                  )
                }
              >
                {allFolded ? <ChevronsUpDown size={11} /> : <ChevronsDownUp size={11} />}
              </Button>
            </div>
          </div>
          {searchOpen && (
            <div
              className="relative flex h-9 flex-none items-center gap-2 border-b border-hairline-bar pr-3"
              style={{ paddingLeft: GUTTER }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-hairline-soft"
                style={{ left: ROOT_RAIL }}
              />
              <Search size={11} aria-hidden="true" className="flex-none text-text-faint" />
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
          {/* No gap between row blocks: each block draws the guide rails crossing
              it from its own top to its own bottom, so blocks have to touch or
              the tree lines break. The breathing room lives INSIDE the block
              (`pt-0.5` above each strip), which the rails run through. */}
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
              <HungRows
                issue={rootRow.issue}
                sessions={rootShown}
                fold={
                  rosterFoldable
                    ? {
                        hidden: rootFinished,
                        open: rosterOpen,
                        onToggle: () => setRosterOpen((open) => !open),
                      }
                    : undefined
                }
                presence={presenceNote(rootRow.issue, rootRow.sessions, byId)}
                rootId={root.id}
                inMission={missionSessionIds}
                nameOf={nameOf}
                activeSessionId={activeSessionId}
                arrivals={arrivals}
                settle={settle}
                now={coarseNow}
                inset={ROOT_BLOCK_INSET}
                tail={visibleRows.length > 0}
                onSelectSession={(session) => selectSession(rootRow, session)}
                onSelectNative={(session) => selectSession(rootRow, session, true)}
              />
            )}
            {visibleRows.map((row, index) => (
              <TaskRow
                key={row.issue.id}
                row={row}
                byId={byId}
                carries={guides[index] ?? []}
                mode={mode}
                rootId={root.id}
                inMission={missionSessionIds}
                nameOf={nameOf}
                selected={focused === row.issue.id}
                activeSessionId={activeSessionId}
                arrivals={arrivals}
                settle={settle}
                collapsed={collapsed.has(row.issue.id)}
                now={coarseNow}
                onToggle={() => toggleFold(row.issue.id)}
                onSelectIssue={() => selectIssue(row)}
                onSelectSession={(session) => selectSession(row, session)}
                onSelectNative={(session) => selectSession(row, session, true)}
              />
            ))}
            {visibleRows.length === 0 && (
              <p className="shell-type-secondary px-4 py-6 text-text-dim">
                {query
                  ? 'Nothing in this mission matches that.'
                  : rootRow && rootRow.sessions.length > 0
                    ? 'No sub-tasks yet — this mission is the whole of it.'
                    : 'Nothing here in this view.'}
              </p>
            )}
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
