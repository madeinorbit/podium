import type { AgentKind, IssueWire, SessionMeta } from '@podium/protocol'
import { ChevronDown, ChevronRight, GitBranch, KanbanSquare, Plus, RotateCw } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  draftIssueLabel,
  lastUsedMaps,
  mostUrgentSession,
  panelLabel,
  partitionStaleSessions,
  partitionWorkItems,
  type RepoNavView,
  resolveDefaultAgent,
  sessionDotClass,
  sidebarSections,
  spawnTargetForRepo,
  type UnifiedWorkRow,
  unifiedWorkList,
} from './derive'
import { HostIndicators } from './HostIndicators'
import { STAGE_LABELS } from './issue-card'
import { StageGlyph } from './issue-glyphs'
import { isEpic } from './issue-hierarchy'
import { NewIssueDialog } from './NewIssueDialog'
import { NEW_AGENTS } from './NewPanelMenu'
import { CollapsibleSection, PanelRow, StaleSection, useCollapsed } from './Sidebar'
import { useStore } from './store'
import { useNow } from './useNow'

/** Icon component for an agent kind (shared with the "+" menu's agent list). */
function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}

/**
 * The UNIFIED sidebar (issue-as-workspace, behind the temporary layout
 * switcher): one status-ordered list of "pieces of work" — agent drafts,
 * human-origin issues, and unowned worktrees as SAME-LEVEL rows — topped by the
 * classic-styled `New <Agent> in <Repo>` button that spawns an agent into a
 * draft issue.
 */
export function SidebarUnified(): JSX.Element {
  const {
    repos,
    sessions,
    pins,
    setPinned,
    issues,
    trpc,
    selectedWorktree,
    setSelectedWorktree,
    selectedIssueId,
    setSelectedIssueId,
    paneA,
    setPane,
    view,
    setView,
  } = useStore()
  const now = useNow(60_000)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Anchor for the agent/repo menu: the WHOLE bordered button container, so the
  // dropdown opens directly under it, left-aligned, at the button's exact width
  // (the popup's w-(--anchor-width) tracks the Positioner anchor).
  const newAgentAnchorRef = useRef<HTMLDivElement | null>(null)
  // The user's persisted default agent ('auto' resolves against session history).
  const [agentSetting, setAgentSetting] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void trpc.settings.get
      .query()
      .then((s) => {
        if (alive) setAgentSetting(s.sessionDefaults.agent)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trpc])

  const sections = sidebarSections(repos, sessions, pins, now, issues)
  const { byRepo } = lastUsedMaps(sections, sessions)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  // <Repo> on the button = the repo of the most recent session activity.
  const defaultRepo = repoNavs.reduce<RepoNavView | undefined>(
    (best, r) =>
      best === undefined || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best,
    undefined,
  )
  // The spawn target is always the repo's OWN primary worktree; the label is
  // the registered repo name (never a clone or worktree basename).
  const defaultTarget = defaultRepo ? spawnTargetForRepo(defaultRepo) : undefined
  const defaultAgent = resolveDefaultAgent(agentSetting, sessions)
  // Menu repos read most-recently-used first (name tiebreak) — same order the
  // default <Repo> pick uses, so the top menu entry IS the default.
  const menuRepos = [...repoNavs].sort(
    (a, b) =>
      (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
  const allWorktreePaths = repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  const workRows = unifiedWorkList(sections, issues, sessions, allWorktreePaths, now)
  const workItems = partitionWorkItems(sessions, new Set(pins.panels), now)

  // A just-spawned draft session: once its broadcast lands with the server-minted
  // draft issueId, select that issue row (the id isn't known synchronously).
  const pendingSelect = useRef<string | null>(null)
  useEffect(() => {
    const sid = pendingSelect.current
    if (!sid) return
    const s = sessions.find((x) => x.sessionId === sid)
    if (s?.issueId) {
      setSelectedIssueId(s.issueId)
      pendingSelect.current = null
    }
  }, [sessions, setSelectedIssueId])

  /** Spawn `agentKind` in `repo`'s primary worktree inside a fresh draft issue. */
  async function spawn(agentKind: AgentKind, repo: RepoNavView): Promise<void> {
    const { worktree: wt } = spawnTargetForRepo(repo)
    const { sessionId } = await trpc.sessions.create.mutate({
      agentKind,
      cwd: wt.path,
      draftIssue: { repoPath: wt.repoPath },
      ...(wt.machineId ? { machineId: wt.machineId } : {}),
    })
    pendingSelect.current = sessionId
    // Same post-create plumbing as NewPanelMenu consumers: select + open.
    setSelectedWorktree(wt.path)
    setPane('A', sessionId)
    setView('workspace')
  }

  /** Persist a menu-picked agent as the new default (sessionDefaults.agent).
   *  'shell' isn't a valid session default — a shell pick spawns but doesn't
   *  change the sticky default. */
  async function persistDefaultAgent(kind: AgentKind): Promise<void> {
    if (kind === 'shell') return
    try {
      const current = await trpc.settings.get.query()
      const updated = await trpc.settings.set.mutate({
        ...current,
        sessionDefaults: { ...current.sessionDefaults, agent: kind },
      })
      setAgentSetting(updated.sessionDefaults.agent)
    } catch {
      setAgentSetting(kind) // optimistic — best-effort persistence
    }
  }

  const selectIssue = (issue: IssueWire) => {
    setSelectedIssueId(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    setView('workspace')
  }
  const selectPanelForIssue = (issue: IssueWire, sessionId: string) => {
    selectIssue(issue)
    setPane('A', sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    setView('workspace')
  }

  return (
    <>
      {/* The one top row: `New <Agent> in <Repo>` wearing the classic Superagent
          button's clothes (main surface spawns; the chevron segment opens the
          agent→repo menu) + the `+` (new issue) button. */}
      <div className="mx-3 mt-2.5 flex items-center gap-2">
        <div
          ref={newAgentAnchorRef}
          data-testid="new-agent-button"
          className="relative min-w-0 flex-1"
        >
          {/* EXACT classic Superagent-button clothes: one bordered rounded-md
              surface, bg-secondary, leading icon, no inner segments. The chevron
              is a borderless hitbox floating inside the same outline. */}
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-md border border-input bg-secondary px-2.5 py-[7px] pr-8 text-[13px] text-foreground hover:border-primary hover:text-foreground disabled:opacity-50"
            disabled={!defaultRepo}
            title={
              defaultTarget
                ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultTarget.repoName}`
                : 'No repos yet'
            }
            onClick={() => defaultRepo && void spawn(defaultAgent, defaultRepo)}
          >
            {(() => {
              const AgentIcon = agentIconFor(defaultAgent)
              return AgentIcon ? <AgentIcon size={14} aria-hidden="true" /> : null
            })()}
            <span className="min-w-0 truncate">
              New {panelLabel(defaultAgent)} in {defaultTarget?.repoName ?? '…'}
            </span>
          </button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  aria-label="Choose agent and repo"
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              }
            />
            <DropdownMenuContent align="start" sideOffset={4} anchor={newAgentAnchorRef}>
              {NEW_AGENTS.map(({ kind, label, Icon }) => (
                <DropdownMenuSub key={kind}>
                  <DropdownMenuSubTrigger className="flex items-center gap-1.5">
                    <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
                    {label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {menuRepos.length === 0 && (
                      <DropdownMenuItem disabled>No repos</DropdownMenuItem>
                    )}
                    {menuRepos.map((repo) => (
                      <DropdownMenuItem
                        key={repo.path}
                        onClick={() => {
                          void persistDefaultAgent(kind)
                          void spawn(kind, repo)
                        }}
                      >
                        {repo.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* EXACT classic Concierge-button clothes: round, primary-filled. */}
        <button
          type="button"
          className="flex size-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          title="New issue"
          aria-label="New issue"
          onClick={() => setNewIssueOpen(true)}
        >
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>

      {/* App-surface nav: full-width links to the big non-workspace views. */}
      <div className="mx-3 mt-2 flex flex-col gap-0.5">
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            view === 'issues' && 'bg-secondary text-foreground',
          )}
          aria-pressed={view === 'issues'}
          onClick={() => setView('issues')}
        >
          <KanbanSquare size={15} aria-hidden="true" />
          Issues
        </button>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            view === 'automations' && 'bg-secondary text-foreground',
          )}
          aria-pressed={view === 'automations'}
          onClick={() => setView('automations')}
        >
          <RotateCw size={15} aria-hidden="true" />
          Automations
        </button>
      </div>

      <div className="mt-1 flex-1 overflow-y-auto pb-3">
        {/* PINNED stays; NEEDS YOUR ATTENTION / WORKING are gone — the WORK list
            below is status-ordered instead. */}
        {workItems.pinnedPanels.length > 0 && (
          <div className="min-w-0">
            <CollapsibleSection
              label="PINNED"
              storageKey="podium:sidebar:collapsed:pinned"
              count={workItems.pinnedPanels.length}
            >
              {workItems.pinnedPanels.map((session) => (
                <PanelRow
                  key={session.sessionId}
                  session={session}
                  pinned={true}
                  active={paneA === session.sessionId}
                  onSelect={() => selectPanel(session.cwd, session.sessionId)}
                  onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                />
              ))}
            </CollapsibleSection>
          </div>
        )}

        {/* ── WORK LIST: drafts + active human issues + with-session worktrees,
            one row design, ordered by aggregated child-session urgency. ── */}
        <div className="px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            WORK
          </span>
        </div>
        {workRows.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground/70">
            Nothing yet — start an agent or create an issue above.
          </div>
        )}
        {workRows.map((row) =>
          row.kind === 'issue' ? (
            <UnifiedIssueRow
              key={`issue:${row.issue.id}`}
              row={row}
              allWorktreePaths={allWorktreePaths}
              sessions={sessions}
              active={selectedIssueId === row.issue.id}
              paneA={paneA}
              now={now}
              onSelect={() => selectIssue(row.issue)}
              onSelectPanel={(sid) => selectPanelForIssue(row.issue, sid)}
              onPinned={(sid, p) => void setPinned('panel', sid, p)}
            />
          ) : (
            <UnifiedWorktreeRow
              key={`wt:${row.worktree.path}`}
              row={row}
              active={selectedIssueId === null && selectedWorktree === row.worktree.path}
              paneA={paneA}
              now={now}
              onSelect={() => selectWorktree(row.worktree.path)}
              onSelectPanel={(sid) => selectPanel(row.worktree.path, sid)}
              onPinned={(sid, p) => void setPinned('panel', sid, p)}
            />
          ),
        )}
      </div>
      <HostIndicators />
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </>
  )
}

/**
 * The shared WORK-row skeleton: [chevron?][icon][title][right status summary].
 * Agent drafts, issues, and worktrees all render through this — they differ only
 * in their leading icon and right-side extras. `expandable` gates the chevron;
 * `dotSession` (most urgent child) drives the right-side status dot.
 */
function UnifiedRowShell({
  icon,
  label,
  active,
  expandable,
  collapsed,
  onToggle,
  onSelect,
  dotSession,
  extras,
  children,
  testId,
}: {
  icon: ReactNode
  label: string
  active: boolean
  expandable: boolean
  collapsed: boolean
  onToggle: () => void
  onSelect: () => void
  dotSession: SessionMeta | undefined
  extras?: ReactNode
  children?: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="flex min-w-0 items-stretch">
        {expandable ? (
          <button
            type="button"
            className="flex-none px-1 text-muted-foreground/60 hover:text-foreground"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? (
              <ChevronRight size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="flex-none px-1">
            <ChevronRight size={12} className="invisible" aria-hidden="true" />
          </span>
        )}
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-sm',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          onClick={onSelect}
        >
          {icon}
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {label}
          </span>
          {extras}
          {/* Right-side status summary: the most urgent child's dot, so the user
              can see WHY the row floats where it does. */}
          {dotSession && <span className={sessionDotClass(dotSession)} />}
        </button>
      </div>
      {!collapsed && children}
    </div>
  )
}

/**
 * One issue row in the unified WORK LIST. Agent drafts (draft issue whose only
 * content is agents, no worktree) are a SINGLE line — agent icon, session title,
 * click opens the session directly. Real issues show the stage glyph and expand
 * (default expanded) to their member sessions.
 */
function UnifiedIssueRow({
  row,
  sessions: _all,
  allWorktreePaths,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
  onPinned,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'issue' }>
  sessions: SessionMeta[]
  allWorktreePaths: string[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
}): JSX.Element {
  const { issue, sessions: mine } = row
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-issue:${issue.id}`, false)
  const { visible, stale } = partitionStaleSessions(mine, now)
  const urgent = mostUrgentSession(mine, now)
  // Draft vessel whose only content is agents → a single session-like line.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
  const AgentIcon = draftAgentOnly ? agentIconFor(mine[0]?.agentKind ?? 'claude-code') : undefined
  const label = issue.draft ? draftIssueLabel(issue, _all, allWorktreePaths) : issue.title
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
    />
  )
  if (draftAgentOnly) {
    const first = mine[0]
    return (
      <UnifiedRowShell
        testId="unified-issue-row"
        icon={
          AgentIcon ? (
            <AgentIcon size={13} aria-hidden="true" className="flex-none text-muted-foreground" />
          ) : (
            <StageGlyph stage={issue.stage} size={13} />
          )
        }
        label={label}
        active={active && paneA === first?.sessionId}
        expandable={false}
        collapsed={true}
        onToggle={() => {}}
        // A draft is just its agent — clicking the row opens the session itself.
        onSelect={() => (first ? onSelectPanel(first.sessionId) : onSelect())}
        dotSession={urgent}
      />
    )
  }
  return (
    <UnifiedRowShell
      testId="unified-issue-row"
      icon={<StageGlyph stage={issue.stage} size={13} />}
      label={label}
      active={active}
      expandable={mine.length > 0}
      collapsed={mine.length === 0 ? true : collapsed}
      onToggle={toggle}
      onSelect={onSelect}
      dotSession={urgent}
      extras={
        <>
          {isEpic(issue) && (
            <span className="flex-none rounded border border-violet-500/50 px-1 text-[9px] leading-4 text-violet-600 dark:text-violet-400">
              epic
            </span>
          )}
          {issue.childCount > 0 && (
            <span className="flex-none text-[10px] text-muted-foreground/70 tabular-nums">
              {issue.childDoneCount}/{issue.childCount}
            </span>
          )}
          {!issue.draft && (
            <span className="flex flex-none items-center gap-1 text-[10px] text-muted-foreground">
              {STAGE_LABELS[issue.stage]}
            </span>
          )}
        </>
      }
    >
      {visible.map(renderRow)}
      <StaleSection sessions={stale} render={renderRow} />
    </UnifiedRowShell>
  )
}

/** A with-session worktree owned by no issue — same row skeleton, branch icon. */
function UnifiedWorktreeRow({
  row,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
  onPinned,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'worktree' }>
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
}): JSX.Element {
  const { worktree } = row
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-wt:${worktree.path}`, false)
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
    />
  )
  return (
    <UnifiedRowShell
      testId="unified-worktree-row"
      icon={<GitBranch size={13} aria-hidden="true" className="flex-none text-muted-foreground" />}
      label={worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path}
      active={active}
      expandable
      collapsed={collapsed}
      onToggle={toggle}
      onSelect={onSelect}
      dotSession={mostUrgentSession(worktree.sessions, now)}
      extras={
        worktree.isMain ? (
          <span className="rounded border border-input px-1 text-[10px] uppercase text-muted-foreground">
            main
          </span>
        ) : undefined
      }
    >
      {visible.map(renderRow)}
      <StaleSection sessions={stale} render={renderRow} />
    </UnifiedRowShell>
  )
}
