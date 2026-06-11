import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { reposToViews, sessionsForWorktree } from './derive'
import { HostIndicators } from './HostIndicators'
import { NewPanelMenu } from './NewPanelMenu'
import { RepoScanFlow } from './RepoScanFlow'
import { useStore } from './store'
import { WorkerLabel } from './WorkerLabel'

/**
 * Pin the mobile shell to the *visual* viewport. The layout viewport (what `dvh`
 * tracks) does not shrink when the soft keyboard opens on iOS, so a bottom-anchored
 * key bar would hide behind the keyboard. Tracking `visualViewport.height` into
 * `--viewport-h` shrinks the shell to the visible area, leaving the key bar flush
 * above the keyboard. No-op where `visualViewport` is unavailable (falls back to
 * the `100dvh` default in CSS).
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
  const { sessions, selectedWorktree, setSelectedWorktree, paneA, setPane, killSession } = store
  const { reposLoading, repoDiagnostics } = store
  const repoViews = reposToViews(store.repos)
  const worktree = repoViews.flatMap((r) => r.worktrees).find((w) => w.path === selectedWorktree)
  const tabs = worktree ? sessionsForWorktree(sessions, worktree.path) : []
  const [pickerOpen, setPickerOpen] = useState(false)
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  return (
    <div className="mobile-shell">
      <header className="mobile-head">
        <button type="button" className="wt-picker" onClick={() => setPickerOpen(true)}>
          {worktree ? (worktree.branch ?? worktree.path.split('/').pop()) : 'Select worktree'} ▾
        </button>
        <div className="mobile-tabs">
          {tabs.map((t) => (
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
                className="tab-kill"
                title="Kill session"
                onClick={() => void killSession(t.sessionId)}
              >
                ✕
              </button>
            </span>
          ))}
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
        {paneA ? (
          <AgentPanel sessionId={paneA} />
        ) : (
          <div className="pane-empty">No panel — use + to start one.</div>
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
          {repoViews.map((repo) => (
            <div key={repo.path}>
              <div className="repo-name">{repo.name}</div>
              {repo.worktrees.map((wt) => (
                <button
                  key={wt.path}
                  type="button"
                  className="sheet-row"
                  onClick={() => {
                    setSelectedWorktree(wt.path)
                    setPickerOpen(false)
                  }}
                >
                  {wt.branch ?? wt.path.split('/').pop()}
                </button>
              ))}
            </div>
          ))}
          {repoViews.length === 0 && (
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
    </div>
  )
}
