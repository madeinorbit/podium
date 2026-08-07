import { shallowEqual } from '@podium/client-core/store'
import {
  isCoordinatorSession,
  type IssueNavigationModel,
  motionPhase,
  reposToViews,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, Users } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useReplicaIssues, useStoreSelector } from './store'
import { Button } from '@/components/ui/button'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { PhaseTimer } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import {
  buildFlightDeckRows,
  coordinatorCount,
  type FlightDeckMode,
  type FlightDeckRow,
  missionProgress,
  missionRootFor,
  operationalState,
} from '@/lib/mission'

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

/** Meters are Accent Blue data on the secondary surface (DESIGN.md §5) — the
 *  yellow is reserved for the thing asking something of you. */
function ProgressBar({ done, total, percent }: ReturnType<typeof missionProgress>): JSX.Element {
  return (
    <div className="mt-3 flex items-center gap-2.5" aria-label={`${done} of ${total} tasks done`}>
      <div className="h-[3.5px] flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-info transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shell-type-micro font-mono tabular-nums text-text-dim">
        {done}/{total}
      </span>
    </div>
  )
}

/**
 * The row's operational state as a WORD, not an invented glyph. Every icon that
 * would fit here already means something else in this app — CircleDot is the
 * Task panel, Play is "run now", Archive is the archive action — and the two
 * states that do have canonical motion already carry it elsewhere in the row:
 * working shows the braille spinner on its session rows, done shows the filled
 * StageGlyph. Stillness is the signal (DESIGN.md §5).
 */
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
      className={cn(
        'shell-type-micro flex-none truncate',
        value.state === 'needs-you'
          ? 'font-semibold text-attention'
          : value.state === 'waiting'
            ? 'font-mono text-text-dim'
            : 'text-text-dim',
      )}
      data-operational-state={value.state}
      title={value.label}
    >
      {value.label}
    </span>
  )
}

function NativeRows({ session, onOpen }: { session: SessionMeta; onOpen: () => void }): JSX.Element {
  const native = session.agentState?.nativeSubagents ?? []
  const missing = Math.max(0, (session.agentState?.nativeSubagentCount ?? 0) - native.length)
  const rows = [
    ...native.map((agent) => ({ id: agent.id, type: agent.type ?? 'native agent' })),
    ...Array.from({ length: missing }, (_, index) => ({
      id: `native-${index + 1}`,
      type: 'native agent',
    })),
  ]
  if (rows.length === 0) return <></>
  return (
    <div className="ml-5 border-l border-border/50 pl-0.5" data-testid="flight-native-agents">
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
  onOpen,
  onOpenNative,
}: {
  session: SessionMeta
  coordinator: boolean
  active: boolean
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
    <div className="ml-3 border-l border-border/50 pl-0.5" data-flight-session={session.sessionId}>
      <button
        data-pressable
        type="button"
        className={cn(
          // One tier quieter than a task strip: the strips are the spine, the
          // agents working them are the roster (sidebar-common's row idiom).
          'group/session shell-type-secondary flex min-h-6 w-full items-center gap-2 rounded px-2 py-1 text-left text-text-dim hover:bg-muted hover:text-foreground',
          active && 'bg-muted text-foreground',
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
      <NativeRows session={session} onOpen={onOpenNative} />
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
  const hiddenCount = row.descendantIds.length
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
        style={{ paddingLeft: `${8 + row.depth * 16}px` }}
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
          <span className="shell-type-primary min-w-0 flex-1 truncate font-medium">
            {row.issue.title}
          </span>
          <span className="shell-type-micro font-mono text-text-faint">
            {issueDisplayRef(row.issue)}
          </span>
          <StateLabel row={row} byId={byId} />
        </button>
      </div>
      {collapsed && hasPayload ? (
        <button
          data-pressable
          type="button"
          className="shell-type-micro flex w-full items-center gap-2 border-b border-hairline-soft py-1.5 pr-3 text-left font-mono text-text-dim hover:bg-muted"
          style={{ paddingLeft: `${36 + row.depth * 16}px` }}
          onClick={onToggle}
          data-testid="flight-collapse-payload"
        >
          <span>{hiddenCount} task{hiddenCount === 1 ? '' : 's'} hidden</span>
          <span>·</span>
          <span>{row.liveAgentCount} live</span>
          {row.actionableCount > 0 && (
            <>
              <span>·</span>
              <span className="font-semibold text-attention">{row.actionableCount} need you</span>
            </>
          )}
        </button>
      ) : (
        row.sessions.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            coordinator={isCoordinatorSession(row.issue, session.sessionId)}
            active={activeSessionId === session.sessionId}
            onOpen={() => onSelectSession(session)}
            onOpenNative={() => onSelectNative(session)}
          />
        ))
      )}
    </div>
  )
}

export function FlightDeck({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const {
    sessions,
    repos,
    selectedIssueId,
    paneA,
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
  const [mode, setMode] = useState<FlightDeckMode>('full')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const root = missionRootFor(issues, selectedIssueId)
  const rows = useMemo(
    () => (root ? buildFlightDeckRows(issues, sessions, root.id, mode, allWorktreePaths) : []),
    [issues, sessions, root, mode, allWorktreePaths],
  )
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues])
  // A focus pointing outside this mission (left over from the one you just
  // navigated away from) resolves to the root, so a row is always highlighted.
  const focused = resolveFocus(
    focusedIssueId,
    new Set(rows.map((row) => row.issue.id)),
    root?.id,
  )
  const progress = missionProgress(rows)
  const leadCount = coordinatorCount(rows, sessions)
  const liveCount = rows[0]?.liveAgentCount ?? 0
  const needsCount = rows[0]?.actionableCount ?? 0
  const hiddenByAncestor = new Set<string>()
  for (const row of rows) {
    if (!collapsed.has(row.issue.id)) continue
    for (const id of row.descendantIds) hiddenByAncestor.add(id)
  }
  const visibleRows = rows.filter((row) => !hiddenByAncestor.has(row.issue.id))
  const rootSession = root ? rows[0]?.sessions[0] : sessions.find((session) => session.sessionId === paneA)
  const draftFilling = Boolean(root?.draft && rootSession)

  const selectIssue = (row: FlightDeckRow): void => {
    setFocusedIssueId(row.issue.id)
    void markIssueRead(row.issue.id)
    if (row.issue.worktreePath) setSelectedWorktree(row.issue.worktreePath)
    const active = row.sessions.filter((session) => !session.archived && session.status !== 'exited')
    const target =
      active.find((session) => session.sessionId === row.issue.coordinatorSessionId) ??
      active.find((session) => session.sessionId === paneA) ??
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
          <div className="flex-none border-b border-hairline-bar px-4 pt-4 pb-3.5">
            <div className="shell-type-micro font-mono text-text-faint">
              {issueDisplayRef(root)} {STAGE_LABELS[root.stage].toLowerCase()}
            </div>
            <h2 className="shell-type-reading mt-1 font-semibold tracking-[-0.01em] text-text-strong">
              {draftFilling ? sessionDisplayName(rootSession as SessionMeta) : root.title}
            </h2>
            <p className="shell-type-secondary mt-2 line-clamp-4 leading-[1.5] text-text-dim">
              {draftFilling
                ? drafts[rootSession?.sessionId ?? '']
                  ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
                  : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
                : root.description?.trim() ||
                  root.activityNotes?.trim() ||
                  'Mission work, agents, and dependencies in one live execution view.'}
            </p>
            <ProgressBar {...progress} />
            <div className="shell-type-micro mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-text-dim">
              <span>{liveCount} live</span>
              <span>
                {leadCount} coord{leadCount === 1 ? '' : 's'}
              </span>
              {needsCount > 0 && (
                <span className="font-semibold text-attention">{needsCount} need you</span>
              )}
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
                  'shell-type-micro h-6 rounded-md px-2 text-text-dim hover:bg-muted hover:text-text-strong',
                  mode === option.id && 'bg-muted font-semibold text-text-strong',
                  option.id === 'needs-you' && needsCount > 0 && 'text-attention',
                )}
                onClick={() => setMode(option.id)}
              >
                {option.label}
              </button>
            ))}
            <span className="shell-type-micro ml-auto inline-flex items-center gap-1 font-mono text-text-faint">
              <Users size={10} aria-hidden="true" /> {liveCount}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="flight-deck-rows">
            {visibleRows.map((row) => (
              <TaskRow
                key={row.issue.id}
                row={row}
                byId={byId}
                selected={focused === row.issue.id}
                activeSessionId={paneA}
                collapsed={collapsed.has(row.issue.id)}
                onToggle={() =>
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(row.issue.id)) next.delete(row.issue.id)
                    else next.add(row.issue.id)
                    return next
                  })
                }
                onSelectIssue={() => selectIssue(row)}
                onSelectSession={(session) => selectSession(row, session)}
                onSelectNative={(session) => selectSession(row, session, true)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 text-center">
          <Users size={18} className="text-text-faint" aria-hidden="true" />
          <h2 className="shell-type-reading mt-3 font-semibold text-text-strong">
            Start with a chat
          </h2>
          <p className="shell-type-secondary mt-1.5 max-w-64 leading-relaxed text-text-dim">
            Open a normal agent session and describe what you need. Its live mission canvas will
            appear here without asking you to create a task first.
          </p>
        </div>
      )}
    </aside>
  )
}
