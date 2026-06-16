import {
  BarChart3,
  ChevronDown,
  Home,
  Pin,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import {
  orderTabs,
  type RepoNavView,
  reposToViews,
  sessionDotClass,
  sessionsForWorktree,
  sidebarSections,
  type WorktreeNavView,
} from './derive'
import { HomeView } from './HomeView'
import { HostIndicators } from './HostIndicators'
import { NewPanelMenu } from './NewPanelMenu'
import { RepoScanFlow } from './RepoScanFlow'
import { SearchView } from './SearchView'
import { SettingsView } from './SettingsView'
import { SuperagentView } from './SuperagentView'
import { useStore } from './store'
import type { PinKind } from './types'
import { UsageView } from './UsageView'
import { WorkerLabel } from './WorkerLabel'

/**
 * Pin the mobile shell to the visual viewport. The layout viewport (what dvh
 * tracks) does not shrink when the soft keyboard opens on iOS, so a bottom-anchored
 * key bar would hide behind the keyboard. Tracking visualViewport.height into
 * --viewport-h shrinks the shell to the visible area, leaving the key bar flush
 * above the keyboard. No-op where visualViewport is unavailable.
 */
function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    // iOS scrolls the document when the keyboard opens or when a drag escapes a
    // scrollable region, sliding the shell up and exposing blank page below it.
    // The shell is sized to the visual viewport, so document scroll is never
    // legitimate — snap it back.
    const pin = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    const apply = () => {
      root.style.setProperty('--viewport-h', `${Math.round(vv.height)}px`)
      // The soft keyboard eats the bottom of the visual viewport, and while it's up
      // the home-indicator safe area is hidden behind it — so reserving safe-area
      // padding on the bottom key bar then just leaves a dead gap above the keyboard.
      // Flag keyboard-open (layout viewport minus visual viewport > a threshold the
      // URL-bar can't reach) so the bar drops that padding (see --kb-open in CSS).
      const kbOpen = (window.innerHeight || vv.height) - vv.height > 150
      root.style.setProperty('--kb-open', kbOpen ? '1' : '0')
      pin()
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('scroll', pin)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      window.removeEventListener('scroll', pin)
      root.style.removeProperty('--viewport-h')
      root.style.removeProperty('--kb-open')
    }
  }, [])
}

export function MobileApp(): JSX.Element {
  useVisualViewportHeight()
  const isMobile = useIsMobile()
  const store = useStore()
  const {
    sessions,
    pins,
    setPinned,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    setPane,
    killSession,
    view,
    setView,
  } = store
  const { reposLoading, repoDiagnostics } = store
  const repoViews = reposToViews(store.repos)
  const sections = sidebarSections(store.repos, sessions, pins)
  const worktree = repoViews.flatMap((r) => r.worktrees).find((w) => w.path === selectedWorktree)
  const worktreeRepoName = worktree
    ? (repoViews.find((r) => r.path === worktree.repoPath)?.name ??
      worktree.repoPath.split('/').pop())
    : null
  const tabs = worktree
    ? orderTabs(sessionsForWorktree(sessions, worktree.path), store.tabOrders[worktree.path], pins)
    : []
  const [pickerOpen, setPickerOpen] = useState(false)
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // Hold a freshly-opened (or reload-restored) session in pane A until the store
  // knows it — see the keep-pane-valid effect — otherwise it bounces to tabs[0].
  const justOpened = useRef<string | null>(paneA)
  const currentTab = tabs.find((t) => t.sessionId === paneA)
  const hasRows =
    sections.pinnedWorktrees.length > 0 ||
    sections.pinnedRepos.length > 0 ||
    sections.repos.length > 0

  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) {
      justOpened.current = null
      return
    }
    if (paneA && justOpened.current === paneA && !sessions.some((s) => s.sessionId === paneA)) {
      return
    }
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane, sessions])

  const pickWorktree = (path: string) => {
    setSelectedWorktree(path)
    setPickerOpen(false)
    setSessionMenuOpen(false)
    setView('workspace')
  }
  // Any interaction with the work area (tapping into the agent, switching
  // chat/native, starting to type) should dismiss the open work-panel selectors —
  // they otherwise sit over the panel and block it.
  const closePanelMenus = () => {
    setSessionMenuOpen(false)
    setMenuOpen(false)
  }

  return (
    <div className="flex touch-manipulation h-[var(--viewport-h,100dvh)] flex-col">
      <header
        className="flex items-stretch border-b border-border bg-card pt-[var(--safe-top)]"
        style={{ height: 'calc(44px + var(--safe-top))' }}
      >
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            view === 'home' && 'text-primary',
          )}
          title="Command center"
          onClick={() => setView('home')}
        >
          <Home size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            view === 'superagent' && 'text-primary',
          )}
          title="Superagent"
          onClick={() => setView('superagent')}
        >
          <Sparkles size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flex min-w-0 max-w-[45%] items-center overflow-hidden border-r border-border px-2 text-left text-xs text-foreground"
          onClick={() => setPickerOpen(true)}
        >
          {worktree ? (
            <span className="flex min-w-0 flex-col items-start leading-[1.15]">
              <span className="max-w-full truncate text-[10px] tracking-[0.02em] text-muted-foreground">
                {worktreeRepoName}
              </span>
              <span className="max-w-full truncate text-[13px] font-medium text-foreground">
                {worktree.branch ?? worktree.path.split('/').pop()} ▾
              </span>
            </span>
          ) : (
            'Select worktree'
          )}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
          {tabs.length > 0 && (
            <button
              type="button"
              className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-medium text-foreground"
              aria-expanded={sessionMenuOpen}
              onClick={() => setSessionMenuOpen((v) => !v)}
            >
              {currentTab ? (
                <>
                  <span className={sessionDotClass(currentTab)} />{' '}
                  <WorkerLabel session={currentTab} />
                </>
              ) : (
                'Sessions'
              )}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          )}
          {worktree && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New panel"
              onClick={() => setMenuOpen((v) => !v)}
            >
              +
            </Button>
          )}
        </div>
        <HostIndicators compact />
      </header>
      {sessionMenuOpen && tabs.length > 0 && (
        <div className="flex flex-col border-b border-border bg-muted shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
          {tabs.map((t) => {
            const pinned = pins.panels.includes(t.sessionId)
            return (
              <div
                key={t.sessionId}
                className="flex items-center border-b border-border last:border-b-0"
              >
                <button
                  type="button"
                  className={cn(
                    'inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden whitespace-nowrap p-3 text-left text-[13px]',
                    t.sessionId === paneA ? 'text-foreground' : 'text-muted-foreground',
                  )}
                  onClick={() => {
                    setPane('A', t.sessionId)
                    setSessionMenuOpen(false)
                    setView('workspace')
                  }}
                >
                  <span className={sessionDotClass(t)} /> <WorkerLabel session={t} />
                </button>
                <button
                  type="button"
                  className={cn(
                    'cursor-pointer px-2.5 py-3 text-[13px]',
                    pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-primary',
                  )}
                  aria-pressed={pinned}
                  title={pinned ? 'Unpin panel' : 'Pin panel'}
                  onClick={() => void setPinned('panel', t.sessionId, !pinned)}
                >
                  <Pin size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cursor-pointer px-2.5 py-3 text-[13px] text-muted-foreground/70 hover:text-destructive"
                  title="Kill session"
                  onClick={() => void killSession(t.sessionId)}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
      {menuOpen && worktree && (
        <NewPanelMenu
          worktree={worktree}
          onOpened={(sid) => {
            justOpened.current = sid
            setPane('A', sid)
            setMenuOpen(false)
            setView('workspace')
          }}
        />
      )}
      <div className="relative flex min-h-0 flex-1" onPointerDownCapture={closePanelMenus}>
        {view === 'home' ? (
          <HomeView />
        ) : view === 'superagent' ? (
          <SuperagentView />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : paneA ? (
          <AgentPanel sessionId={paneA} />
        ) : (
          <div className="m-auto text-[13px] text-muted-foreground/70">
            No panel - use + to start one.
          </div>
        )}
      </div>
      <Dialog
        open={pickerOpen}
        modal={isMobile ? 'trap-focus' : true}
        onOpenChange={(o) => {
          if (!o) setPickerOpen(false)
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="fixed inset-x-0 bottom-0 top-auto left-0 grid max-h-[85%] w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-t-xl rounded-b-none bg-background p-0 pb-[max(var(--safe-bottom),env(safe-area-inset-bottom))] ring-0"
        >
          <div
            className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background"
            style={{
              padding:
                'calc(10px + var(--safe-top)) calc(12px + var(--safe-right)) 10px calc(12px + var(--safe-left))',
            }}
          >
            <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              WORKTREES
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRepoPickerOpen(true)}>
                + Add repo
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                title="Search conversations"
                aria-label="Search conversations"
                onClick={() => {
                  // Close the sheet first: the search modal and this sheet are
                  // sibling overlays, and leaving the sheet up meant the search
                  // (depending on stacking) never reached the foreground.
                  setPickerOpen(false)
                  setSearchOpen(true)
                }}
              >
                <Search size={14} aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                title="Usage & analytics"
                aria-label="Usage & analytics"
                onClick={() => {
                  setPickerOpen(false)
                  setView('usage')
                }}
              >
                <BarChart3 size={14} aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                title="Settings"
                aria-label="Settings"
                onClick={() => {
                  setPickerOpen(false)
                  setView('settings')
                }}
              >
                <SettingsIcon size={14} aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Close"
                onClick={() => setPickerOpen(false)}
              >
                <X size={14} aria-hidden="true" />
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
          {sections.pinnedWorktrees.length > 0 && (
            <PickerSection label="PINNED WORKTREES">
              {sections.pinnedWorktrees.map((wt) => (
                <SheetWorktree
                  key={wt.path}
                  worktree={wt}
                  pinned={true}
                  onPick={pickWorktree}
                  setPinned={setPinned}
                />
              ))}
            </PickerSection>
          )}
          {sections.pinnedRepos.length > 0 && (
            <PickerSection label="PINNED REPOS">
              {sections.pinnedRepos.map((repo) => (
                <SheetRepo
                  key={repo.path}
                  repo={repo}
                  pinned={true}
                  onPick={pickWorktree}
                  setPinned={setPinned}
                />
              ))}
            </PickerSection>
          )}
          {sections.repos.map((repo) => (
            <SheetRepo
              key={repo.path}
              repo={repo}
              pinned={false}
              onPick={pickWorktree}
              setPinned={setPinned}
            />
          ))}
          {!hasRows && (
            <div className="p-3 text-xs text-muted-foreground/70">
              {reposLoading ? 'Loading repositories...' : 'No repos yet. Add a folder to scan.'}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {repoPickerOpen && (
        <RepoScanFlow
          onClose={() => setRepoPickerOpen(false)}
          onDone={() => setRepoPickerOpen(false)}
        />
      )}
      {searchOpen && <SearchView onClose={() => setSearchOpen(false)} />}
    </div>
  )
}

function PickerSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="border-b border-border py-1">
      <div className="px-3 pt-2 pb-[3px] text-[10px] font-bold uppercase tracking-[0.08em] text-primary">
        {label}
      </div>
      {children}
    </div>
  )
}

function SheetRepo({
  repo,
  pinned,
  onPick,
  setPinned,
}: {
  repo: RepoNavView
  pinned: boolean
  onPick: (path: string) => void
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between border-b border-border pr-2">
        <div className="min-w-0 flex-1 px-3 pt-1.5 pb-0.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/70">
          {repo.name}
        </div>
        <PinToggle
          kind="repo"
          id={repo.path}
          pinned={pinned}
          label={repo.name}
          setPinned={setPinned}
        />
      </div>
      {repo.worktrees.map((wt) => (
        <SheetWorktree
          key={wt.path}
          worktree={wt}
          pinned={false}
          onPick={onPick}
          setPinned={setPinned}
        />
      ))}
    </div>
  )
}

function SheetWorktree({
  worktree,
  pinned,
  onPick,
  setPinned,
}: {
  worktree: WorktreeNavView
  pinned: boolean
  onPick: (path: string) => void
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-stretch">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center justify-between border-b border-border p-3 text-left text-foreground hover:bg-muted"
        onClick={() => onPick(worktree.path)}
      >
        <span className="min-w-0 truncate">
          {worktree.branch ?? worktree.path.split('/').pop()}
        </span>
        {pinned && (
          <span className="min-w-0 max-w-[90px] flex-[0_1_auto] truncate text-[10px] text-muted-foreground/70">
            {worktree.repoName}
          </span>
        )}
      </button>
      <PinToggle
        kind="worktree"
        id={worktree.path}
        pinned={pinned}
        label={worktree.branch ?? worktree.path}
        setPinned={setPinned}
      />
    </div>
  )
}

function PinToggle({
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
  return (
    <button
      type="button"
      className={cn(
        'inline-flex w-7 min-w-7 flex-[0_0_28px] cursor-pointer items-center justify-center',
        pinned ? 'text-primary' : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground',
      )}
      aria-pressed={pinned}
      title={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
      onClick={() => void setPinned(kind, id, !pinned)}
    >
      <Pin size={13} aria-hidden="true" />
    </button>
  )
}
