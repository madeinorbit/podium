import { shallowEqual } from '@podium/client-core/store'
import type { IssueColorSlot } from '@podium/domain'
import type { AgentKind, IssueWire, SessionMeta } from '@podium/protocol'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import {
  AlarmClock,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderPlus,
  GitBranch,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react'
import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { NEW_AGENTS } from '@/app/NewPanelMenu'
import { useStoreSelector } from '@/app/store'
import { IdSquare } from '@/components/IdSquare'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/features/issues/issue-card'
import { isEpic } from '@/features/issues/issue-hierarchy'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import {
  draftIssueLabel,
  groupUnifiedWorkRows,
  isIssueSnoozed,
  issueReturnedFromDefer,
  lastUsedMaps,
  type MotionPhase,
  machinesWithRepo,
  panelLabel,
  partitionStaleSessions,
  pickPaneSession,
  type RepoNavView,
  resolveDefaultAgent,
  resolveTargetMachine,
  rowMotionPhase,
  rowMotionTiming,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  sessionsForIssueNav,
  sessionsForWorktree,
  sidebarSections,
  spawnTargetForRepo,
  type UnifiedWorkRow,
  unifiedWorkList,
} from '@/lib/derive'
import { FLOW_SLATE, issueColorHex } from '@/lib/issueColors'
import { PhaseTimer, usePhaseMorph } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { PanelRow, StaleSection, useCollapsed } from './sidebar-common'

/** Icon component for an agent kind (shared with the "+" menu's agent list). */
function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}

/**
 * The redesigned work sidebar (#41, .design/specs/sidebar.md): the
 * `New <Agent> in <Repo>` spawn row over ONE list of work rows grouped by
 * project (mono section labels), each row carrying its ID square, two-line
 * status anatomy, motion-grammar meta and — when selected — the bridge notch
 * growing toward the engraved column.
 *
 * The pieces are exported separately because the mobile shell composes them
 * into its home view without the desktop column (#227).
 */
export function SidebarUnified(): JSX.Element {
  return (
    <>
      <NewWorkRow />
      {/* Divider under the spawn row — the handoff's 4px margins plus the
          column's 3px flex gap on each side land at 11px above / 9px below. */}
      <div
        data-testid="sidebar-divider"
        className="mx-2.5 mt-[11px] mb-[9px] h-px flex-none bg-[#25252f]"
        aria-hidden="true"
      />
      {/* The scroll container leaves 5px of horizontal head-room past the aside
          edge (negative margin + matching padding) so the selected row's bridge
          notch can paint OVER the aside border into the engraved column —
          overflow clips at the padding box, so the notch survives (#41). Rows
          sit at the column's 8px side inset (13 − 5); the column's 3px rhythm
          continues between project groups via the flex gap. */}
      <div
        data-testid="work-scroll"
        className="scroll-none flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto pb-2.5 pl-2"
        style={{ marginRight: -5, paddingRight: 13 }}
      >
        <WorkSections />
      </div>
      {/* Footer: 8px top / 10px sides, 4px own bottom + the column's 6px. */}
      <AppToolsRow className="flex-none border-t border-[#25252f] px-2.5 pt-2 pb-2.5" />
    </>
  )
}

/**
 * The one top row: `New <Agent> in <Repo>` wearing the handoff's compact
 * bordered look (main surface spawns; the chevron segment opens the
 * agent→repo menu) + the `New issue…` entry inside that menu.
 */
/**
 * Default spawn target + spawn/persist actions shared by the wide `New <Agent>
 * in <Repo>` row and the rail's compact new-Claude button (#41).
 */
export function useDefaultSpawn() {
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

  return {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    machines,
    spawn,
    persistDefaultAgent,
  }
}

export function NewWorkRow(): JSX.Element {
  const {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    machines,
    spawn,
    persistDefaultAgent,
  } = useDefaultSpawn()
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Anchor for the agent/repo menu: the WHOLE bordered button container, so the
  // dropdown opens directly under it, left-aligned, at the button's exact width
  // (the popup's w-(--anchor-width) tracks the Positioner anchor).
  const newAgentAnchorRef = useRef<HTMLDivElement | null>(null)

  return (
    <div className="mx-2 mt-2.5 flex items-center gap-2">
      <div
        ref={newAgentAnchorRef}
        data-testid="new-agent-button"
        className="relative min-w-0 flex-1"
      >
        {/* One bordered rounded-lg surface with a leading Claude-clay agent icon;
            the chevron is a borderless hitbox floating inside the same outline. */}
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[#3a3a46] bg-[#25252f] px-[10px] py-2 pr-[32px] text-[12px] leading-[normal] font-medium text-[#eaeaf0] transition-colors hover:border-[#4a4a56] hover:bg-[#2b2b36] disabled:opacity-50"
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

/** App-level tools: add repo, analytics, settings, search (the cmd-k palette) —
 *  four 28px icon buttons spread across the footer (handoff §2.1). */
export function AppToolsRow({ className }: { className?: string }): JSX.Element {
  const { view, setView, setPaletteOpen } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView, setPaletteOpen: s.setPaletteOpen }),
    shallowEqual,
  )
  const [repoScanOpen, setRepoScanOpen] = useState(false)
  const btn = (active = false) =>
    cn(
      'flex size-7 items-center justify-center rounded-md text-[#9a9aa8] transition-colors hover:bg-[#20202a] hover:text-[#f3f3f8]',
      active && 'bg-[#20202a] text-[#f3f3f8]',
    )
  return (
    <div className={cn('flex items-center justify-around', className)}>
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

/** Project section label: mono 8.5px uppercase over a trailing hairline (§2.2).
 *  Grouping is always on — no toggle, no chevron, no collapse. */
function ProjectGroupLabel({ label, first }: { label: string; first: boolean }): JSX.Element {
  return (
    <div
      data-testid="project-group-label"
      className={cn(
        'flex items-center gap-1.5 px-1 pb-0.5 font-mono text-[8.5px] leading-[normal] tracking-[.12em] uppercase text-[#7a7a86]',
        first ? 'pt-1' : 'pt-2',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="h-px min-w-4 flex-1 bg-[#25252f]" aria-hidden="true" />
    </div>
  )
}

/**
 * The work list: ONE list of issue/worktree rows, always grouped by project
 * (repo), banded urgency order inside each group. The old WORKING / PINNED
 * sections and the group toggle are gone (#41) — state is carried per-row by
 * the square language, the amber pill and the motion-grammar meta.
 * The caller owns the scroll container.
 */
/**
 * The unified work rows plus the selection actions on them — shared by the
 * wide sidebar (WorkSections) and the collapsed rail (SidebarRail, #41), so
 * both surfaces select/open work with identical semantics.
 */
export function useUnifiedWork() {
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
      markIssueRead: s.markIssueRead,
      markSessionRead: s.markSessionRead,
    }),
    shallowEqual,
  )
  const now = useNow(60_000)
  const sections = sidebarSections(repos, sessions, pins, now, issues)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  const allWorktreePaths = repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  const work = unifiedWorkList(sections, issues, sessions, allWorktreePaths, now)

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

  // Concrete mutation callbacks rather than the raw trpc client, so the hook's
  // inferred return type stays portable across packages.
  const renameIssue = (id: string, title: string): void => {
    void trpc.issues.update.mutate({ id, patch: { title } }).catch(() => {})
  }
  const setIssueColor = (id: string, color: IssueColorSlot | null): Promise<unknown> =>
    trpc.issues.update.mutate({ id, patch: { color } })

  return {
    work,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    setPinned,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    setIssueColor,
  }
}

export function WorkSections(): JSX.Element {
  const {
    work,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    setPinned,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    setIssueColor,
  } = useUnifiedWork()

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
        onRename={(title) => renameIssue(row.issue.id, title)}
        onColorChange={(color) => setIssueColor(row.issue.id, color)}
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

  if (work.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground/70">
        Nothing yet — start an agent or create an issue above.
      </div>
    )
  }
  return (
    <>
      {groupUnifiedWorkRows(work).map((group, index) => (
        <div
          key={group.key}
          className="flex min-w-0 flex-col gap-[3px]"
          data-testid="project-group"
        >
          <ProjectGroupLabel label={group.label} first={index === 0} />
          {group.rows.map(renderWorkRow)}
        </div>
      ))}
    </>
  )
}

/** Line-1/line-2 text tints for one row (§2.4): everything colour-flows from
 *  the issue colour; uncoloured rows read the neutral greys (slate when
 *  selected — the no-colour flow accent, never a pickable colour). */
function rowTints(hex: string | undefined, phase: MotionPhase, active: boolean) {
  return {
    title: active
      ? hex
        ? `color-mix(in srgb, ${hex} 10%, #f7f7fc)`
        : '#f2f5fa'
      : hex
        ? `color-mix(in srgb, ${hex} 25%, #d7d7e0)`
        : phase === 'queued'
          ? '#9a9aa8'
          : '#d7d7e0',
    status: hex ? `color-mix(in srgb, ${hex} 55%, #9a9aa8)` : active ? '#aab6c8' : '#6c6c78',
  }
}

/**
 * The shared two-line WORK-row skeleton (§2.4/§2.5):
 * [ID square][title + amber pill / status line + motion meta][bridge notch].
 * Issue and worktree rows both render through it — they differ only in the
 * leading square and their extras. Queued rows dim whole (.65); the selected
 * row wears the colour-mixed background, border and the notch that crosses the
 * aside border toward the engraved column.
 */
function WorkRowShell({
  square,
  label,
  statusLine,
  hex,
  phase,
  waitingCount,
  timeMeta,
  active,
  unread = false,
  expandable,
  collapsed,
  onToggle,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  extras,
  titleHint,
  children,
  testId,
}: {
  /** The leading 26px identity square (owns its own click). */
  square: ReactNode
  label: string
  /** Line 2's status phrase (`rowStatusLine`). */
  statusLine: string
  /** The issue colour hex, undefined for the neutral/slate flow. */
  hex: string | undefined
  phase: MotionPhase
  /** Amber line-1 pill count (0 = no pill). */
  waitingCount: number
  /** Line 2's right meta (the PhaseTimer). */
  timeMeta?: ReactNode
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
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-1 chips after the title (pin / snooze / epic). */
  extras?: ReactNode
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  children?: ReactNode
  testId: string
}): JSX.Element {
  // One-shot transition morphs (§2.6): fire only on a REAL phase change under a
  // mounted row — queued→working ignites the square, →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const accent = hex ?? FLOW_SLATE
  const tints = rowTints(hex, phase, active)
  const rowStyle: CSSProperties = active
    ? {
        background: `color-mix(in srgb, ${accent} ${hex ? 28 : 20}%, #16161c)`,
        borderColor: `color-mix(in srgb, ${accent} ${hex ? 80 : 70}%, transparent)`,
      }
    : hex
      ? { background: `color-mix(in srgb, ${hex} 12%, #16161c)` }
      : {}
  return (
    <div className="min-w-0" data-testid={testId}>
      <div
        className={cn(
          'phase-surface group/row relative flex min-w-0 items-center gap-2 rounded-[7px] px-2',
          // Handoff §2.4/§2.5: plain rows are borderless at 5px 8px; ONLY the
          // selected row grows its border and 6px vertical padding.
          active ? 'border py-[6px]' : 'py-[5px]',
          !active && !hex && 'hover:bg-[#20202a]',
          phase === 'queued' && !active && 'opacity-65',
          morph === 'waiting' && 'morph-row-flash',
        )}
        style={rowStyle}
        data-phase={phase}
        data-selected={active ? 'true' : 'false'}
      >
        <span className={cn('flex flex-none', morph === 'working' && 'morph-ignite')}>
          {square}
        </span>
        {expandable && (
          <button
            type="button"
            className="-ml-1.5 flex w-3.5 flex-none cursor-pointer items-center justify-center self-stretch text-muted-foreground/60 hover:text-foreground"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? (
              <ChevronRight size={11} aria-hidden="true" />
            ) : (
              <ChevronDown size={11} aria-hidden="true" />
            )}
          </button>
        )}
        {editor ? (
          // Inline rename (#170): the input replaces the two-line block in place.
          <div className="flex min-w-0 flex-1 items-center">{editor}</div>
        ) : (
          <button
            type="button"
            // leading-[normal]: the handoff rows run the font's natural line
            // height — the preflight 1.5 would grow the two-line block past
            // the 26px square and inflate every row (#64).
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-px text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px]',
                  // Selection lifts to semibold per the handoff; UNREAD keeps its
                  // email-style medium independent of selection (#126).
                  active ? 'font-semibold' : unread && 'font-medium',
                )}
                style={{ color: tints.title }}
              >
                {label}
              </span>
              {extras}
              {waitingCount > 0 && (
                <span
                  key={`pill:${waitingCount}`}
                  className={cn(
                    'flex-none rounded-full bg-attention px-[5px] text-[9px] font-bold text-attention-foreground',
                    morph !== null && 'morph-pop',
                  )}
                  role="img"
                  aria-label={`${waitingCount} waiting on you`}
                >
                  {waitingCount}
                </span>
              )}
            </span>
            <span
              className="flex min-w-0 items-center gap-1.5 text-[10px]"
              style={{ color: tints.status }}
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {statusLine}
              </span>
              {timeMeta}
            </span>
          </button>
        )}
        {/* Bridge notch (§2.5): grows from the selected row's right edge over the
            aside border toward the engraved column, tinted by the issue colour. */}
        {active && (
          <span
            data-testid="bridge-notch"
            aria-hidden="true"
            // issue-scope + var-driven gradient: a fresh colour pick animates
            // the notch through the registered --issue transition — gradient
            // images themselves can't interpolate.
            className="issue-scope pointer-events-none absolute top-[9px] right-[-10px] bottom-[9px] w-[10px] rounded-r-[3px]"
            style={
              {
                '--issue': accent,
                background: `linear-gradient(90deg, color-mix(in srgb, var(--issue) ${hex ? 85 : 75}%, transparent), color-mix(in srgb, var(--issue) ${hex ? 12 : 10}%, transparent))`,
              } as CSSProperties
            }
          />
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
 * One issue row in the work list. Agent drafts (draft issue whose only content
 * is agents, no worktree) click straight into their session. Real issues show
 * the ID square and expand (default expanded) to their member sessions from 2
 * agents up.
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
  const unread = rowUnreadEmphasized(row)
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
  // status line IS that agent's indicator. Child rows only exist from 2 agents up.
  const showChildren = mine.length >= 2
  const { visible, stale } = partitionStaleSessions(mine, now)
  const phase = rowMotionPhase(row)
  const waitingCount = rowWaitingCount(row)
  const timing = rowMotionTiming(row)
  const hex = issueColorHex(issue.color)
  const square = (
    <IdSquare
      issue={issue}
      state={phase}
      selected={active}
      badge={waitingCount > 0 ? { kind: 'dot' } : null}
      onColorChange={onColorChange}
    />
  )
  // Draft vessel whose only content is agents → clicking opens the session.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
  const first = mine[0]
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
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
      dotRight
    />
  )
  return (
    <>
      <WorkRowShell
        testId="unified-issue-row"
        square={square}
        label={label}
        statusLine={rowStatusLine(row, now)}
        hex={hex}
        phase={phase}
        waitingCount={waitingCount}
        timeMeta={
          <PhaseTimer
            phase={timing.phase}
            sinceMs={timing.sinceMs}
            baseMs={timing.baseMs ?? 0}
            totalMs={timing.totalMs}
            size={9}
            className="flex-none"
          />
        }
        active={draftAgentOnly ? active && paneA === first?.sessionId : active}
        unread={unread}
        expandable={!draftAgentOnly && showChildren}
        collapsed={draftAgentOnly || !showChildren ? true : collapsed}
        onToggle={toggle}
        // A draft is just its agent — clicking the row opens the session itself.
        onSelect={draftAgentOnly && first ? () => onSelectPanel(first.sessionId) : onSelect}
        onContextMenu={onContextMenu}
        onDoubleClick={() => setEditing(true)}
        editor={renameEditor}
        titleHint={issueIdTitle(issue)}
        extras={
          <>
            {issue.pinned && (
              <Pin size={10} className="flex-none text-muted-foreground" aria-hidden="true" />
            )}
            {isIssueSnoozed(issue, now) && (
              <AlarmClock
                size={10}
                className="flex-none text-muted-foreground"
                aria-label="Snoozed"
              />
            )}
            {issueReturnedFromDefer(issue, now) && (
              <span
                className="flex-none rounded border border-amber-500/40 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                title="Snooze ended — back in your queue"
              >
                Unsnoozed
              </span>
            )}
            {isEpic(issue) && (
              <span className="flex-none rounded border border-violet-500/50 px-1 text-[8.5px] leading-4 text-violet-600 dark:text-violet-400">
                epic
              </span>
            )}
          </>
        }
      >
        {!draftAgentOnly && showChildren && (
          <>
            {visible.map(renderRow)}
            <StaleSection sessions={stale} render={renderRow} />
          </>
        )}
      </WorkRowShell>
      {menu}
    </>
  )
}

/** The worktree pseudo-square: a with-session worktree owned by no issue has
 *  no identity square, so it wears the branch glyph in the same 26px frame —
 *  square language (solid/dashed border) intact, no colour, no picker. */
function BranchSquare({ phase }: { phase: MotionPhase }): JSX.Element {
  const resting = phase === 'queued'
  return (
    <span
      data-testid="worktree-branch-square"
      className="phase-surface flex size-[26px] flex-none items-center justify-center rounded-[7px] bg-[#25252f]"
      style={{
        border: resting ? '1px dashed #6c6c78' : '1px solid #8d8d9a',
        color: resting ? '#8d8d9a' : '#c5c5d0',
        opacity: resting ? 0.65 : 1,
      }}
    >
      <GitBranch size={12} aria-hidden="true" />
    </span>
  )
}

/** A with-session worktree owned by no issue — same row skeleton, branch square. */
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
  const unread = rowUnreadEmphasized(row)
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-wt:${worktree.path}`, false)
  // A single agent underneath = nothing worth a second line: the parent row's
  // status line IS that agent's indicator. Child rows only exist from 2 agents up.
  const showChildren = worktree.sessions.length >= 2
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const phase = rowMotionPhase(row)
  const timing = rowMotionTiming(row)
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
    <WorkRowShell
      testId="unified-worktree-row"
      square={<BranchSquare phase={phase} />}
      label={worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path}
      statusLine={rowStatusLine(row, now)}
      hex={undefined}
      phase={phase}
      waitingCount={rowWaitingCount(row)}
      timeMeta={
        <PhaseTimer
          phase={timing.phase}
          sinceMs={timing.sinceMs}
          baseMs={timing.baseMs ?? 0}
          totalMs={timing.totalMs}
          size={9}
          className="flex-none"
        />
      }
      active={active}
      unread={unread}
      expandable={showChildren}
      collapsed={showChildren ? collapsed : true}
      onToggle={toggle}
      onSelect={onSelect}
      extras={
        worktree.isMain ? (
          <span className="flex-none rounded border border-border px-[5px] py-px text-[8.5px] uppercase tracking-[0.03em] text-[#8a8a97]">
            main
          </span>
        ) : undefined
      }
    >
      {showChildren && (
        <>
          {visible.map(renderRow)}
          <StaleSection sessions={stale} render={renderRow} />
        </>
      )}
    </WorkRowShell>
  )
}
