import type { JSX } from 'react'
import { useState } from 'react'
import { panelLabel, reposToViews, sessionsForWorktree } from './derive'
import { RepoScanFlow } from './RepoScanFlow'
import { useStore } from './store'

export function Sidebar(): JSX.Element {
  const { repos, reposLoading, repoDiagnostics, sessions, selectedWorktree, setSelectedWorktree } =
    useStore()
  const repoViews = reposToViews(repos)
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="label">WORKTREES</span>
        <button type="button" onClick={() => setPickerOpen(true)}>
          + Add repo
        </button>
      </div>
      {(reposLoading || repoDiagnostics.length > 0) && (
        <div className="scan-status">
          {reposLoading
            ? 'Loading repositories...'
            : `Scan finished with ${repoDiagnostics.length} warning${repoDiagnostics.length === 1 ? '' : 's'}.`}
        </div>
      )}
      <div className="sidebar-list">
        {repoViews.map((repo) => (
          <div key={repo.path} className="repo">
            <div className="repo-name">{repo.name}</div>
            {repo.worktrees.map((wt) => {
              const wtSessions = sessionsForWorktree(sessions, wt.path)
              const active = selectedWorktree === wt.path
              return (
                <div key={wt.path}>
                  <button
                    type="button"
                    className={active ? 'worktree active' : 'worktree'}
                    onClick={() => setSelectedWorktree(wt.path)}
                  >
                    <span className="branch">{wt.branch ?? wt.path.split('/').pop()}</span>
                    {wt.isMain && <span className="tag">main</span>}
                  </button>
                  {wtSessions.map((s) => (
                    <div key={s.sessionId} className="panel-row">
                      <span className={`dot ${s.status}`} /> {panelLabel(s.agentKind)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
        {repoViews.length === 0 && (
          <div className="empty">No repos yet. Use “+ Add repo” to scan a folder.</div>
        )}
      </div>
      {pickerOpen && (
        <RepoScanFlow onClose={() => setPickerOpen(false)} onDone={() => setPickerOpen(false)} />
      )}
    </aside>
  )
}
