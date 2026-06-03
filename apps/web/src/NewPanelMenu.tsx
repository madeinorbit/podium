import type { JSX } from 'react'
import { reposToViews, resumableForRepoFallback, resumableForWorktree } from './derive'
import { useStore } from './store'
import type { WorktreeView } from './types'

export function NewPanelMenu({
  worktree,
  onOpened,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: string) => void
}): JSX.Element {
  const { trpc, conversations, repos } = useStore()
  const exact = resumableForWorktree(conversations, worktree.path)
  // The repo's main worktree also surfaces conversations that ran under the repo but
  // matched no worktree exactly, so none are lost.
  const repoView = reposToViews(repos).find((r) => r.path === worktree.repoPath)
  const repoWorktreePaths = repoView ? repoView.worktrees.map((w) => w.path) : [worktree.path]
  const fallback = worktree.isMain
    ? resumableForRepoFallback(conversations, worktree.repoPath, repoWorktreePaths)
    : []
  const resumable = [...exact, ...fallback]

  async function create(agentKind: 'claude-code' | 'codex') {
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind, cwd: worktree.path })
    onOpened(sessionId)
  }
  async function resume(c: (typeof resumable)[number]) {
    if (!c.resume) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: c.agentKind,
      cwd: c.projectPath ?? worktree.path,
      resume: c.resume,
      conversationId: c.id,
      ...(c.title ? { title: c.title } : {}),
    })
    onOpened(sessionId)
  }

  return (
    <div className="new-panel-menu">
      <button type="button" onClick={() => void create('claude-code')}>
        New Claude
      </button>
      <button type="button" onClick={() => void create('codex')}>
        New Codex
      </button>
      <div className="menu-section">Resume</div>
      {resumable.length === 0 && <div className="menu-empty">No matching history</div>}
      {resumable.map((c) => (
        <button key={c.id} type="button" onClick={() => void resume(c)}>
          ↻ {c.title ?? c.id}
        </button>
      ))}
    </div>
  )
}
