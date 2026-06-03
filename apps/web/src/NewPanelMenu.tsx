import type { JSX } from 'react'
import { useStore } from './store'
import { resumableForWorktree } from './derive'
import type { WorktreeView } from './types'

export function NewPanelMenu({
  worktree,
  onOpened,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: string) => void
}): JSX.Element {
  const { trpc, conversations } = useStore()
  const resumable = resumableForWorktree(conversations, worktree.path)

  async function create(agentKind: 'claude-code' | 'codex') {
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind, cwd: worktree.path })
    onOpened(sessionId)
  }
  async function resume(c: (typeof resumable)[number]) {
    if (!c.resume) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: c.agentKind,
      cwd: worktree.path,
      resume: c.resume,
      conversationId: c.id,
      ...(c.title ? { title: c.title } : {}),
    })
    onOpened(sessionId)
  }

  return (
    <div className="new-panel-menu">
      <button type="button" onClick={() => void create('claude-code')}>New Claude</button>
      <button type="button" onClick={() => void create('codex')}>New Codex</button>
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
