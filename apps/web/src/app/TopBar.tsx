import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire } from '@podium/protocol'
import {
  BookOpenText,
  ChevronDown,
  Home,
  KanbanSquare,
  Plus,
  RotateCw,
  Sparkles,
} from 'lucide-react'
import type { JSX } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { issueIdTitle } from '@/features/issues/issue-card'
import { HeaderHostIndicators } from '@/features/machines/HostIndicators'
import { pickPaneSession, reposToViews, sessionsForIssueNav } from '@/lib/derive'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'
import { issueColorHex } from '@/lib/issueColors'
import { cn } from '@/lib/utils'
import { NewPanelMenu } from './NewPanelMenu'
import type { SuperagentMode } from './shell-state'
import { useStoreSelector } from './store'
import type { WorktreeView } from './types'

export function TopBar({
  superMode,
  onSuperModeChange,
}: {
  superMode: SuperagentMode
  onSuperModeChange: (mode: SuperagentMode) => void
}): JSX.Element {
  const {
    view,
    setView,
    issues,
    sessions,
    repos,
    fileTabs,
    paneA,
    selectedIssueId,
    selectedWorktree,
    setSelectedIssueId,
    setSelectedWorktree,
    setPane,
    markIssueRead,
  } = useStoreSelector(
    (s) => ({
      view: s.view,
      setView: s.setView,
      issues: s.issues,
      sessions: s.sessions,
      repos: s.repos,
      fileTabs: s.fileTabs,
      paneA: s.paneA,
      selectedIssueId: s.selectedIssueId,
      selectedWorktree: s.selectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setSelectedWorktree: s.setSelectedWorktree,
      setPane: s.setPane,
      markIssueRead: s.markIssueRead,
    }),
    shallowEqual,
  )

  const repoViews = reposToViews(repos)
  const allWorktrees = repoViews.flatMap((r) => r.worktrees)
  const allWorktreePaths = allWorktrees.map((w) => w.path)
  const selectedIssue = selectedIssueId
    ? issues.find((issue) => issue.id === selectedIssueId && !issue.archived && !issue.deletedAt)
    : undefined
  const selectedWorktreeView = allWorktrees.find((worktree) => worktree.path === selectedWorktree)
  const issueWorktree = selectedIssue?.worktreePath
    ? allWorktrees.find((worktree) => worktree.path === selectedIssue.worktreePath)
    : undefined
  const panelTarget: WorktreeView | undefined = selectedIssue
    ? (issueWorktree ??
      allWorktrees.find(
        (worktree) => worktree.repoPath === selectedIssue.repoPath && worktree.isMain,
      ) ?? {
        path: selectedIssue.repoPath,
        repoPath: selectedIssue.repoPath,
        isMain: true,
      })
    : selectedWorktreeView

  const selectIssue = (issue: IssueWire): void => {
    setSelectedIssueId(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    const members = sessionsForIssueNav(issue, sessions, allWorktreePaths, {
      includeShells: true,
    })
    const fileIds = issue.worktreePath
      ? fileTabs.filter((file) => file.worktreePath === issue.worktreePath).map((file) => file.id)
      : []
    setPane('A', pickPaneSession(members, paneA, fileIds))
    void markIssueRead(issue.id)
    setView('workspace')
  }

  const activeIssues = issues
    .filter((issue) => !issue.archived && !issue.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const waitingCount = activeIssues.filter((issue) => issue.needsHuman).length
  const accent = issueColorHex(selectedIssue?.color) ?? 'var(--flow)'

  return (
    <header className="desktop-topbar" data-testid="desktop-topbar">
      <PodiumLogo className="mr-1 flex-none" />
      <nav className="flex h-full flex-none items-stretch" aria-label="Primary">
        <HeaderCell
          label="Home"
          active={view === 'home'}
          onClick={() => setView('home')}
          icon={<Home size={15} aria-hidden="true" />}
          badge={waitingCount}
        />
        <HeaderCell
          label="Superagent"
          active={superMode !== 'closed'}
          pressed={superMode !== 'closed'}
          onClick={() => onSuperModeChange(superMode === 'closed' ? 'open' : 'closed')}
          icon={<Sparkles size={15} aria-hidden="true" />}
        />
        <HeaderCell
          label="Issues"
          active={view === 'issues'}
          pressed={view === 'issues'}
          onClick={() => setView('issues')}
          icon={<KanbanSquare size={15} aria-hidden="true" />}
        />
      </nav>
      <nav className="flex h-full flex-none items-stretch" aria-label="More">
        <HeaderCell
          label="Specs"
          active={view === 'specs'}
          onClick={() => setView('specs')}
          icon={<BookOpenText size={14} aria-hidden="true" />}
          compact
        />
        <HeaderCell
          label="Automations"
          active={view === 'automations'}
          onClick={() => setView('automations')}
          icon={<RotateCw size={14} aria-hidden="true" />}
          compact
        />
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Issue context"
              className="ml-1 flex h-[30px] w-[min(260px,24vw)] min-w-0 items-center gap-2 rounded-[7px] border border-[var(--border-strong)] bg-secondary px-2.5 text-left text-[11px] text-foreground hover:bg-accent"
            >
              <span
                className="size-2 flex-none rounded-[3px]"
                style={{ backgroundColor: accent }}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {selectedIssue
                  ? `#${selectedIssue.seq} · ${selectedIssue.title}`
                  : 'No issue context'}
              </span>
              <ChevronDown
                size={12}
                className="flex-none text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="max-h-[min(70vh,520px)] w-72 overflow-y-auto">
          {activeIssues.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No active issues</div>
          ) : (
            activeIssues.map((issue) => (
              <DropdownMenuItem
                key={issue.id}
                title={issueIdTitle(issue)}
                onClick={() => selectIssue(issue)}
                className="gap-2"
              >
                <span
                  className="size-2 flex-none rounded-[3px]"
                  style={{ backgroundColor: issueColorHex(issue.color) ?? 'var(--flow)' }}
                  aria-hidden="true"
                />
                <span className="font-mono text-[10px] text-muted-foreground">#{issue.seq}</span>
                <span className="min-w-0 truncate">{issue.title}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {panelTarget && (
        <NewPanelMenu
          worktree={panelTarget}
          issueId={selectedIssue?.id}
          onOpened={(sessionId) => {
            setPane('A', sessionId)
            setView('workspace')
          }}
          trigger={
            <button
              type="button"
              aria-label="New agent"
              title="New agent"
              className="flex size-[30px] flex-none items-center justify-center rounded-[7px] border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          }
        />
      )}
      <div className="ml-auto min-w-0 overflow-hidden">
        <HeaderHostIndicators />
      </div>
    </header>
  )
}

function HeaderCell({
  label,
  active,
  pressed,
  onClick,
  icon,
  badge,
  compact = false,
}: {
  label: string
  active: boolean
  pressed?: boolean
  onClick: () => void
  icon: JSX.Element
  badge?: number
  compact?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-full items-center justify-center gap-1.5 border-r border-border px-3 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground',
        active && 'bg-secondary font-semibold text-[var(--text-strong)]',
        compact && 'px-2.5',
      )}
    >
      {icon}
      {!compact && <span className="sr-only">{label}</span>}
      {!!badge && (
        <span className="rounded-full bg-secondary px-1.5 font-mono text-[9px] text-[var(--attention)]">
          {badge}
        </span>
      )}
    </button>
  )
}
