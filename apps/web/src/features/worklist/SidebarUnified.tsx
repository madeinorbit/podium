import { shallowEqual } from '@podium/client-core/store'
import { type AgentKind, type IssueWire, issueDisplayRef, type SessionMeta } from '@podium/protocol'
import type { IssueColorSlot } from '@podium/domain'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import {
  AlarmClock,
  BarChart3,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderPlus,
  GitBranch,
  Home,
  KanbanSquare,
  ListChecks,
  type LucideIcon,
  Pin,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { NEW_AGENTS } from '@/app/NewPanelMenu'
import { useStoreSelector } from '@/app/store'
import { IdSquare, type IdSquareState } from '@/components/IdSquare'
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
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/features/issues/issue-card'
import { isEpic } from '@/features/issues/issue-hierarchy'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import {
  agentBadge,
  draftIssueLabel,
  groupUnifiedWorkRows,
  isIssueSnoozed,
  isSessionWorking,
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
  rowUnreadEmphasized,
  sessionDotClass,
  sessionsForIssueNav,
  sessionsForWorktree,
  sidebarSections,
  spawnTargetForRepo,
  type UnifiedWorkRow,
  type WorkingEntry,
} from '@/lib/derive'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor } from '@/lib/WorkerLabel'
import {
  CollapsibleSection,
  GroupedSessionRows,
  PanelRow,
  StaleSection,
  useCollapsed,
} from './sidebar-common'
import { AgoStamp, WorkingTimer, workingSinceMs } from './time-indicators'

/** Icon component for an agent kind (shared with the "+" menu's agent list). */
function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}

/**
 * The UNIFIED sidebar (issue-as-workspace): the `New <Agent> in <Repo>` spawn
 * row, the app-surface nav, and one status-ordered list of "pieces of work" —
 * agent drafts, human-origin issues, and unowned worktrees as SAME-LEVEL rows.
 *
 * The three pieces are exported separately because the mobile shell composes
 * them into its home view without the desktop nav column (#227).
 */
export function SidebarUnified(): JSX.Element {
  const { view, setView } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView }),
    shallowEqual,
  )
  const nav: { id: Parameters<typeof setView>[0]; label: string; Icon: LucideIcon }[] = [
    { id: 'home', label: 'Command center', Icon: Home },
    { id: 'issues', label: 'Issues', Icon: KanbanSquare },
    { id: 'workflows', label: 'Workflows', Icon: ListChecks },
    { id: 'specs', label: 'Specs', Icon: BookOpenText },
    { id: 'automations', label: 'Automations', Icon: RotateCw },
  ]
  return (
    <>
      <NewWorkRow />

      {/* App-surface nav: full-width links to the big non-workspace views.
          (The classic sidebar is gone — this is THE navigation now.) */}
      <div className="mx-2 flex flex-col gap-px">
        {nav.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={cn(
              'relative flex w-full items-center gap-[9px] rounded-md px-2 py-1.5 text-[13px] transition-colors',
              view === id
                ? 'bg-[#232330] font-medium text-[#f3f3f8]'
                : 'text-[#9a9aa8] hover:bg-[#20202a] hover:text-[#f3f3f8]',
            )}
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {view === id && (
              <span
                className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-[2px] bg-primary"
                aria-hidden="true"
              />
            )}
            <Icon
              size={15}
              aria-hidden="true"
              className={cn('flex-none', view === id && 'text-primary')}
            />
            {label}
          </button>
        ))}
      </div>

      <div className="scroll-none mt-2.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2.5">
        <WorkSections />
      </div>
      <AppToolsRow className="flex-none border-t border-[#1f1f27] px-2.5 py-[7px]" />
    </>
  )
}

/**
 * The one top row: `New <Agent> in <Repo>` wearing the classic Superagent
 * button's clothes (main surface spawns; the chevron segment opens the
 * agent→repo menu) + the `+` (new issue) button.
 */
export function NewWorkRow(): JSX.Element {
  const {
    repos,
    sessions,
    trpc,
    setSelectedWorktree,
    setSelectedIssueId,
    setPane,
    setView,
    machines,
    spawnDraftAgent,
    pins,
    issues,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions,
      trpc: s.trpc,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setPane: s.setPane,
      setView: s.setView,
      machines: s.machines,
      spawnDraftAgent: s.spawnDraftAgent,
      pins: s.pins,
      issues: s.issues,
    }),
    shallowEqual,
  )
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
        if (alive) setAgentSetting(resolveRole(s, 'coding').harness)
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

  /** Persist a menu-picked agent as the new default (roles.coding.accountId).
   *  'shell' isn't a valid session default — a shell pick spawns but doesn't
   *  change the sticky default. */
  async function persistDefaultAgent(kind: AgentKind): Promise<void> {
    if (kind === 'shell') return
    try {
      const current = await trpc.settings.get.query()
      const updated = await trpc.settings.set.mutate({
        ...current,
        roles: {
          ...current.roles,
          coding: { ...current.roles.coding, accountId: nativeAccountId(kind) },
        },
      })
      setAgentSetting(resolveRole(updated, 'coding').harness)
    } catch {
      setAgentSetting(kind) // optimistic — best-effort persistence
    }
  }

  return (
    <div className="mx-3 mt-3 mb-4 flex items-center gap-2">
      <div
        ref={newAgentAnchorRef}
        data-testid="new-agent-button"
        className="relative min-w-0 flex-1"
      >
        {/* One bordered rounded-lg surface with a leading Claude-clay agent icon;
            the chevron is a borderless hitbox floating inside the same outline. */}
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[#2f2f3a] bg-[#1e1e26] px-[11px] py-[9px] pr-[34px] text-[13px] font-medium text-[#eaeaf0] transition-colors hover:border-[#3a3a46] hover:bg-[#26262f] disabled:opacity-50"
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
            return AgentIcon ? (
              <AgentIcon
                size={14}
                aria-hidden="true"
                className={cn('flex-none', defaultAgent === 'claude-code' && 'text-claude')}
              />
            ) : null
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
                className="absolute top-1/2 right-[9px] flex size-6 -translate-y-1/2 items-center justify-center rounded text-[#7a7a86] hover:text-foreground"
                aria-label="Choose agent and repo"
              >
                <ChevronDown size={13} aria-hidden="true" />
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
                  {menuRepos.length === 0 && <DropdownMenuItem disabled>No repos</DropdownMenuItem>}
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
                                    ? 'fill-success text-success'
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
            {/* New issue lives in this menu now — the top row is a single control. */}
            <DropdownMenuItem onClick={() => setNewIssueOpen(true)}>
              <Plus size={14} aria-hidden="true" className="text-muted-foreground" />
              New issue…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </div>
  )
}

/** App-level tools: add repo, analytics, settings, search (the cmd-k palette). */
export function AppToolsRow({ className }: { className?: string }): JSX.Element {
  const { view, setView, setPaletteOpen } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView, setPaletteOpen: s.setPaletteOpen }),
    shallowEqual,
  )
  const [repoScanOpen, setRepoScanOpen] = useState(false)
  const btn = (active = false) =>
    cn(
      'flex h-[30px] flex-1 items-center justify-center rounded-[7px] text-[#7a7a86] transition-colors hover:bg-[#20202a] hover:text-[#f3f3f8]',
      active && 'bg-[#20202a] text-[#f3f3f8]',
    )
  return (
    <div className={cn('flex items-center gap-[3px]', className)}>
      <button
        type="button"
        className={btn()}
        title="Add repo"
        aria-label="Add repo"
        onClick={() => setRepoScanOpen(true)}
      >
        <FolderPlus size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn(view === 'usage')}
        aria-pressed={view === 'usage'}
        title="Usage & analytics"
        aria-label="Usage & analytics"
        onClick={() => setView('usage')}
      >
        <BarChart3 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn(view === 'settings')}
        aria-pressed={view === 'settings'}
        title="Settings"
        aria-label="Settings"
        onClick={() => setView('settings')}
      >
        <SettingsIcon size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn()}
        title="Search (⌘K)"
        aria-label="Search"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={15} aria-hidden="true" />
      </button>
      {repoScanOpen && (
        <RepoScanFlow
          onClose={() => setRepoScanOpen(false)}
          onDone={() => setRepoScanOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * WORKING + PINNED + the WORK list: drafts, active human issues, and
 * with-session worktrees as one row design, ordered by aggregated child-session
 * urgency. The caller owns the scroll container.
 */
export function WorkSections(): JSX.Element {
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
    setView,
    sidebarSettings,
    setSidebarSettings,
    markIssueRead,
    markSessionRead,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions,
      pins: s.pins,
      setPinned: s.setPinned,
      issues: s.issues,
      trpc: s.trpc,
      selectedWorktree: s.selectedWorktree,
      setSelectedWorktree: s.setSelectedWorktree,
      selectedIssueId: s.selectedIssueId,
      setSelectedIssueId: s.setSelectedIssueId,
      setOpenIssueId: s.setOpenIssueId,
      paneA: s.paneA,
      setPane: s.setPane,
      fileTabs: s.fileTabs,
      setView: s.setView,
      sidebarSettings: s.sidebarSettings,
      setSidebarSettings: s.setSidebarSettings,
      markIssueRead: s.markIssueRead,
      markSessionRead: s.markSessionRead,
    }),
    shallowEqual,
  )
  const now = useNow(60_000)
  const sections = sidebarSections(repos, sessions, pins, now, issues)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  const allWorktreePaths = repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  // WORKING (move-out) + the WORK list minus whatever moved to WORKING.
  const { working, work } = partitionUnifiedWork(sections, issues, sessions, allWorktreePaths, now)
  const workItems = partitionWorkItems(sessions, new Set(pins.panels), now)

  const selectIssue = (issue: IssueWire) => {
    setSelectedIssueId(issue.id)
    // Opening an issue marks IT read (email-style, #126): clear the row's unread
    // emphasis optimistically. Its member sessions keep their own unread until
    // each is opened. No-op when already read.
    void markIssueRead(issue.id)
    // A lapsed defer is transient like the session snooze: OPENING an "Unsnoozed"
    // issue clears the stale defer so the tag doesn't linger (email-read semantics).
    // This is the CLEAR path — deliberately defer(null), which nulls deferUntil so
    // `issueReturnedFromDefer` goes false. (It's distinct from the menu's "Unsnooze",
    // issues.undefer, which BACKDATES deferUntil to float the row to the top of WORK
    // WITH the tag — #133.) A still-snoozed issue is left alone.
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
    // Opening a specific member session marks THAT session read too (#126).
    void markSessionRead(sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    // Same pane-opening rule as selectIssue, keyed by the worktree's sessions.
    const members = sessionsForWorktree(sessions, path, allWorktreePaths)
    const rowFileIds = fileTabs.filter((f) => f.worktreePath === path).map((f) => f.id)
    const opened = pickPaneSession(members, paneA, rowFileIds)
    setPane('A', opened)
    // A worktree has no unread flag of its own — opening it opens one session, so
    // mark THAT session read (#126). Other unread sessions keep the row emphasized.
    if (opened && members.some((s) => s.sessionId === opened)) void markSessionRead(opened)
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    // Opening a session marks it read (#126).
    void markSessionRead(sessionId)
    setView('workspace')
  }
  // Open the issue PAGE (the right-click "Open" action), leaving the workspace.
  const openIssuePage = (id: string) => {
    setOpenIssueId(id)
    setView('issues')
  }

  // One WORK/WORKING row (issue or unowned worktree), shared by both sections.
  // `working` marks WORKING-section placement: it mutes the email-style unread
  // emphasis (#138 — active work isn't "new unseen work") and swaps the row's
  // time stamp from the relative "2h ago" to the live elapsed timer.
  const renderWorkRow = (row: UnifiedWorkRow, working = false) => {
    const suppressUnread = working
    const rowSessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
    const since = working ? workingSinceMs(rowSessions) : null
    const timeMeta = working ? (
      since !== null ? (
        <WorkingTimer sinceMs={since} />
      ) : undefined
    ) : (
      <AgoStamp atMs={row.activityAt} now={now} />
    )
    return row.kind === 'issue' ? (
      <UnifiedIssueRow
        key={`issue:${row.issue.id}`}
        row={row}
        allWorktreePaths={allWorktreePaths}
        sessions={sessions}
        issues={issues}
        active={selectedIssueId === row.issue.id}
        paneA={paneA}
        now={now}
        suppressUnread={suppressUnread}
        timeMeta={timeMeta}
        onSelect={() => selectIssue(row.issue)}
        onSelectPanel={(sid) => selectPanelForIssue(row.issue, sid)}
        onPinned={(sid, p) => void setPinned('panel', sid, p)}
        onOpenIssue={openIssuePage}
        onRename={(title) =>
          void trpc.issues.update.mutate({ id: row.issue.id, patch: { title } }).catch(() => {})
        }
        onColorChange={(color) => trpc.issues.update.mutate({ id: row.issue.id, patch: { color } })}
      />
    ) : (
      <UnifiedWorktreeRow
        key={`wt:${row.worktree.path}`}
        row={row}
        active={selectedIssueId === null && selectedWorktree === row.worktree.path}
        paneA={paneA}
        now={now}
        suppressUnread={suppressUnread}
        timeMeta={timeMeta}
        onSelect={() => selectWorktree(row.worktree.path)}
        onSelectPanel={(sid) => selectPanel(row.worktree.path, sid)}
        onPinned={(sid, p) => void setPinned('panel', sid, p)}
      />
    )
  }
  // A WORKING entry: a lifted individual session renders as a PanelRow (like
  // PINNED); a fully-working issue/worktree renders as its normal row. Everything
  // here suppresses unread emphasis (#138) — it's actively-in-progress work.
  const renderWorkingEntry = (entry: WorkingEntry) => {
    if (entry.kind === 'session') {
      const s = entry.session
      const since = workingSinceMs([s])
      return (
        <PanelRow
          key={`working:${s.sessionId}`}
          session={s}
          pinned={pins.panels.includes(s.sessionId)}
          active={paneA === s.sessionId}
          suppressUnread
          trailingMeta={since !== null ? <WorkingTimer sinceMs={since} /> : undefined}
          onSelect={() => selectPanel(s.cwd, s.sessionId)}
          onPinned={(p) => void setPinned('panel', s.sessionId, p)}
        />
      )
    }
    return renderWorkRow(entry.row, true)
  }

  return (
    <>
      {/* WORKING — fully-working issues/worktrees and working sessions lifted
          out of partially-working rows; these are REMOVED from WORK. Pinned
          issues are the exception: they mirror here and stay in WORK. */}
      {working.length > 0 && (
        <div className="min-w-0">
          <CollapsibleSection
            label="WORKING"
            storageKey="podium:sidebar:collapsed:working"
            count={working.length}
            right={
              <span className="ml-auto inline-flex flex-none items-center gap-1 text-[10.5px] text-[#6c6c78]">
                <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
                {sessions.filter(isSessionWorking).length} active
              </span>
            }
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
      <div className="flex items-center justify-between px-2 pt-3.5 pb-[5px]">
        <span className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-[#7a7a86]">
          WORK
        </span>
        <Select
          value={sidebarSettings.groupByRepo ? 'repo' : 'none'}
          onValueChange={(v) => void setSidebarSettings({ groupByRepo: v === 'repo' })}
        >
          <SelectTrigger
            aria-label="Group work list"
            className="h-5 w-auto gap-1 border-0 px-1 text-[10.5px] text-[#6c6c78] shadow-none hover:text-foreground focus:ring-0"
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
        if (!sidebarSettings.groupByRepo) return work.map((r) => renderWorkRow(r))
        return groupUnifiedWorkRows(work).map((group) => (
          <CollapsibleSection
            key={group.key}
            label={group.label}
            storageKey={`podium:sidebar:unified-repo:${group.key}`}
            count={group.rows.length}
          >
            {/* Wrap so Array.map's index isn't passed as `suppressUnread`. */}
            {group.rows.map((r) => renderWorkRow(r))}
          </CollapsibleSection>
        ))
      })()}
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
  iconInteractive = false,
  label,
  active,
  unread = false,
  expandable,
  collapsed,
  onToggle,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  dotSession,
  count,
  extras,
  timeMeta,
  titleHint,
  children,
  testId,
}: {
  icon: ReactNode
  /** The leading node owns its click (the issue ID square opens its picker). */
  iconInteractive?: boolean
  label: string
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  active: boolean
  /** Email-style unread emphasis (#126): the label reads bold until opened. */
  unread?: boolean
  expandable: boolean
  collapsed: boolean
  onToggle: () => void
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the label with an inline-rename input (#170). */
  editor?: ReactNode
  dotSession: SessionMeta | undefined
  /** Child-session count shown before the dot (only when children exist). */
  count?: number
  extras?: ReactNode
  /** Right-side time stamp (elapsed timer / "2h ago"), just before the dot. */
  timeMeta?: ReactNode
  children?: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="min-w-0" data-testid={testId}>
      {/* One flush rounded row: [icon][title][extras][count][dot]. The icon slot
          doubles as the expand/collapse toggle (chevron revealed on row hover)
          so there is no reserved gutter — rows start flush like the design. */}
      <div
        className={cn(
          'group/row flex min-w-0 items-center rounded-md transition-colors',
          active ? 'bg-[#232330]' : 'hover:bg-[#20202a]',
        )}
      >
        {iconInteractive ? (
          <div className="flex flex-none items-center py-1.5 pl-1">
            {icon}
            {expandable && (
              <button
                type="button"
                className="flex w-4 cursor-pointer items-center justify-center text-muted-foreground/60 hover:text-foreground"
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
            )}
          </div>
        ) : expandable ? (
          <button
            type="button"
            className="flex w-[33px] flex-none cursor-pointer items-center justify-end py-1.5 pr-0 pl-2 text-muted-foreground/60 hover:text-foreground"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            <span className="group-hover/row:hidden">{icon}</span>
            <span className="hidden group-hover/row:block">
              {collapsed ? (
                <ChevronRight size={15} aria-hidden="true" />
              ) : (
                <ChevronDown size={15} aria-hidden="true" />
              )}
            </span>
          </button>
        ) : (
          <span className="flex w-[33px] flex-none items-center justify-end py-1.5 pl-2">
            {icon}
          </span>
        )}
        {editor ? (
          // Inline rename (#170): the input replaces the label in place. Rendered
          // outside the button (an input-in-button is invalid) — same shape the
          // classic PanelRow uses for session rename.
          <div className="flex min-w-0 flex-1 items-center gap-[9px] py-1.5 pr-2 pl-[9px]">
            {editor}
          </div>
        ) : (
          <button
            type="button"
            className={cn(
              'flex min-w-0 flex-1 cursor-pointer items-center gap-[9px] py-1.5 pr-2 pl-[9px] text-left text-[13.5px]',
              // Selection is conveyed by the accent background ALONE — never a
              // heavier font (#170). That keeps UNREAD's bold as the sole weight
              // signal, so a selected-but-read row can't be mistaken for unread.
              active ? 'text-[#f3f3f8]' : 'text-[#dcdce4]',
            )}
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span
              className={cn(
                'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                // Unread rows lift to medium weight (email-style) — the ONLY weight
                // change in the row, independent of selection so the two never blur
                // together. Medium, not semibold: heavier reads as shouting once a
                // whole list is unread.
                unread && 'font-medium',
              )}
            >
              {label}
            </span>
            {extras}
            {timeMeta}
            {count !== undefined && (
              <span className="flex-none text-[10.5px] tabular-nums text-[#6c6c78]">{count}</span>
            )}
            {/* Right-side status summary: the most urgent child's dot, so the user
                can see WHY the row floats where it does. Expanded child rows show
                their own dots vertically aligned under this one. */}
            {dotSession && <span className={sessionDotClass(dotSession)} />}
          </button>
        )}
      </div>
      {/* Child agent rows: a tree guide (vertical line + per-row stubs, via
          .tree-children CSS) ties the group to its parent. */}
      {!collapsed && children && (
        <div className="tree-children relative pt-0.5 pb-1">
          <span
            className="tree-guide absolute top-0 bottom-3 left-4 w-px bg-border"
            aria-hidden="true"
          />
          {children}
        </div>
      )}
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
  suppressUnread = false,
  timeMeta,
  onSelect,
  onSelectPanel,
  onPinned,
  onOpenIssue,
  onRename,
  onColorChange,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'issue' }>
  sessions: SessionMeta[]
  /** Whole issue list — the context menu's label pool / duplicate targets. */
  issues: IssueWire[]
  allWorktreePaths: string[]
  active: boolean
  paneA: string | null
  now: number
  /** WORKING placement (#138): mute the unread emphasis on this row and its
   *  child session rows — active work isn't "new unseen work". */
  suppressUnread?: boolean
  /** Right-side time stamp (WORKING's elapsed timer / WORK's "2h ago"). */
  timeMeta?: ReactNode
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
  /** Open the issue PAGE (the context menu's "Open"). */
  onOpenIssue: (id: string) => void
  /** Commit a renamed title (double-click / context-menu Rename, #170). */
  onRename: (title: string) => void
  onColorChange: (color: IssueColorSlot | null) => unknown
}): JSX.Element {
  const { issue, sessions: mine } = row
  const unread = suppressUnread ? false : rowUnreadEmphasized(row)
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-issue:${issue.id}`, false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  // Commit a rename: trim, and no-op on empty/whitespace or an unchanged title so
  // an accidental double-click that changes nothing never fires a mutation (#170).
  const commitRename = (name: string) => {
    const next = name.trim()
    if (next && next !== issue.title) onRename(next)
    setEditing(false)
  }
  const renameEditor = editing ? (
    <SessionNameEditor
      value={issue.title}
      onCommit={commitRename}
      onCancel={() => setEditing(false)}
    />
  ) : undefined
  // A single agent underneath = nothing worth a second line: the parent row's
  // dot IS that agent's indicator. Child rows only exist from 2 agents up.
  const showChildren = mine.length >= 2
  const { visible, stale } = partitionStaleSessions(mine, now)
  const urgent = mostUrgentSession(mine, now)
  const squareWorking = mine.some(isSessionWorking)
  const squareState: IdSquareState = squareWorking
    ? 'working'
    : mine.length === 0 && issue.stage === 'backlog'
      ? 'queued'
      : 'idle'
  const square = (
    <IdSquare
      issue={issue}
      state={squareState}
      selected={active}
      showSpinner={squareWorking}
      onColorChange={onColorChange}
    />
  )
  // Draft vessel whose only content is agents → a single session-like line.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
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
      onRename={() => {
        setMenuAnchor(null)
        setEditing(true)
      }}
    />
  ) : null
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      suppressUnread={suppressUnread}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
      dotRight
    />
  )
  if (draftAgentOnly) {
    const first = mine[0]
    // Mock's amber status word ("paused" / "needs answer") right of the title.
    const firstBadge = first ? agentBadge(first) : null
    const draftMeta =
      first?.status === 'hibernated'
        ? 'paused'
        : firstBadge?.tone === 'attention'
          ? firstBadge.label
          : null
    return (
      <>
        <UnifiedRowShell
          testId="unified-issue-row"
          icon={square}
          iconInteractive
          label={label}
          active={active && paneA === first?.sessionId}
          unread={unread}
          expandable={false}
          collapsed={true}
          onToggle={() => {}}
          // A draft is just its agent — clicking the row opens the session itself.
          onSelect={() => (first ? onSelectPanel(first.sessionId) : onSelect())}
          onContextMenu={onContextMenu}
          dotSession={urgent}
          titleHint={issueIdTitle(issue)}
          extras={
            draftMeta ? (
              <span className="flex-none text-[10px] text-[#d4a017]">{draftMeta}</span>
            ) : undefined
          }
          timeMeta={timeMeta}
        />
        {menu}
      </>
    )
  }
  return (
    <>
      <UnifiedRowShell
        testId="unified-issue-row"
        icon={square}
        iconInteractive
        label={label}
        active={active}
        unread={unread}
        expandable={showChildren}
        collapsed={showChildren ? collapsed : true}
        onToggle={toggle}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onDoubleClick={() => setEditing(true)}
        editor={renameEditor}
        dotSession={urgent}
        count={showChildren ? mine.length : undefined}
        timeMeta={timeMeta}
        titleHint={issueIdTitle(issue)}
        extras={
          <>
            {/* The seq agents cite ("#15") — small and muted, purely for
                orientation when matching chat/CLI references to rows (#21). */}
            <span className="flex-none font-mono text-[10.5px] text-[#6c6c78] tabular-nums">
              {issueDisplayRef(issue)}
            </span>
            {issue.pinned && (
              <Pin size={11} className="flex-none text-muted-foreground" aria-hidden="true" />
            )}
            {isIssueSnoozed(issue, now) && (
              <AlarmClock
                size={11}
                className="flex-none text-muted-foreground"
                aria-label="Snoozed"
              />
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
        <GroupedSessionRows sessions={visible} render={renderRow} />
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
  suppressUnread = false,
  timeMeta,
  onSelect,
  onSelectPanel,
  onPinned,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'worktree' }>
  active: boolean
  paneA: string | null
  now: number
  /** WORKING placement (#138): mute the unread emphasis on this row and its
   *  child session rows — active work isn't "new unseen work". */
  suppressUnread?: boolean
  /** Right-side time stamp (WORKING's elapsed timer / WORK's "2h ago"). */
  timeMeta?: ReactNode
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
}): JSX.Element {
  const { worktree } = row
  const unread = suppressUnread ? false : rowUnreadEmphasized(row)
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
      suppressUnread={suppressUnread}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
      dotRight
    />
  )
  return (
    <UnifiedRowShell
      testId="unified-worktree-row"
      icon={<GitBranch size={14} aria-hidden="true" className="flex-none text-[#8a8a97]" />}
      label={worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path}
      active={active}
      unread={unread}
      expandable={showChildren}
      collapsed={showChildren ? collapsed : true}
      onToggle={toggle}
      onSelect={onSelect}
      dotSession={mostUrgentSession(worktree.sessions, now)}
      count={showChildren ? worktree.sessions.length : undefined}
      timeMeta={timeMeta}
      extras={
        worktree.isMain ? (
          <span className="rounded border border-border px-[5px] py-px text-[9.5px] uppercase tracking-[0.03em] text-[#8a8a97]">
            main
          </span>
        ) : undefined
      }
    >
      <GroupedSessionRows sessions={visible} render={renderRow} />
      <StaleSection sessions={stale} render={renderRow} />
    </UnifiedRowShell>
  )
}
