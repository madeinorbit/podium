import { Home, Pin, Settings as SettingsIcon } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import {
  orderTabs,
  type RepoNavView,
  reposToViews,
  sessionsForWorktree,
  sidebarSections,
  type WorktreeNavView,
} from './derive'
import { HomeView } from './HomeView'
import { HostIndicators } from './HostIndicators'
import { NewPanelMenu } from './NewPanelMenu'
import { RepoScanFlow } from './RepoScanFlow'
import { SettingsView } from './SettingsView'
import { useStore } from './store'
import type { PinKind } from './types'
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
    const apply = () => root.style.setProperty('--viewport-h', `${Math.round(vv.height)}px`)
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--viewport-h')
    }
  }, [])
}

export function MobileApp(): JSX.Element {
  useVisualViewportHeight()
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
  const tabs = worktree
    ? orderTabs(sessionsForWorktree(sessions, worktree.path), store.tabOrders[worktree.path], pins)
    : []
  const [pickerOpen, setPickerOpen] = useState(false)
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const hasRows =
    sections.pinnedWorktrees.length > 0 ||
    sections.pinnedRepos.length > 0 ||
    sections.repos.length > 0

  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  const pickWorktree = (path: string) => {
    setSelectedWorktree(path)
    setPickerOpen(false)
    setView('workspace')
  }

  return (
    <div className="mobile-shell">
      <header className="mobile-head">
        <button
          type="button"
          className={view === 'home' ? 'mobile-home active' : 'mobile-home'}
          title="Command center"
          onClick={() => setView('home')}
        >
          <Home size={15} aria-hidden="true" />
        </button>
        <button type="button" className="wt-picker" onClick={() => setPickerOpen(true)}>
          {worktree ? (worktree.branch ?? worktree.path.split('/').pop()) : 'Select worktree'} ▾
        </button>
        <div className="mobile-tabs">
          {tabs.map((t) => {
            const pinned = pins.panels.includes(t.sessionId)
            return (
              <span key={t.sessionId} className="tab-wrap">
                <button
                  type="button"
                  className={t.sessionId === paneA ? 'tab active' : 'tab'}
                  onClick={() => setPane('A', t.sessionId)}
                >
                  <span className={`dot ${t.status}`} /> <WorkerLabel session={t} />
                </button>
                <button
                  type="button"
                  className={pinned ? 'tab-pin active' : 'tab-pin'}
                  aria-pressed={pinned}
                  title={pinned ? 'Unpin panel' : 'Pin panel'}
                  onClick={() => void setPinned('panel', t.sessionId, !pinned)}
                >
                  <Pin size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="tab-kill"
                  title="Kill session"
                  onClick={() => void killSession(t.sessionId)}
                >
                  ✕
                </button>
              </span>
            )
          })}
          {worktree && (
            <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>
              +
            </button>
          )}
        </div>
        <HostIndicators />
      </header>
      {menuOpen && worktree && (
        <NewPanelMenu
          worktree={worktree}
          onOpened={(sid) => {
            setPane('A', sid)
            setMenuOpen(false)
          }}
        />
      )}
      <div className="mobile-body">
        {view === 'home' ? (
          <HomeView />
        ) : paneA ? (
          <AgentPanel sessionId={paneA} />
        ) : (
          <div className="pane-empty">No panel - use + to start one.</div>
        )}
      </div>
      {pickerOpen && (
        <div className="picker-sheet">
          <div className="sheet-head">
            <span className="label">WORKTREES</span>
            <div className="sheet-actions">
              <button type="button" onClick={() => setRepoPickerOpen(true)}>
                + Add repo
              </button>
              <button type="button" title="Settings" onClick={() => setSettingsOpen(true)}>
                <SettingsIcon size={14} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setPickerOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          {(reposLoading || repoDiagnostics.length > 0) && (
            <div className="scan-status">
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
            <div className="empty">
              {reposLoading ? 'Loading repositories...' : 'No repos yet. Add a folder to scan.'}
            </div>
          )}
        </div>
      )}
      {repoPickerOpen && (
        <RepoScanFlow
          onClose={() => setRepoPickerOpen(false)}
          onDone={() => setRepoPickerOpen(false)}
        />
      )}
      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function PickerSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="picker-section">
      <div className="pin-section-label">{label}</div>
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
      <div className="repo-head sheet-repo-head">
        <div className="repo-name">{repo.name}</div>
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
    <div className="sheet-row-wrap">
      <button type="button" className="sheet-row" onClick={() => onPick(worktree.path)}>
        <span>{worktree.branch ?? worktree.path.split('/').pop()}</span>
        {pinned && <span className="worktree-context">{worktree.repoName}</span>}
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
      className={pinned ? 'pin-button active' : 'pin-button'}
      aria-pressed={pinned}
      title={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
      onClick={() => void setPinned(kind, id, !pinned)}
    >
      <Pin size={13} aria-hidden="true" />
    </button>
  )
}
