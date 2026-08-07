import { shallowEqual } from '@podium/client-core/store'
import {
  FLIGHT_DECK_FOLDS_KEY,
  FLIGHT_DECK_MODE_KEY,
} from '@podium/client-core/ui-state'
import {
  isCoordinatorSession,
  type IssueNavigationModel,
  motionPhase,
  reposToViews,
} from '@podium/client-core/viewmodels'
import type { AgentKind, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
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
import type { JSX } from 'react'
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
  buildFlightDeckRows,
  type CollapsedSummary,
  coordinatorCount,
  type FlightDeckMode,
  type FlightDeckRow,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  type OperationalState,
  operationalState,
  presenceNote,
  type PresenceNote,
  relationNote,
  waitingNote,
} from '@/lib/mission'

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full spine' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

/** One issue-depth step. Agent rows hang 32px in, so a child task strip lands
 *  LEFT of its parent's agent rows — issue depth reads as issue depth, and a
 *  session never looks like it is parenting the task below it. */
const DEPTH_STEP = 14
const AGENT_INDENT = 32

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
 * The row's operational state as a MARK plus a word.
 *
 * An earlier pass shipped the word alone, on the argument that every icon that
 * would fit here already means something else. The approved artifact disagrees
 * and it wins: on a spine of thirty strips the word is unreadable at a glance,
 * and a working row has no other motion of its own once its agent rows are
 * folded away. So the marks are drawn from what already carries meaning here —
 * the canonical braille spinner of the motion grammar for working, the amber
 * dot the whole app uses for "asking something of you" — rather than invented.
 */
function StateMark({ state }: { state: OperationalState }): JSX.Element {
  // The spinner carries its own reserved working blue (`--motion-working`);
  // nothing here retints it.
  if (state === 'working') return <BrailleSpinner size={9} className="flex-none" />

  if (state === 'needs-you') {
    return (
      <span
        aria-hidden
        className="flex size-3 flex-none items-center justify-center rounded-full bg-attention text-[8px] font-bold leading-none text-attention-foreground"
      >
        !
      </span>
    )
  }
  if (state === 'waiting') return <Ban size={11} aria-hidden className="flex-none text-warning" />
  if (state === 'done') return <Check size={11} aria-hidden className="flex-none text-success" />
  if (state === 'moved') {
    return <ArrowRight size={11} aria-hidden className="flex-none text-text-dim" />
  }
  return <Hourglass size={10} aria-hidden className="flex-none text-text-faint" />
}

function StateLabel({
  row,
  byId,
}: {
  row: FlightDeckRow
  byId: ReadonlyMap<string, IssueNavigationModel>
}): JSX.Element {
  const value = operationalState(row.issue, row.sessions, byId)
  return (
    <span
      className="flex flex-none items-center gap-1.5"
      data-operational-state={value.state}
      title={value.label}
    >
      <StateMark state={value.state} />
      <span
        className={cn(
          'shell-type-micro truncate',
          value.state === 'needs-you'
            ? 'font-semibold text-attention'
            : value.state === 'waiting'
              ? 'font-mono text-warning'
              : 'text-text-dim',
        )}
      >
        {value.label}
      </span>
    </span>
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
function PresenceBand({
  note,
  indent,
}: {
  note: PresenceNote
  indent: number
}): JSX.Element {
  return (
    <div
      className={cn(
        'shell-type-micro flex min-h-[22px] items-center gap-2 rounded-r border-l-2 py-1 pr-2 pl-2 font-mono',
        note.attention
          ? 'border-attention/70 font-semibold text-attention'
          : note.kind === 'blocked'
            ? 'border-warning/50 text-warning'
            : 'border-border/60 text-text-dim',
      )}
      style={{ marginLeft: `${indent}px` }}
      data-presence={note.kind}
    >
      {note.kind === 'moved' && <ArrowRight size={11} aria-hidden className="flex-none" />}
      {note.kind === 'blocked' && <Ban size={11} aria-hidden className="flex-none" />}
      {note.kind === 'waiting' && <Hourglass size={10} aria-hidden className="flex-none" />}
      <span className="truncate">{note.text}</span>
    </div>
  )
}

function NativeRows({
  session,
  indent,
  onOpen,
}: {
  session: SessionMeta
  indent: number
  onOpen: () => void
}): JSX.Element | null {
  const native = session.agentState?.nativeSubagents ?? []
  const missing = Math.max(0, (session.agentState?.nativeSubagentCount ?? 0) - native.length)
  const rows = [
    ...native.map((agent) => ({ id: agent.id, type: agent.type ?? 'native agent' })),
    ...Array.from({ length: missing }, (_, index) => ({
      id: `native-${index + 1}`,
      type: 'native agent',
    })),
  ]
  if (rows.length === 0) return null
  return (
    <div
      className="border-l border-border/50 pl-0.5"
      style={{ marginLeft: `${indent}px` }}
      data-testid="flight-native-agents"
    >
      {rows.map((agent) => (
        <button
          data-pressable
          type="button"
          key={`${session.sessionId}:${agent.id}`}
          className="shell-type-micro flex w-full items-center gap-2 px-1.5 py-1 text-left text-text-dim hover:bg-muted hover:text-text-strong"
          onClick={onOpen}
          title={`Focus parent in Native · ${agent.id}`}
        >
          <CornerDownRight size={10} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{agent.type}</span>
          <span className="max-w-20 truncate font-mono opacity-70">{agent.id}</span>
        </button>
      ))}
    </div>
  )
}

function SessionRow({
  session,
  coordinator,
  active,
  indent,
  onOpen,
  onOpenNative,
}: {
  session: SessionMeta
  coordinator: boolean
  active: boolean
  indent: number
  onOpen: () => void
  onOpenNative: () => void
}): JSX.Element {
  const retired = session.archived || session.status === 'exited'
  const phase = motionPhase(session)
  // WorkerLabel already says "Handing over → <target>" mid-move, in the same
  // words the sidebar and the pane header use, so the row never invents a
  // second vocabulary for the same event.
  const state = retired
    ? 'Retired'
    : session.status === 'starting' || session.status === 'reconnecting'
      ? 'Starting'
      : undefined
  const since = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  return (
    <div
      className={cn('rounded-r border-l-2', active ? 'border-info/70 bg-muted' : 'border-border/60')}
      style={{ marginLeft: `${indent}px` }}
      data-flight-session={session.sessionId}
    >
      <button
        data-pressable
        type="button"
        className={cn(
          // One tier quieter than a task strip: the strips are the spine, the
          // agents working them are the roster (sidebar-common's row idiom).
          'group/session shell-type-secondary flex min-h-6 w-full items-center gap-2 rounded-r px-2 py-1 text-left text-text-dim hover:bg-muted hover:text-foreground',
          active && 'text-foreground',
          retired && 'opacity-60',
        )}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1">
          <WorkerLabel session={session} chip />
        </span>
        {coordinator && (
          <span
            className="shell-type-micro flex-none rounded border border-sky-500/50 bg-sky-500/10 px-1 font-semibold tracking-wide text-sky-600 uppercase dark:text-sky-400"
            data-testid="coordinator-badge"
            title="Coordinator session — drives this issue"
          >
            coord
          </span>
        )}
        {state ? (
          <span className="shell-type-micro flex-none text-text-dim">{state}</span>
        ) : (
          Number.isFinite(since) && (
            <PhaseTimer
              phase={phase}
              sinceMs={since}
              baseMs={session.agentState?.workingMsTotal ?? 0}
              mutedWaiting
            />
          )
        )}
      </button>
      <NativeRows session={session} indent={15} onOpen={onOpenNative} />
    </div>
  )
}

function TaskRow({
  row,
  byId,
  selected,
  activeSessionId,
  collapsed,
  onToggle,
  onSelectIssue,
  onSelectSession,
  onSelectNative,
}: {
  row: FlightDeckRow
  byId: ReadonlyMap<string, IssueNavigationModel>
  selected: boolean
  activeSessionId: string | null
  collapsed: boolean
  onToggle: () => void
  onSelectIssue: () => void
  onSelectSession: (session: SessionMeta) => void
  onSelectNative: (session: SessionMeta) => void
}): JSX.Element {
  const hasPayload = row.descendantIds.length > 0 || row.sessions.length > 0
  const indent = row.depth * DEPTH_STEP
  const bandIndent = AGENT_INDENT + indent
  // A dependency the operator can act on outlives the agent working the task:
  // an issue with live sessions AND an unfinished blocker says both.
  const waiting = row.sessions.length > 0 ? waitingNote(row.issue, byId) : null
  const presence = presenceNote(row.issue, row.sessions, byId)
  const relation = presence?.kind === 'moved' || waiting ? null : relationNote(row.issue, byId)
  return (
    <div data-flight-issue={row.issue.id}>
      <div
        className={cn(
          'group/task flex min-h-9 items-center gap-1 border-b border-hairline-soft pr-2',
          // The tint is carved INTO the engraved column, so it needs that base
          // — and its slate pair, so the mission still reads uncolored.
          selected
            ? 'issue-mix-28 issue-mix-slate-22 issue-base-engraved'
            : 'hover:bg-muted',
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {hasPayload ? (
          <button
            data-pressable
            type="button"
            className="flex size-5 flex-none items-center justify-center text-text-dim hover:text-text-strong"
            aria-label={collapsed ? `Expand ${row.issue.title}` : `Collapse ${row.issue.title}`}
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
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
          onClick={onSelectIssue}
        >
          <StageGlyph stage={row.issue.stage} size={13} />
          {/* Ref THEN title, in one truncating label: the ref is how the
              operator addresses the task everywhere else in Podium, and a
              right-aligned ref made the column read right-to-left. */}
          <span className="shell-type-primary min-w-0 flex-1 truncate font-medium">
            <span className="shell-type-micro mr-1.5 font-mono font-normal text-text-faint">
              {issueDisplayRef(row.issue)}
            </span>
            {row.issue.title}
          </span>
          {collapsed && hasPayload ? (
            <CollapsedPayload summary={row.collapsedSummary} />
          ) : (
            <StateLabel row={row} byId={byId} />
          )}
        </button>
      </div>
      {!collapsed && (
        <>
          {row.sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              coordinator={isCoordinatorSession(row.issue, session.sessionId)}
              active={activeSessionId === session.sessionId}
              indent={bandIndent}
              onOpen={() => onSelectSession(session)}
              onOpenNative={() => onSelectNative(session)}
            />
          ))}
          {waiting && (
            <PresenceBand
              note={{ kind: 'waiting', text: waiting, attention: false }}
              indent={bandIndent}
            />
          )}
          {presence && <PresenceBand note={presence} indent={bandIndent} />}
          {relation && (
            <div
              className="shell-type-micro flex items-center gap-1.5 py-0.5 pl-2 font-mono text-text-faint"
              style={{ marginLeft: `${bandIndent}px` }}
              data-testid="flight-relation-note"
            >
              <CornerDownRight size={10} aria-hidden />
              <span className="truncate">{relation}</span>
            </div>
          )}
        </>
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
  const needsCount = rows[0]?.actionableCount ?? 0
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
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="flight-deck-rows">
            {visibleRows.map((row) => (
              <TaskRow
                key={row.issue.id}
                row={row}
                byId={byId}
                selected={focused === row.issue.id}
                activeSessionId={activeSessionId}
                collapsed={collapsed.has(row.issue.id)}
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
