import type { SessionMeta } from '@podium/protocol'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  FolderTree,
  GripVertical,
  Home,
  KanbanSquare,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SquarePlus,
  X,
} from 'lucide-react'
import type { DragEvent, JSX, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSessionGuard } from '@/hooks/use-session-guard'
import { cn } from '@/lib/utils'
import {
  agentBadge,
  agentColorHex,
  filterSidebarSections,
  isSnoozed,
  partitionStaleSessions,
  partitionWorkItems,
  type RepoNavView,
  repoBranchForCwd,
  returnedFromSnooze,
  sessionDotClass,
  sidebarSections,
  sortRepos,
  sortWorktrees,
  type WorktreeNavView,
} from './derive'
import { FileBrowserModal } from './FileBrowserModal'
import { HostIndicators } from './HostIndicators'
import { NewPanelMenu } from './NewPanelMenu'
import { RepoScanFlow } from './RepoScanFlow'
import { SearchView } from './SearchView'
import { SnoozeControl } from './SnoozeControl'
import { useStore } from './store'
import type { PinKind, WorktreeView } from './types'
import { useNow } from './useNow'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from './WorkerLabel'

const REPO_SORT_LABELS: Record<'alphabetical' | 'lastUsed' | 'custom', string> = {
  lastUsed: 'Last used',
  alphabetical: 'A–Z',
  custom: 'Custom',
}

function StatusDot({ session }: { session: SessionMeta }): JSX.Element {
  // Shared single source of truth — colour semantics match tabs/home/chat, and
  // the `dot`/`parked` markers drive the hibernated grayed-italic row in CSS.
  return <span className={sessionDotClass(session)} />
}

export function Sidebar(): JSX.Element {
  const {
    repos,
    reposLoading,
    repoDiagnostics,
    sessions,
    pins,
    setPinned,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    setPane,
    view,
    setView,
    superOpen,
    setSuperOpen,
    sidebarSettings,
    setSidebarSettings,
  } = useStore()
  const now = useNow(60_000)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  // Inline filter over the repos/worktrees tree (name/branch/path). Distinct from
  // the global SearchView (the magnifier in the tools row), which searches
  // conversation transcripts — this only narrows the visible repo/worktree list.
  const [treeFilter, setTreeFilter] = useState('')
  const sections = filterSidebarSections(sidebarSections(repos, sessions, pins, now), treeFilter)

  // Drag-to-reorder state.
  const dragRepoPath = useRef<string | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  // Build a lastUsedAt map keyed by REPO path, aggregating across all worktrees.
  // A session's cwd may be a linked worktree (not the repo root), so we first
  // build a worktree-path→repo-path index from the view model, then aggregate.
  const worktreeToRepo = new Map<string, string>()
  for (const repo of sections.repos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const repo of sections.pinnedRepos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const wt of sections.pinnedWorktrees) worktreeToRepo.set(wt.path, wt.repoPath)
  // lastUsedAt aggregated to the repo (for repo ordering) and kept per-worktree
  // (for worktree ordering within a repo). A session's cwd is its worktree path.
  const lastUsedAtMap = new Map<string, number>()
  const lastUsedByWorktree = new Map<string, number>()
  for (const s of sessions) {
    const ts = new Date(s.lastActiveAt).getTime()
    const repoPath = worktreeToRepo.get(s.cwd) ?? s.cwd
    if (ts > (lastUsedAtMap.get(repoPath) ?? 0)) lastUsedAtMap.set(repoPath, ts)
    if (ts > (lastUsedByWorktree.get(s.cwd) ?? 0)) lastUsedByWorktree.set(s.cwd, ts)
  }

  // Apply the sort to the non-pinned repos list AND to the worktrees inside each
  // repo — with one repo and many worktrees, repo-only sorting looks like a no-op.
  const sortedRepos = sortRepos(
    sections.repos.map((r) => ({ ...r, id: r.path })),
    sidebarSettings.repoSort,
    sidebarSettings.repoOrder,
    lastUsedAtMap,
  ).map((repo) => ({
    ...repo,
    worktrees: sortWorktrees(repo.worktrees, sidebarSettings.repoSort, lastUsedByWorktree),
  }))

  const handleRepoDragStart = (e: DragEvent<HTMLDivElement>, repoPath: string) => {
    dragRepoPath.current = repoPath
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleRepoDragOver = (e: DragEvent<HTMLDivElement>, repoPath: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverPath(repoPath)
  }
  const handleRepoDrop = (e: DragEvent<HTMLDivElement>, targetPath: string) => {
    e.preventDefault()
    setDragOverPath(null)
    const srcPath = dragRepoPath.current
    dragRepoPath.current = null
    if (!srcPath || srcPath === targetPath) return
    // Compute the new custom order from the current visible list.
    const paths = sortedRepos.map((r) => r.path)
    const srcIdx = paths.indexOf(srcPath)
    const tgtIdx = paths.indexOf(targetPath)
    if (srcIdx === -1 || tgtIdx === -1) return
    const next = [...paths]
    next.splice(srcIdx, 1)
    const adj = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx
    next.splice(adj, 0, srcPath)
    void setSidebarSettings({ repoSort: 'custom', repoOrder: next })
  }
  const handleRepoDragEnd = () => {
    dragRepoPath.current = null
    setDragOverPath(null)
  }

  const pinnedSessionIds = new Set(pins.panels)
  const workItems = partitionWorkItems(sessions, pinnedSessionIds, now)

  const hasRows =
    workItems.attention.length > 0 ||
    workItems.working.length > 0 ||
    workItems.pinnedPanels.length > 0 ||
    sections.pinnedWorktrees.length > 0 ||
    sections.pinnedRepos.length > 0 ||
    sections.repos.length > 0

  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    setView('workspace')
  }
  const selectWorktree = (path: string) => {
    setSelectedWorktree(path)
    setView('workspace')
  }

  return (
    <aside className="flex w-[280px] flex-shrink-0 flex-col overflow-y-auto border-r border-border bg-card text-card-foreground">
      <button
        type="button"
        className={cn(
          'mx-3 mt-2.5 flex items-center gap-2 rounded-md border px-2.5 py-[7px] text-[13px] text-foreground',
          view === 'home'
            ? 'border-primary font-medium text-foreground'
            : 'border-input bg-secondary hover:border-primary hover:text-foreground',
        )}
        onClick={() => setView('home')}
      >
        <Home size={14} aria-hidden="true" /> Command center
      </button>
      <button
        type="button"
        className={cn(
          'mx-3 mt-2.5 flex items-center gap-2 rounded-md border px-2.5 py-[7px] text-[13px] text-foreground',
          superOpen
            ? 'border-primary font-medium text-foreground'
            : 'border-input bg-secondary hover:border-primary hover:text-foreground',
        )}
        aria-pressed={superOpen}
        onClick={() => setSuperOpen(!superOpen)}
      >
        <Sparkles size={14} aria-hidden="true" /> Superagent
      </button>
      {/* App-level tools row. Analytics + settings + search + add-repo live
          here — global actions that are not tied to a specific section. */}
      <div className="flex items-center gap-1 px-3 pt-0.5 pb-1">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'border border-input text-muted-foreground hover:border-primary hover:text-foreground',
            view === 'issues' && 'border-primary bg-secondary text-foreground',
          )}
          aria-pressed={view === 'issues'}
          title="Issues"
          onClick={() => setView('issues')}
        >
          <KanbanSquare size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'border border-input text-muted-foreground hover:border-primary hover:text-foreground',
            view === 'usage' && 'border-primary bg-secondary text-foreground',
          )}
          aria-pressed={view === 'usage'}
          title="Usage & analytics"
          onClick={() => setView('usage')}
        >
          <BarChart3 size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'border border-input text-muted-foreground hover:border-primary hover:text-foreground',
            view === 'settings' && 'border-primary bg-secondary text-foreground',
          )}
          aria-pressed={view === 'settings'}
          title="Settings"
          onClick={() => setView('settings')}
        >
          <SettingsIcon size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="border border-input text-muted-foreground hover:border-primary hover:text-foreground"
          title="Search conversations"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="border border-input text-muted-foreground hover:border-primary hover:text-foreground"
          title="Add repo"
          onClick={() => setPickerOpen(true)}
        >
          <Plus size={15} aria-hidden="true" />
        </Button>
      </div>
      {/* Inline filter over the visible repo/worktree tree (name/branch/path). */}
      <div className="relative px-3 pb-2">
        <Search
          size={13}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-muted-foreground/70"
        />
        <Input
          type="search"
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          placeholder="Filter worktrees…"
          aria-label="Filter worktrees by name, branch, or path"
          className="h-7 pl-7 text-xs"
        />
        {treeFilter && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-1/2 right-4 size-5 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            title="Clear filter"
            aria-label="Clear filter"
            onClick={() => setTreeFilter('')}
          >
            <X size={13} aria-hidden="true" />
          </Button>
        )}
      </div>
      {(reposLoading || repoDiagnostics.length > 0) && (
        <div className="px-3 pt-1.5 pb-2 text-xs text-muted-foreground">
          {reposLoading
            ? 'Loading repositories...'
            : `Scan finished with ${repoDiagnostics.length} warning${repoDiagnostics.length === 1 ? '' : 's'}.`}
        </div>
      )}
      <div className="flex-1 overflow-y-auto pb-3">
        {/* ── WORK ITEMS umbrella ── */}
        {(workItems.attention.length > 0 ||
          workItems.working.length > 0 ||
          workItems.pinnedPanels.length > 0) && (
          <div className="min-w-0 border-b border-border">
            {/* NEEDS YOUR ATTENTION — collapsible (default expanded). Long-idle
                items still collapse into a Stale subsection once it gets crowded. */}
            {workItems.attention.length > 0 &&
              (() => {
                const { visible, stale } = partitionStaleSessions(workItems.attention, now)
                const renderRow = (session: SessionMeta) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={false}
                    attention
                    active={selectedWorktree === session.cwd && paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                )
                return (
                  <CollapsibleSection
                    label="NEEDS YOUR ATTENTION"
                    storageKey="podium:sidebar:collapsed:attention"
                    count={workItems.attention.length}
                  >
                    {visible.map(renderRow)}
                    <StaleSection sessions={stale} render={renderRow} />
                  </CollapsibleSection>
                )
              })()}

            {/* WORKING — collapsible, default collapsed, shows count in header */}
            {workItems.working.length > 0 && (
              <CollapsibleSection
                label="WORKING"
                storageKey="podium:sidebar:collapsed:working"
                defaultCollapsed
                count={workItems.working.length}
              >
                {workItems.working.map((session) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={false}
                    active={selectedWorktree === session.cwd && paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                ))}
              </CollapsibleSection>
            )}

            {/* PINNED PANELS — collapsible, default expanded */}
            {workItems.pinnedPanels.length > 0 && (
              <CollapsibleSection
                label="PINNED PANELS"
                storageKey="podium:sidebar:collapsed:pinned-panels"
                count={workItems.pinnedPanels.length}
              >
                {workItems.pinnedPanels.map((session) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={true}
                    active={selectedWorktree === session.cwd && paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                ))}
              </CollapsibleSection>
            )}
          </div>
        )}

        {/* ── WORKTREES ── */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            WORKTREES
          </span>
          <Select
            value={sidebarSettings.repoSort}
            onValueChange={(v) =>
              void setSidebarSettings({
                repoSort: v as 'alphabetical' | 'lastUsed' | 'custom',
              })
            }
          >
            <SelectTrigger
              aria-label="Sort repositories"
              className="h-5 w-auto gap-1 border-0 px-1 text-[10px] text-muted-foreground/70 shadow-none hover:text-foreground focus:ring-0"
            >
              {/* Render the human label, not the raw enum value — Base UI's
                  SelectValue shows the bare `value` (e.g. "lastUsed") otherwise. */}
              <span>{REPO_SORT_LABELS[sidebarSettings.repoSort]}</span>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="lastUsed" className="text-xs">
                Last used
              </SelectItem>
              <SelectItem value="alphabetical" className="text-xs">
                A–Z
              </SelectItem>
              <SelectItem value="custom" className="text-xs">
                Custom
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {sections.pinnedWorktrees.length > 0 && (
          <CollapsibleSection
            label="PINNED WORKTREES"
            storageKey="podium:sidebar:collapsed:pinned-worktrees"
            count={sections.pinnedWorktrees.length}
          >
            {sections.pinnedWorktrees.map((worktree) => (
              <WorktreeBlock
                key={worktree.path}
                worktree={worktree}
                pinned={true}
                active={selectedWorktree === worktree.path}
                paneA={paneA}
                now={now}
                setPinned={setPinned}
                onSelectWorktree={() => selectWorktree(worktree.path)}
                onSelectPanel={selectPanel}
              />
            ))}
          </CollapsibleSection>
        )}

        {sections.pinnedRepos.length > 0 && (
          <CollapsibleSection
            label="PINNED REPOS"
            storageKey="podium:sidebar:collapsed:pinned-repos"
            count={sections.pinnedRepos.length}
          >
            {sections.pinnedRepos.map((repo) => (
              <RepoBlock
                key={repo.path}
                repo={repo}
                pinned={true}
                selectedWorktree={selectedWorktree}
                paneA={paneA}
                now={now}
                setPinned={setPinned}
                onSelectWorktree={selectWorktree}
                onSelectPanel={selectPanel}
              />
            ))}
          </CollapsibleSection>
        )}

        {sortedRepos.map((repo) => (
          <div
            key={repo.path}
            draggable
            onDragStart={(e) => handleRepoDragStart(e, repo.path)}
            onDragOver={(e) => handleRepoDragOver(e, repo.path)}
            onDrop={(e) => handleRepoDrop(e, repo.path)}
            onDragEnd={handleRepoDragEnd}
            className={cn(
              'transition-opacity',
              dragOverPath === repo.path && dragRepoPath.current !== repo.path
                ? 'opacity-50 outline outline-1 outline-primary'
                : '',
            )}
          >
            <RepoBlock
              repo={repo}
              pinned={false}
              selectedWorktree={selectedWorktree}
              paneA={paneA}
              now={now}
              setPinned={setPinned}
              onSelectWorktree={selectWorktree}
              onSelectPanel={selectPanel}
              dragHandle={
                <GripVertical
                  size={12}
                  className="ml-1 flex-none cursor-grab text-muted-foreground/40 hover:text-muted-foreground"
                  aria-hidden="true"
                />
              }
            />
          </div>
        ))}

        {!hasRows &&
          (treeFilter.trim() ? (
            <div className="p-3 text-xs text-muted-foreground/70">
              No worktrees match "{treeFilter.trim()}".
            </div>
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">
              No repos yet. Use the + button above to scan a folder.
            </div>
          ))}
      </div>
      {/* Host health strip, pinned under the list — machine-level indicators
          (connection health, memory). */}
      <HostIndicators />
      {pickerOpen && (
        <RepoScanFlow onClose={() => setPickerOpen(false)} onDone={() => setPickerOpen(false)} />
      )}
      {searchOpen && <SearchView onClose={() => setSearchOpen(false)} />}
    </aside>
  )
}

/** Per-section collapse state, persisted to localStorage. Absent key = the
 *  section's own default (attention/pinned open, working closed). */
function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? defaultCollapsed : v === 'true'
    } catch {
      return defaultCollapsed
    }
  })
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(key, next ? 'true' : 'false')
      } catch {
        // ignore
      }
      return next
    })
  }
  return [collapsed, toggle]
}

/** A collapsible sidebar section: a chevroned uppercase header over its rows.
 *  Collapsed state persists per `storageKey`; `right` renders inline controls
 *  (e.g. the repo-sort select) that stay clickable without toggling. */
function CollapsibleSection({
  label,
  storageKey,
  defaultCollapsed = false,
  count,
  right,
  children,
}: {
  label: string
  storageKey: string
  defaultCollapsed?: boolean
  count?: number
  right?: ReactNode
  children: ReactNode
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(storageKey, defaultCollapsed)
  return (
    <div className="min-w-0 py-1">
      <div className="flex items-center justify-between px-3 pt-2 pb-[3px]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-primary hover:text-primary/80"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        >
          {collapsed ? (
            <ChevronRight size={11} aria-hidden="true" className="flex-none" />
          ) : (
            <ChevronDown size={11} aria-hidden="true" className="flex-none" />
          )}
          <span className="truncate">
            {label}
            {collapsed && count !== undefined && count > 0 && (
              <span className="ml-1 font-normal text-muted-foreground">· {count}</span>
            )}
          </span>
        </button>
        {right}
      </div>
      {!collapsed && children}
    </div>
  )
}

/** The repo's primary checkout, as a NewPanelMenu target. Prefer the repo's main
 *  worktree (its path === repo.path); reconstruct one if it's been filtered out
 *  of the nav list (e.g. pinned away as its own worktree row). */
function repoPrimaryWorktree(repo: RepoNavView): WorktreeView {
  const main = repo.worktrees.find((w) => w.isMain) ?? repo.worktrees[0]
  if (main) {
    const { repoName: _repoName, sessions: _sessions, ...view } = main
    return view
  }
  return { path: repo.path, repoPath: repo.path, isMain: true }
}

function RepoBlock({
  repo,
  pinned,
  selectedWorktree,
  paneA,
  now,
  setPinned,
  onSelectWorktree,
  onSelectPanel,
  dragHandle,
}: {
  repo: RepoNavView
  pinned: boolean
  selectedWorktree: string | null
  paneA: string | null
  now: number
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: (path: string) => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
  dragHandle?: ReactNode
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:collapsed:repo:${repo.path}`, false)
  return (
    <div className="group/repo mt-1">
      <div className="flex items-center justify-between pr-2">
        {dragHandle}
        {/* Repo name doubles as the collapse toggle for its worktrees. */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 px-3 pt-1.5 pb-0.5 text-left text-[11px] tracking-[0.06em] uppercase text-muted-foreground/70 hover:text-foreground"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${repo.name} worktrees`}
        >
          {collapsed ? (
            <ChevronRight size={10} aria-hidden="true" className="flex-none" />
          ) : (
            <ChevronDown size={10} aria-hidden="true" className="flex-none" />
          )}
          <span className="truncate">{repo.name}</span>
        </button>
        {/* Start a new agent in this repo's primary worktree. Revealed on row
            hover (matching the session rows' reveal-on-hover controls). */}
        <NewPanelMenu
          worktree={repoPrimaryWorktree(repo)}
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              className="w-7 min-w-7 flex-none rounded-none text-muted-foreground/70 opacity-0 group-hover/repo:opacity-100 hover:text-foreground aria-expanded:opacity-100"
              title={`New agent in ${repo.name}`}
              aria-label={`New agent in ${repo.name}`}
            >
              <SquarePlus size={13} aria-hidden="true" />
            </Button>
          }
          onOpened={(sid) => onSelectPanel(repoPrimaryWorktree(repo).path, sid)}
        />
        <PinButton
          kind="repo"
          id={repo.path}
          pinned={pinned}
          label={repo.name}
          setPinned={setPinned}
          revealClass="group-hover/repo:inline-flex"
        />
      </div>
      {!collapsed &&
        repo.worktrees.map((worktree) => (
          <WorktreeBlock
            key={worktree.path}
            worktree={worktree}
            pinned={false}
            active={selectedWorktree === worktree.path}
            paneA={paneA}
            now={now}
            setPinned={setPinned}
            onSelectWorktree={() => onSelectWorktree(worktree.path)}
            onSelectPanel={onSelectPanel}
          />
        ))}
    </div>
  )
}

function WorktreeBlock({
  worktree,
  pinned,
  active,
  paneA,
  now,
  setPinned,
  onSelectWorktree,
  onSelectPanel,
}: {
  worktree: WorktreeNavView
  pinned: boolean
  active: boolean
  paneA: string | null
  now: number
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: () => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
}): JSX.Element {
  const [browsing, setBrowsing] = useState(false)
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(worktree.path, session.sessionId)}
      onPinned={(p) => void setPinned('panel', session.sessionId, p)}
    />
  )
  return (
    <div className="min-w-0">
      <div className="group/wt flex min-w-0 items-stretch">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          onClick={onSelectWorktree}
        >
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {worktree.branch ?? worktree.path.split('/').pop()}
          </span>
          {pinned && (
            <span className="min-w-0 max-w-[90px] flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground/70">
              {worktree.repoName}
            </span>
          )}
          {worktree.isMain && (
            <span className="rounded border border-input px-1 text-[10px] uppercase text-muted-foreground">
              main
            </span>
          )}
        </button>
        <PinButton
          kind="worktree"
          id={worktree.path}
          pinned={pinned}
          label={worktree.branch ?? worktree.path}
          setPinned={setPinned}
          revealClass="group-hover/wt:inline-flex"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            'w-7 min-w-7 flex-none rounded-none',
            'hidden text-muted-foreground/70 hover:text-foreground group-hover/wt:inline-flex',
          )}
          title="Browse files"
          aria-label="Browse files"
          onClick={(e) => {
            e.stopPropagation()
            setBrowsing(true)
          }}
        >
          <FolderTree size={13} aria-hidden="true" />
        </Button>
      </div>
      {visible.map(renderRow)}
      <StaleSection sessions={stale} render={renderRow} />
      {browsing && (
        <FileBrowserModal
          root={worktree.path}
          machineId={worktree.machineId}
          title={`Files — ${worktree.branch ?? worktree.path.split('/').pop()}`}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  )
}

/** Collapsed "Stale" subsection at the bottom of a session group — quiet,
 *  long-inactive sessions tucked away so the active ones stay scannable. */
function StaleSection({
  sessions,
  render,
}: {
  sessions: SessionMeta[]
  render: (session: SessionMeta) => JSX.Element
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) return null
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 py-[3px] pr-3 pl-7 text-left text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/60 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={11} aria-hidden="true" className="flex-none" />
        ) : (
          <ChevronRight size={11} aria-hidden="true" className="flex-none" />
        )}
        <span>
          Stale
          {!open && <span className="ml-1 font-normal lowercase">· {sessions.length}</span>}
        </span>
      </button>
      {open && sessions.map(render)}
    </div>
  )
}

function PanelRow({
  session,
  pinned,
  active,
  onSelect,
  onPinned,
  attention = false,
}: {
  session: SessionMeta
  pinned: boolean
  active: boolean
  onSelect: () => void
  onPinned: (pinned: boolean) => void
  /** True only for the NEEDS YOUR ATTENTION rows: shows the snooze control
   *  (rightmost, always visible) and reveals pin/close on hover. */
  attention?: boolean
}): JSX.Element {
  const { continueSession, renameSession } = useStore()
  const { guardedKill } = useSessionGuard()
  const badge = agentBadge(session)
  const [editing, setEditing] = useState(false)
  // Snooze control shows: on attention rows always (to snooze); elsewhere ONLY
  // when already snoozed — so worktree/pinned rows surface an un-snooze affordance
  // for a snoozed session, but never a plain "snooze" icon.
  const now = useNow(60_000)
  const snoozed = isSnoozed(session, now)
  // A timed snooze that has lapsed but isn't cleared yet → the session just came
  // back into the queue; mark it (compareRecency already lifts it by its deadline).
  const backFromSnooze = returnedFromSnooze(session, now)
  return (
    // Constant row height (matches the icon-sm controls) so revealing pin/close on
    // hover never grows the row — otherwise every row below jumps down.
    <div className="group flex min-h-7 min-w-0 items-center gap-1">
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] pr-3 pl-7">
          <StatusDot session={session} />
          <SessionNameEditor
            value={sessionDisplayName(session)}
            onCommit={(name) => {
              void renameSession(session.sessionId, name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[3px] pr-3 pl-7 text-left text-xs',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          onClick={onSelect}
          // Double-click the row to rename — matches the tab strip.
          onDoubleClick={() => setEditing(true)}
        >
          <StatusDot session={session} /> <WorkerLabel session={session} />
          {/* Unsent composer draft → DRAFT tag (shown wherever a session is listed,
              not just NEEDS YOUR ATTENTION). The session is also lifted by its
              draft-edit time via compareRecency. */}
          {session.draftUpdatedAt && (
            <span
              className="flex-none rounded border border-input px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
              title="Unsent draft"
            >
              Draft
            </span>
          )}
          {backFromSnooze && (
            <span
              className="flex-none rounded border border-amber-500/40 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
              title="Snooze ended — back in your queue"
            >
              Returned
            </span>
          )}
          {/* The agent's /color identity accent — a short vertical line right of
              the name (distinct from the status dot, which is its state). */}
          {agentColorHex(session.agentColor) && (
            <span
              className="ml-0.5 h-3 w-[2px] flex-none rounded-full"
              style={{ background: agentColorHex(session.agentColor) }}
              aria-hidden="true"
            />
          )}
          {/* Pinned panels span repos/worktrees, so show which one — compact two
              lines (repo bold, branch below) where the kind label used to sit. */}
          {pinned && <RepoBranchTag cwd={session.cwd} />}
        </button>
      )}
      {badge?.showContinue && (
        <Button
          variant="destructive"
          size="sm"
          className="h-auto border border-destructive/50 bg-transparent px-2 py-px text-[11px] font-normal hover:bg-destructive/10"
          title="Send 'continue' to the errored agent"
          onClick={() => void continueSession(session.sessionId)}
        >
          Continue
        </Button>
      )}
      {/* Pin: lit when pinned, otherwise hidden until row hover (so on attention
          rows it never competes with the always-on, rightmost snooze control). */}
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          'w-7 min-w-7 flex-none rounded-none',
          // Unpinned: hidden (label keeps full width) until row hover; pinned: lit.
          pinned
            ? 'text-primary'
            : 'hidden text-muted-foreground/70 hover:text-foreground group-hover:inline-flex',
        )}
        aria-pressed={pinned}
        title={pinned ? 'Unpin panel' : 'Pin panel'}
        onClick={() => onPinned(!pinned)}
      >
        <Pin size={13} aria-hidden="true" />
      </Button>
      {/* Close (kill) — revealed on row hover, matching the tab strip's X. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden w-7 min-w-7 flex-none rounded-none text-muted-foreground/70 hover:text-destructive group-hover:inline-flex"
        title="Close session"
        onClick={() => void guardedKill(session.sessionId)}
      >
        <X size={13} aria-hidden="true" />
      </Button>
      {/* Rightmost + always visible (never shifts when pin/close reveal on hover).
          On attention rows: the snooze control. Elsewhere (worktree/pinned/working):
          only when snoozed, so it reads as an un-snooze affordance — never a plain
          "snooze" icon outside NEEDS YOUR ATTENTION. */}
      {(attention || snoozed) && <SnoozeControl session={session} />}
    </div>
  )
}

/** Compact repo/branch stamp for a pinned panel: repo bold on top, branch muted
 *  below. Full "repo · branch" on the hover title. */
function RepoBranchTag({ cwd }: { cwd: string }): JSX.Element | null {
  const { repos } = useStore()
  const rb = repoBranchForCwd(repos, cwd)
  if (!rb) return null
  return (
    <span
      className="ml-auto flex flex-none flex-col items-end pl-2 leading-tight"
      title={rb.branch ? `${rb.repo} · ${rb.branch}` : rb.repo}
    >
      <span className="max-w-[12ch] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold text-foreground/80">
        {rb.repo}
      </span>
      {rb.branch && (
        <span className="max-w-[12ch] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] text-muted-foreground/70">
          {rb.branch}
        </span>
      )}
    </span>
  )
}

function PinButton({
  kind,
  id,
  pinned,
  label,
  setPinned,
  revealClass,
}: {
  kind: PinKind
  id: string
  pinned: boolean
  label: string
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** Group-hover class that reveals the pin when it isn't pinned (e.g.
   *  `group-hover/repo:inline-flex`). Pinned pins stay visible regardless. */
  revealClass: string
}): JSX.Element {
  const title = `${pinned ? 'Unpin' : 'Pin'} ${label}`
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        'w-7 min-w-7 flex-none rounded-none',
        // Unpinned pins are hidden (no reserved width, so the label spans full
        // width) and only surface on row hover; pinned pins stay lit.
        pinned
          ? 'text-primary'
          : cn('hidden text-muted-foreground/70 hover:text-foreground', revealClass),
      )}
      aria-pressed={pinned}
      title={title}
      onClick={() => void setPinned(kind, id, !pinned)}
    >
      <Pin size={13} aria-hidden="true" />
    </Button>
  )
}
