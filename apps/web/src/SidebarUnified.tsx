import type { AgentKind, IssueWire, SessionMeta } from '@podium/protocol'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  GitBranch,
  KanbanSquare,
  Pin,
  Plus,
  RotateCw,
} from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
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
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  draftIssueLabel,
  groupUnifiedWorkRows,
  issueReturnedFromDefer,
  lastUsedMaps,
  machinesWithRepo,
  mostUrgentSession,
  panelLabel,
  partitionStaleSessions,
  partitionUnifiedWork,
  partitionWorkItems,
  pickPaneSession,
  type RepoNavView,
  resolveDefaultAgent,
  resolveTargetMachine,
  sessionDotClass,
  sessionsForIssueNav,
  sessionsForWorktree,
  sidebarSections,
  spawnTargetForRepo,
  type UnifiedWorkRow,
  type WorkingEntry,
} from './derive'
import { HostIndicators } from './HostIndicators'
import { IssueContextMenu } from './IssueContextMenu'
import { IssueStatusIcon } from './IssueStatusIcon'
import { isEpic } from './issue-hierarchy'
import { NewIssueDialog } from './NewIssueDialog'
import { NEW_AGENTS } from './NewPanelMenu'
import type { ContextMenuAnchor } from './SessionContextMenu'
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
    setOpenIssueId,
    paneA,
    setPane,
    fileTabs,
    view,
    setView,
    sidebarSettings,
    setSidebarSettings,
    machines,
    spawnDraftAgent,
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
  // The spawn target is the repo's primary checkout on the default machine
  // (MRU for this repo, then first online machine with the repo).
  const defaultMachine = defaultRepo
    ? resolveTargetMachine(defaultRepo, sessions, machines)
    : undefined
  const defaultTarget = defaultRepo ? spawnTargetForRepo(defaultRepo, defaultMachine) : undefined
  const defaultAgent = resolveDefaultAgent(agentSetting, sessions)
  // Menu repos read most-recently-used first (name tiebreak) — same order the
  // default <Repo> pick uses, so the top menu entry IS the default.
  const menuRepos = [...repoNavs].sort(
    (a, b) =>
      (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
  const allWorktreePaths = repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  // WORKING (move-out) + the WORK list minus whatever moved to WORKING.
  const { working, work } = partitionUnifiedWork(sections, issues, sessions, allWorktreePaths, now)
  const workItems = partitionWorkItems(sessions, new Set(pins.panels), now)

  /** Spawn `agentKind` in `repo`'s primary worktree inside a fresh draft issue.
   *  Optimistic (#119): the store paints the 'starting' row + draft vessel
   *  instantly, so we navigate synchronously with the client-minted ids — no
   *  waiting on the create round-trip or its broadcast. */
  function spawn(agentKind: AgentKind, repo: RepoNavView, machineId?: string): void {
    const targetMachine = machineId ?? resolveTargetMachine(repo, sessions, machines)
    const { worktree: wt } = spawnTargetForRepo(repo, targetMachine)
    const { sessionId, issueId } = spawnDraftAgent({ target: wt, agentKind })
    setSelectedIssueId(issueId)
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
    // A lapsed defer is transient like the session snooze: interacting with the
    // "Unsnoozed" issue clears the stale defer so the tag doesn't linger. (A
    // still-snoozed issue is left alone.) No dedicated undefer route — defer(null)
    // is the clear, matching the context menu's "Undefer".
    if (issueReturnedFromDefer(issue, now)) {
      void trpc.issues.defer.mutate({ id: issue.id, until: null }).catch(() => {})
    }
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    // Open a pane too (#108): keep the current one if it already belongs to this
    // issue (session or file tab), else the issue's most recently active session.
    const members = sessionsForIssueNav(issue, sessions, allWorktreePaths, {
      includeShells: true,
    })
    const rowFileIds = issue.worktreePath
      ? fileTabs.filter((f) => f.worktreePath === issue.worktreePath).map((f) => f.id)
      : []
    setPane('A', pickPaneSession(members, paneA, rowFileIds))
    setView('workspace')
  }
  const selectPanelForIssue = (issue: IssueWire, sessionId: string) => {
    selectIssue(issue)
    setPane('A', sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    // Same pane-opening rule as selectIssue, keyed by the worktree's sessions.
    const members = sessionsForWorktree(sessions, path, allWorktreePaths)
    const rowFileIds = fileTabs.filter((f) => f.worktreePath === path).map((f) => f.id)
    setPane('A', pickPaneSession(members, paneA, rowFileIds))
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    setView('workspace')
  }
  // Open the issue PAGE (the right-click "Open" action), leaving the workspace.
  const openIssuePage = (id: string) => {
    setOpenIssueId(id)
    setView('issues')
  }

  // One WORK/WORKING row (issue or unowned worktree), shared by both sections.
  const renderWorkRow = (row: UnifiedWorkRow) =>
    row.kind === 'issue' ? (
      <UnifiedIssueRow
        key={`issue:${row.issue.id}`}
        row={row}
        allWorktreePaths={allWorktreePaths}
        sessions={sessions}
        issues={issues}
        active={selectedIssueId === row.issue.id}
        paneA={paneA}
        now={now}
        onSelect={() => selectIssue(row.issue)}
        onSelectPanel={(sid) => selectPanelForIssue(row.issue, sid)}
        onPinned={(sid, p) => void setPinned('panel', sid, p)}
        onOpenIssue={openIssuePage}
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
    )
  // A WORKING entry: a lifted individual session renders as a PanelRow (like
  // PINNED); a fully-working issue/worktree renders as its normal row.
  const renderWorkingEntry = (entry: WorkingEntry) => {
    if (entry.kind === 'session') {
      const s = entry.session
      return (
        <PanelRow
          key={`working:${s.sessionId}`}
          session={s}
          pinned={pins.panels.includes(s.sessionId)}
          active={paneA === s.sessionId}
          onSelect={() => selectPanel(s.cwd, s.sessionId)}
          onPinned={(p) => void setPinned('panel', s.sessionId, p)}
        />
      )
    }
    return renderWorkRow(entry.row)
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
                  <DropdownMenuSubTrigger
                    className="flex items-center gap-1.5"
                    onClick={() => {
                      if (!defaultRepo) return
                      void persistDefaultAgent(kind)
                      void spawn(kind, defaultRepo)
                    }}
                  >
                    <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
                    {label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {menuRepos.length === 0 && (
                      <DropdownMenuItem disabled>No repos</DropdownMenuItem>
                    )}
                    {menuRepos.map((repo) => {
                      const repoMachines = machinesWithRepo(repo, machines)
                      if (repoMachines.length <= 1) {
                        return (
                          <DropdownMenuItem
                            key={repo.path}
                            onClick={() => {
                              void persistDefaultAgent(kind)
                              void spawn(kind, repo)
                            }}
                          >
                            {repo.name}
                          </DropdownMenuItem>
                        )
                      }
                      return (
                        <DropdownMenuSub key={repo.path}>
                          <DropdownMenuSubTrigger
                            onClick={() => {
                              void persistDefaultAgent(kind)
                              void spawn(kind, repo)
                            }}
                          >
                            {repo.name}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {repoMachines.map((machine) => (
                              <DropdownMenuItem
                                key={machine.id}
                                disabled={!machine.online}
                                onClick={() => {
                                  void persistDefaultAgent(kind)
                                  void spawn(kind, repo, machine.id)
                                }}
                              >
                                <Circle
                                  size={6}
                                  className={
                                    machine.online
                                      ? 'fill-emerald-500 text-emerald-500'
                                      : 'text-muted-foreground/40'
                                  }
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                  {machine.name}
                                </span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )
                    })}
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
        {/* WORKING — fully-working issues/worktrees and working sessions lifted
            out of partially-working rows; everything here is REMOVED from WORK. */}
        {working.length > 0 && (
          <div className="min-w-0">
            <CollapsibleSection
              label="WORKING"
              storageKey="podium:sidebar:collapsed:working"
              count={working.length}
            >
              {working.map(renderWorkingEntry)}
            </CollapsibleSection>
          </div>
        )}

        {/* PINNED — pinned session panels. */}
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
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            WORK
          </span>
          <Select
            value={sidebarSettings.groupByRepo ? 'repo' : 'none'}
            onValueChange={(v) => void setSidebarSettings({ groupByRepo: v === 'repo' })}
          >
            <SelectTrigger
              aria-label="Group work list"
              className="h-5 w-auto gap-1 border-0 px-1 text-[10px] text-muted-foreground/70 shadow-none hover:text-foreground focus:ring-0"
            >
              {/* Render the human label, not the raw enum value — Base UI's
                  SelectValue shows the bare `value` otherwise. */}
              <span>{sidebarSettings.groupByRepo ? 'Group: repo' : 'Group: none'}</span>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="none" className="text-xs">
                Group: none
              </SelectItem>
              <SelectItem value="repo" className="text-xs">
                Group: repo
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {work.length === 0 && working.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground/70">
            Nothing yet — start an agent or create an issue above.
          </div>
        )}
        {(() => {
          if (!sidebarSettings.groupByRepo) return work.map(renderWorkRow)
          return groupUnifiedWorkRows(work).map((group) => (
            <CollapsibleSection
              key={group.key}
              label={group.label}
              storageKey={`podium:sidebar:unified-repo:${group.key}`}
              count={group.rows.length}
            >
              {group.rows.map(renderWorkRow)}
            </CollapsibleSection>
          ))
        })()}
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
  onContextMenu,
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
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
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
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pr-3 text-left text-sm',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          onClick={onSelect}
          onContextMenu={onContextMenu}
        >
          {icon}
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {label}
          </span>
          {extras}
          {/* Right-side status summary: the most urgent child's dot, so the user
              can see WHY the row floats where it does. Expanded child rows show
              their own (smaller) dots vertically aligned under this one. */}
          {dotSession && <span className={sessionDotClass(dotSession)} />}
        </button>
      </div>
      {/* Child agent rows: pulled up against the parent (tight margin) so the
          group visually reads as one unit. */}
      {!collapsed && <div className="-mt-1.5 pb-1">{children}</div>}
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
  issues,
  allWorktreePaths,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
  onPinned,
  onOpenIssue,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'issue' }>
  sessions: SessionMeta[]
  /** Whole issue list — the context menu's label pool / duplicate targets. */
  issues: IssueWire[]
  allWorktreePaths: string[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
  /** Open the issue PAGE (the context menu's "Open"). */
  onOpenIssue: (id: string) => void
}): JSX.Element {
  const { issue, sessions: mine } = row
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-issue:${issue.id}`, false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  // A single agent underneath = nothing worth a second line: the parent row's
  // dot IS that agent's indicator. Child rows only exist from 2 agents up.
  const showChildren = mine.length >= 2
  const { visible, stale } = partitionStaleSessions(mine, now)
  const urgent = mostUrgentSession(mine, now)
  // Draft vessel whose only content is agents → a single session-like line.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
  const AgentIcon = draftAgentOnly ? agentIconFor(mine[0]?.agentKind ?? 'claude-code') : undefined
  const label = issue.draft ? draftIssueLabel(issue, _all, allWorktreePaths) : issue.title
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    setMenuAnchor({ x: e.clientX, y: e.clientY })
  }
  // The right-click menu (mirrors the board / SessionContextMenu pattern):
  // cursor-anchored portal, acts on this one issue, rendered alongside the row.
  const menu = menuAnchor ? (
    <IssueContextMenu
      issues={[issue]}
      allIssues={issues}
      anchor={menuAnchor}
      onClose={() => setMenuAnchor(null)}
      onOpen={(id) => {
        setMenuAnchor(null)
        onOpenIssue(id)
      }}
    />
  ) : null
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
      dotRight
    />
  )
  if (draftAgentOnly) {
    const first = mine[0]
    return (
      <>
        <UnifiedRowShell
          testId="unified-issue-row"
          icon={
            AgentIcon ? (
              <AgentIcon size={13} aria-hidden="true" className="flex-none text-muted-foreground" />
            ) : (
              <IssueStatusIcon stage={issue.stage} size={16} />
            )
          }
          label={label}
          active={active && paneA === first?.sessionId}
          expandable={false}
          collapsed={true}
          onToggle={() => {}}
          // A draft is just its agent — clicking the row opens the session itself.
          onSelect={() => (first ? onSelectPanel(first.sessionId) : onSelect())}
          onContextMenu={onContextMenu}
          dotSession={urgent}
        />
        {menu}
      </>
    )
  }
  return (
    <>
      <UnifiedRowShell
        testId="unified-issue-row"
        // Neutral leading glyph: a task icon with the stage demoted to a corner
        // badge, so a real issue row doesn't read as a distracting stage colour.
        icon={<IssueStatusIcon stage={issue.stage} size={16} />}
        label={label}
        active={active}
        expandable={showChildren}
        collapsed={showChildren ? collapsed : true}
        onToggle={toggle}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        dotSession={urgent}
        extras={
          <>
            {issue.pinned && (
              <Pin size={11} className="flex-none text-muted-foreground" aria-hidden="true" />
            )}
            {issueReturnedFromDefer(issue, now) && (
              <span
                className="flex-none rounded border border-amber-500/40 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                title="Snooze ended — back in your queue"
              >
                Unsnoozed
              </span>
            )}
            {isEpic(issue) && (
              <span className="flex-none rounded border border-violet-500/50 px-1 text-[9px] leading-4 text-violet-600 dark:text-violet-400">
                epic
              </span>
            )}
          </>
        }
      >
        {visible.map(renderRow)}
        <StaleSection sessions={stale} render={renderRow} />
      </UnifiedRowShell>
      {menu}
    </>
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
  // A single agent underneath = nothing worth a second line: the parent row's
  // dot IS that agent's indicator. Child rows only exist from 2 agents up.
  const showChildren = worktree.sessions.length >= 2
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
      dotRight
    />
  )
  return (
    <UnifiedRowShell
      testId="unified-worktree-row"
      icon={<GitBranch size={13} aria-hidden="true" className="flex-none text-muted-foreground" />}
      label={worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path}
      active={active}
      expandable={showChildren}
      collapsed={showChildren ? collapsed : true}
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
