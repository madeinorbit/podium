import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from './store'
import { reposToViews, sessionsForWorktree } from './derive'
import { AgentPanel } from './AgentPanel'
import { NewPanelMenu } from './NewPanelMenu'

export function MobileApp(): JSX.Element {
  const store = useStore()
  const { sessions, selectedWorktree, setSelectedWorktree, paneA, setPane } = store
  const repoViews = reposToViews(store.repos)
  const worktree = repoViews.flatMap((r) => r.worktrees).find((w) => w.path === selectedWorktree)
  const tabs = worktree ? sessionsForWorktree(sessions, worktree.path) : []
  const [pickerOpen, setPickerOpen] = useState(false)
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
            <button
              key={t.sessionId}
              type="button"
              className={t.sessionId === paneA ? 'tab active' : 'tab'}
              onClick={() => setPane('A', t.sessionId)}
            >
              <span className={`dot ${t.status}`} /> {t.agentKind}
            </button>
          ))}
          {worktree && (
            <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>+</button>
          )}
        </div>
      </header>
      {menuOpen && worktree && (
        <NewPanelMenu worktree={worktree} onOpened={(sid) => { setPane('A', sid); setMenuOpen(false) }} />
      )}
      <div className="mobile-body">
        {paneA ? <AgentPanel sessionId={paneA} /> : <div className="pane-empty">No panel — use + to start one.</div>}
      </div>
      {pickerOpen && (
        <div className="picker-sheet">
          <div className="sheet-head">
            <span className="label">WORKTREES</span>
            <button type="button" onClick={() => setPickerOpen(false)}>✕</button>
          </div>
          {repoViews.map((repo) => (
            <div key={repo.path}>
              <div className="repo-name">{repo.name}</div>
              {repo.worktrees.map((wt) => (
                <button
                  key={wt.path}
                  type="button"
                  className="sheet-row"
                  onClick={() => { setSelectedWorktree(wt.path); setPickerOpen(false) }}
                >
                  {wt.branch ?? wt.path.split('/').pop()}
                </button>
              ))}
            </div>
          ))}
          {repoViews.length === 0 && <div className="empty">No repos. Add one on desktop.</div>}
        </div>
      )}
    </div>
  )
}
