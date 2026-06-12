import type { JSX } from 'react'
import { useState } from 'react'
import { agentBadge, reposToViews, sessionsForWorktree } from './derive'
import { HostIndicators } from './HostIndicators'
import { RepoScanFlow } from './RepoScanFlow'
import { useStore } from './store'
import { WorkerLabel } from './WorkerLabel'

export function Sidebar(): JSX.Element {
  const {
    repos,
    reposLoading,
    repoDiagnostics,
    sessions,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    setPane,
    continueSession,
  } = useStore()
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
                  {wtSessions.map((s) => {
                    const panelActive = active && paneA === s.sessionId
                    const badge = agentBadge(s)
                    return (
                      <div key={s.sessionId} className="panel-row-wrap">
                        <button
                          type="button"
                          className={panelActive ? 'panel-row active' : 'panel-row'}
                          onClick={() => {
                            setSelectedWorktree(wt.path)
                            setPane('A', s.sessionId)
                          }}
                        >
                          <span className={`dot ${s.status}`} /> <WorkerLabel session={s} />
                          {badge && (
                            <span className={`agent-badge ${badge.tone}`}>{badge.label}</span>
                          )}
                        </button>
                        {badge?.showContinue && (
                          <button
                            type="button"
                            className="continue-button"
                            title="Send 'continue' to the errored agent"
                            onClick={() => void continueSession(s.sessionId)}
                          >
                            Continue
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        ))}
        {repoViews.length === 0 && (
          <div className="empty">No repos yet. Use “+ Add repo” to scan a folder.</div>
        )}
      </div>
      {/* Host health strip, pinned under the list — the home for machine-level
          indicators (memory now; connection stability et al. will follow). */}
      <HostIndicators />
      {pickerOpen && (
        <RepoScanFlow onClose={() => setPickerOpen(false)} onDone={() => setPickerOpen(false)} />
      )}
    </aside>
  )
}
