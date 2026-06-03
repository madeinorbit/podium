import type { JSX } from 'react'
import { useState } from 'react'
import { reposToViews, sessionsForWorktree } from './derive'
import { useStore } from './store'

export function Sidebar(): JSX.Element {
  const { repos, sessions, selectedWorktree, setSelectedWorktree, trpc, rescanRepos } = useStore()
  const repoViews = reposToViews(repos)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function addRepo() {
    const p = path.trim()
    if (!p) return
    try {
      await trpc.repos.add.mutate({ path: p })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add repo')
      return
    }
    setError(null)
    setPath('')
    setAdding(false)
    await rescanRepos()
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="label">WORKTREES</span>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v)
            setError(null)
          }}
        >
          + Add repo
        </button>
      </div>
      {adding && (
        <div className="add-repo">
          <input
            value={path}
            placeholder="/absolute/path/to/repo"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addRepo()}
          />
          <button type="button" onClick={() => void addRepo()}>
            Add
          </button>
          {error && <div className="add-repo-error">{error}</div>}
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
                      <span className={`dot ${s.status}`} /> {s.agentKind}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
        {repoViews.length === 0 && <div className="empty">Add a repo to get started.</div>}
      </div>
    </aside>
  )
}
