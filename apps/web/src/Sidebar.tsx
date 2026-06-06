import type { JSX } from 'react'
import { useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { panelLabel, reposToViews, sessionsForWorktree } from './derive'
import { RepoPickerModal } from './RepoPickerModal'
import { useStore } from './store'

export function Sidebar(): JSX.Element {
  const {
    repos,
    reposLoading,
    repoDiagnostics,
    sessions,
    selectedWorktree,
    setSelectedWorktree,
    trpc,
    rescanRepos,
  } = useStore()
  const repoViews = reposToViews(repos)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function addRepo(path: string): Promise<void> {
    try {
      await trpc.repos.add.mutate({ path })
      await rescanRepos()
      setError(null)
    } catch (e) {
      const message = formatAppError(e, 'Failed to add repo')
      setError(message)
      throw new Error(message)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="label">WORKTREES</span>
        <button
          type="button"
          onClick={() => {
            setPickerOpen(true)
            setError(null)
          }}
        >
          + Add repo
        </button>
      </div>
      {error && <div className="add-repo-error sidebar-error">{error}</div>}
      {(reposLoading || repoDiagnostics.length > 0) && (
        <div className="scan-status">
          {reposLoading
            ? 'Scanning repositories...'
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
          <div className="empty">
            {reposLoading ? 'Scanning repositories...' : 'No repos found. Add a folder to scan.'}
          </div>
        )}
      </div>
      {pickerOpen && (
        <RepoPickerModal onClose={() => setPickerOpen(false)} onPick={(path) => addRepo(path)} />
      )}
    </aside>
  )
}
