import type { SessionMeta } from '@podium/protocol'
import { BarChart3, Home, Pin, Search, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  agentBadge,
  agentColorHex,
  type RepoNavView,
  repoBranchForCwd,
  sessionDotClass,
  sidebarSections,
  type WorktreeNavView,
} from './derive'
import { HostIndicators } from './HostIndicators'
import { RepoScanFlow } from './RepoScanFlow'
import { SearchView } from './SearchView'
import { useStore } from './store'
import type { PinKind } from './types'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from './WorkerLabel'

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
  } = useStore()
  const sections = sidebarSections(repos, sessions, pins)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const hasRows =
    sections.pinnedPanels.length > 0 ||
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
      {/* App-level tools row. Analytics + settings live here (a fullscreen view
          each, not a modal); future machine-wide tools join this strip. */}
      <div className="flex items-center gap-1 px-3 pt-0.5 pb-1">
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
      </div>
      <div className="flex items-center justify-between p-3">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
          WORKTREES
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-auto border-input px-2 py-[3px] text-xs font-normal text-muted-foreground hover:border-primary hover:text-foreground"
            onClick={() => setPickerOpen(true)}
          >
            + Add repo
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="border border-input text-muted-foreground hover:border-primary hover:text-foreground"
            title="Search conversations"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {(reposLoading || repoDiagnostics.length > 0) && (
        <div className="px-3 pt-1.5 pb-2 text-xs text-muted-foreground">
          {reposLoading
            ? 'Loading repositories...'
            : `Scan finished with ${repoDiagnostics.length} warning${repoDiagnostics.length === 1 ? '' : 's'}.`}
        </div>
      )}
      <div className="flex-1 overflow-y-auto pb-3">
        {sections.pinnedPanels.length > 0 && (
          <PinnedSection label="PINNED PANELS">
            {sections.pinnedPanels.map((session) => (
              <PanelRow
                key={session.sessionId}
                session={session}
                pinned={true}
                active={selectedWorktree === session.cwd && paneA === session.sessionId}
                onSelect={() => selectPanel(session.cwd, session.sessionId)}
                onPinned={(pinned) => void setPinned('panel', session.sessionId, pinned)}
              />
            ))}
          </PinnedSection>
        )}

        {sections.pinnedWorktrees.length > 0 && (
          <PinnedSection label="PINNED WORKTREES">
            {sections.pinnedWorktrees.map((worktree) => (
              <WorktreeBlock
                key={worktree.path}
                worktree={worktree}
                pinned={true}
                active={selectedWorktree === worktree.path}
                paneA={paneA}
                setPinned={setPinned}
                onSelectWorktree={() => selectWorktree(worktree.path)}
                onSelectPanel={selectPanel}
              />
            ))}
          </PinnedSection>
        )}

        {sections.pinnedRepos.length > 0 && (
          <PinnedSection label="PINNED REPOS">
            {sections.pinnedRepos.map((repo) => (
              <RepoBlock
                key={repo.path}
                repo={repo}
                pinned={true}
                selectedWorktree={selectedWorktree}
                paneA={paneA}
                setPinned={setPinned}
                onSelectWorktree={selectWorktree}
                onSelectPanel={selectPanel}
              />
            ))}
          </PinnedSection>
        )}

        {sections.repos.map((repo) => (
          <RepoBlock
            key={repo.path}
            repo={repo}
            pinned={false}
            selectedWorktree={selectedWorktree}
            paneA={paneA}
            setPinned={setPinned}
            onSelectWorktree={selectWorktree}
            onSelectPanel={selectPanel}
          />
        ))}

        {!hasRows && (
          <div className="p-3 text-xs text-muted-foreground/70">
            No repos yet. Use "+ Add repo" to scan a folder.
          </div>
        )}
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

function PinnedSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 border-b border-border py-1">
      <div className="px-3 pt-2 pb-[3px] text-[10px] font-bold tracking-[0.08em] uppercase text-primary">
        {label}
      </div>
      {children}
    </div>
  )
}

function RepoBlock({
  repo,
  pinned,
  selectedWorktree,
  paneA,
  setPinned,
  onSelectWorktree,
  onSelectPanel,
}: {
  repo: RepoNavView
  pinned: boolean
  selectedWorktree: string | null
  paneA: string | null
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: (path: string) => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
}): JSX.Element {
  return (
    <div className="mt-1">
      <div className="flex items-center justify-between pr-2">
        <div className="min-w-0 flex-1 px-3 pt-1.5 pb-0.5 text-[11px] tracking-[0.06em] uppercase text-muted-foreground/70">
          {repo.name}
        </div>
        <PinButton
          kind="repo"
          id={repo.path}
          pinned={pinned}
          label={repo.name}
          setPinned={setPinned}
        />
      </div>
      {repo.worktrees.map((worktree) => (
        <WorktreeBlock
          key={worktree.path}
          worktree={worktree}
          pinned={false}
          active={selectedWorktree === worktree.path}
          paneA={paneA}
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
  setPinned,
  onSelectWorktree,
  onSelectPanel,
}: {
  worktree: WorktreeNavView
  pinned: boolean
  active: boolean
  paneA: string | null
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: () => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-stretch">
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
        />
      </div>
      {worktree.sessions.map((session) => {
        const panelActive = active && paneA === session.sessionId
        return (
          <PanelRow
            key={session.sessionId}
            session={session}
            pinned={false}
            active={panelActive}
            onSelect={() => onSelectPanel(worktree.path, session.sessionId)}
            onPinned={(pinned) => void setPinned('panel', session.sessionId, pinned)}
          />
        )
      })}
    </div>
  )
}

function PanelRow({
  session,
  pinned,
  active,
  onSelect,
  onPinned,
}: {
  session: SessionMeta
  pinned: boolean
  active: boolean
  onSelect: () => void
  onPinned: (pinned: boolean) => void
}): JSX.Element {
  const { continueSession, killSession, renameSession } = useStore()
  const badge = agentBadge(session)
  const [editing, setEditing] = useState(false)
  return (
    <div className="group flex min-w-0 items-center gap-1">
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
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          'w-7 min-w-7 flex-none rounded-none',
          pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
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
        onClick={() => void killSession(session.sessionId)}
      >
        <X size={13} aria-hidden="true" />
      </Button>
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
}: {
  kind: PinKind
  id: string
  pinned: boolean
  label: string
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
}): JSX.Element {
  const title = `${pinned ? 'Unpin' : 'Pin'} ${label}`
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        'w-7 min-w-7 flex-none rounded-none',
        pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
      )}
      aria-pressed={pinned}
      title={title}
      onClick={() => void setPinned(kind, id, !pinned)}
    >
      <Pin size={13} aria-hidden="true" />
    </Button>
  )
}
