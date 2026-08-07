import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import {
  FLIGHT_DECK_FOLDS_KEY,
  FLIGHT_DECK_MODE_KEY,
} from '@podium/client-core/ui-state'
import {
  type IssueNavigationModel,
  motionPhase,
  reposToViews,
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
import type { CSSProperties, JSX, ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useReplicaIssues, useStoreSelector } from './store'
import { Button } from '@/components/ui/button'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { BrailleSpinner, PhaseTimer } from '@/lib/motion'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import {
  blockedNote,
  buildFlightDeckRows,
  type CollapsedSummary,
  coordinatorCount,
  type DeckIssueState,
  type DeckState,
  deckIssueState,
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  nativeSubagentRows,
  presenceNote,
  type PresenceNote,
  relationNote,
  type SessionRole,
  sessionNeedsHuman,
  sessionRole,
  treeGuides,
  waitingNote,
} from '@/lib/mission'

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
/** Vertical centre of a task strip (min-height 30px) — where its elbow lands. */
const BAND_MID = 15
/** A session band's inset inside its task strip, and its own rail. */
const AGENT_INDENT = 22
const AGENT_RAIL = 8
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
 * Mission progress, in four segments over the WHOLE mission.
 *
 * Meters are Accent Blue data on the secondary surface (DESIGN.md §5) — the
 * yellow stays reserved for the thing asking something of you, so blocked work
 * takes the warning tone and waiting work stays uncoloured.
 */
function ProgressBar({
  progress,
}: {
  progress: ReturnType<typeof missionProgress>
}): JSX.Element {
  const { total, done, run, block } = progress
  const pct = (n: number): string => `${total === 0 ? 0 : (n / total) * 100}%`
  return (
    <div className="mt-3 flex items-center gap-2.5">
      <div className="flex h-[5px] flex-1 overflow-hidden rounded-full bg-secondary">
        <span className="h-full bg-success transition-[width] duration-300" style={{ width: pct(done) }} />
        <span className="h-full bg-info transition-[width] duration-300" style={{ width: pct(run) }} />
        <span className="h-full bg-warning transition-[width] duration-300" style={{ width: pct(block) }} />
      </div>
      <span className="shell-type-micro flex-none font-mono tabular-nums text-text-dim">
        {done} done · {run} active
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
  return <Hourglass size={10} aria-hidden className="flex-none text-text-faint" />
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
 *  `carries[level]` comes from `treeGuides` — see the geometry note above. */
function BranchGuides({ carries }: { carries: readonly boolean[] }): JSX.Element | null {
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
        style={{ left: ownX, top: 0, height: carries[depth - 1] ? '100%' : BAND_MID }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute h-px bg-hairline-soft"
        style={{ left: ownX, top: BAND_MID, width: DEPTH_STEP - RAIL_INSET }}
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

/** The inset band that says why a task has nobody on it — or, alongside live
 *  agents, what it is still waiting for. A blank here is the one thing the deck
 *  must never render: "no session" is four situations and only one is a problem. */
function PresenceBand({ note, last }: { note: PresenceNote; last: boolean }): JSX.Element {
  return (
    <Hung
      railX={AGENT_RAIL}
      indent={AGENT_INDENT}
      mid={HUNG_MID}
      last={last}
      tone={note.attention ? 'bg-attention/70' : 'bg-hairline-bar'}
    >
      <div
        className={cn(
          'shell-type-micro flex min-h-6 items-center gap-1.5 rounded-r-md bg-bar px-2 py-1 font-mono',
          note.attention ? 'font-semibold text-attention' : 'text-text-dim',
        )}
        style={{ marginLeft: AGENT_INDENT }}
        data-presence={note.kind}
      >
        {note.kind === 'moved' && <ArrowRight size={11} aria-hidden className="flex-none" />}
        {note.kind === 'blocked' && <Ban size={11} aria-hidden className="flex-none" />}
        {note.kind === 'waiting' && <ArrowDown size={11} aria-hidden className="flex-none" />}
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
            <span className="min-w-0 flex-1 truncate">
              {agent.type}
              {!agent.anonymous && <span className="text-text-faint/70"> · {agent.id}</span>}
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
 *  session id is not. An unresolvable parent gets no word rather than an id. */
function roleLabel(
  role: SessionRole | null,
  nameOf: (sessionId: string) => string | undefined,
): string | null {
  if (role === null) return null
  if (role.kind !== 'spawned') return ROLE_LABEL[role.kind]
  const parent = nameOf(role.parentSessionId)
  return parent ? `by ${parent}` : null
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
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <WorkerLabel session={session} chip />
            {label && (
              <span
                className="shell-type-micro flex-none truncate font-mono font-normal text-text-faint"
                data-session-role={role?.kind}
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
  // Three lines can hang under a strip, and their order is the order the
  // operator needs them: who is on it, then what is holding it, then where it
  // came from. A blocked task says so even while an agent is still on it — the
  // right-hand slot has room for the word `Blocked` and nothing else, so this
  // is the only place the blocker can be named.
  const blocked = blockedNote(row.issue, byId)
  // A dependency the operator can act on outlives the agent working the task:
  // an issue with live sessions AND an unfinished blocker says both.
  const waiting = !blocked && sessions.length > 0 ? waitingNote(row.issue, byId) : null
  const presence = blocked ? null : presenceNote(row.issue, row.sessions, byId)
  const relation =
    presence?.kind === 'moved' || waiting || blocked ? null : relationNote(row.issue, byId)
  const hung = sessions.length + (blocked ? 1 : 0) + (waiting ? 1 : 0) + (presence ? 1 : 0) + (relation ? 1 : 0)
  let placed = 0
  const isLast = (): boolean => {
    placed += 1
    return placed === hung
  }
  return (
    <div className="relative" data-flight-issue={row.issue.id} data-depth={row.depth}>
      <BranchGuides carries={carries} />
      {/* The strip is a BAND: a tonal step up from the engraved column plus a
          hairline, never a lift — DESIGN.md's carved rule. Selection is the
          issue tint over that same engraved base (with its slate pair, so an
          uncoloured mission still reads) and a 2px inset edge in the issue's own
          colour, which is this app's focus language rather than the artifact's
          borrowed blue. */}
      <div
        className={cn(
          'group/task relative flex min-h-[30px] items-center gap-1 rounded-md border pr-1.5 transition-colors',
          selected
            ? 'issue-mix-28 issue-mix-slate-22 issue-base-engraved issue-hairline-50 issue-hairline-slate-40 shadow-[inset_2px_0_0_var(--issue)]'
            : 'border-hairline-soft bg-rail hover:border-hairline-bar hover:bg-chip',
        )}
        style={{ marginLeft: bandLeft }}
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
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
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
          {collapsed && hasPayload ? (
            <CollapsedPayload summary={row.collapsedSummary} />
          ) : (
            <StateLabel value={state} />
          )}
        </button>
      </div>
      {!collapsed && hung > 0 && (
        <div className="relative" style={{ marginLeft: bandLeft }}>
          {sessions.map((session) => {
            const role = sessionRole(row.issue, session, { rootId, siblings: sessions, inMission })
            return (
              <SessionRow
                key={session.sessionId}
                session={session}
                role={role}
                label={roleLabel(role, nameOf)}
                active={activeSessionId === session.sessionId}
                last={isLast()}
                now={now}
                onOpen={() => onSelectSession(session)}
                onOpenNative={() => onSelectNative(session)}
              />
            )
          })}
          {blocked && (
            <PresenceBand
              note={{ kind: 'blocked', text: blocked, attention: false }}
              last={isLast()}
            />
          )}
          {waiting && (
            <PresenceBand
              note={{ kind: 'waiting', text: waiting, attention: false }}
              last={isLast()}
            />
          )}
          {presence && <PresenceBand note={presence} last={isLast()} />}
          {relation && (
            <Hung
              railX={AGENT_RAIL}
              indent={AGENT_INDENT}
              mid={HUNG_MID}
              last={isLast()}
              tone="bg-hairline-bar"
            >
              <div
                className="shell-type-micro flex min-h-6 items-center gap-1.5 py-1 font-mono text-text-faint"
                style={{ paddingLeft: AGENT_INDENT + 2 }}
                data-testid="flight-relation-note"
              >
                <CornerDownRight size={10} aria-hidden className="flex-none" />
                <span className="truncate">{relation}</span>
              </div>
            </Hung>
          )}
        </div>
      )}
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
  const allWorktreePaths = useMemo(() => reposToViews(repos).flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)), [repos])
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
  const leadCount = coordinatorCount(rows, sessions)
  const liveCount = rows[0]?.liveAgentCount ?? 0
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
  // Search keeps a match's ANCESTORS as context, the same rule the mode filters
  // follow — an exception that loses its path is an exception you cannot place.
  const visibleRows = useMemo(() => {
    const hiddenByAncestor = new Set<string>()
    for (const row of rows) {
      if (!collapsed.has(row.issue.id)) continue
      for (const id of row.descendantIds) hiddenByAncestor.add(id)
    }
    const unfolded = rows.filter((row) => !hiddenByAncestor.has(row.issue.id))
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
  const anyFoldable = rows.some((row) => row.descendantIds.length > 0 || row.sessions.length > 0)
  const allFolded = anyFoldable && rows.every((row) => (row.descendantIds.length === 0 && row.sessions.length === 0) || collapsed.has(row.issue.id))

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
    const active = row.sessions.filter((session) => !session.archived && session.status !== 'exited')
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
          {/* The mission intro is the one roomy thing in this column: it is read
              once, the strips below it are scanned. */}
          <div className="flex-none border-b border-hairline-bar px-4 pt-4 pb-4">
            <div className="shell-type-micro flex items-center gap-1.5 font-mono text-text-faint">
              <StageGlyph stage={root.stage} size={12} />
              <span>{issueDisplayRef(root)}</span>
              <span className="text-text-dim">{STAGE_LABELS[root.stage].toLowerCase()}</span>
            </div>
            <div className="mt-1.5 flex items-start gap-2.5">
              <h2 className="shell-type-reading min-w-0 flex-1 font-semibold tracking-[-0.01em] text-text-strong">
                {draftFilling ? sessionDisplayName(rootSession as SessionMeta) : root.title}
              </h2>
              <span className="shell-type-micro mt-1 flex-none font-mono tabular-nums text-text-faint">
                {progress.done} / {progress.total}
              </span>
            </div>
            <p className="shell-type-secondary mt-2 line-clamp-4 leading-[1.5] text-text-dim">
              {draftFilling
                ? drafts[rootSession?.sessionId ?? '']
                  ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
                  : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
                : root.description?.trim() ||
                  root.activityNotes?.trim() ||
                  'Mission work, agents, and dependencies in one live execution view.'}
            </p>
            <ProgressBar progress={progress} />
            <div className="shell-type-micro mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-text-dim">
              <span>{liveCount} live</span>
              <span>
                {leadCount} coord{leadCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div className="flex h-10 flex-none items-center gap-1 border-b border-hairline-bar px-3">
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
                    allFolded
                      ? new Set<string>()
                      : new Set(
                          rows
                            .filter(
                              (row) => row.descendantIds.length > 0 || row.sessions.length > 0,
                            )
                            .map((row) => row.issue.id),
                        ),
                  )
                }
              >
                {allFolded ? <ChevronsUpDown size={11} /> : <ChevronsDownUp size={11} />}
              </Button>
            </div>
          </div>
          {searchOpen && (
            <div className="flex h-9 flex-none items-center gap-2 border-b border-hairline-bar px-3">
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
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5 pr-2" data-testid="flight-deck-rows">
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
                {query ? 'Nothing in this mission matches that.' : 'Nothing here in this view.'}
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
