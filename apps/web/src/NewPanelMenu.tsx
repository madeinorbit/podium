import type { AgentKind } from '@podium/protocol'
import { type JSX, useMemo, useState } from 'react'
import { reposToViews } from './derive'
import { relativeTime } from './home'
import { useStore } from './store'
import type { WorktreeView } from './types'
import { type ConversationHit, useConversationSearch } from './useConversationSearch'

const MINI_LIMIT = 8

/**
 * The "+" menu: start a fresh agent/shell, or resume from history. The resume
 * list is the mini search — server-indexed, capped, recency-first, with a
 * filter box — instead of dumping every discovered conversation.
 */
export function NewPanelMenu({
  worktree,
  onOpened,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: string) => void
}): JSX.Element {
  const { trpc, repos } = useStore()
  const [filter, setFilter] = useState('')
  const now = Date.now()
  // Main worktree searches the whole repo subtree so repo-level conversations
  // that matched no specific worktree are not lost; others stay exact.
  const scope = worktree.isMain ? worktree.repoPath : worktree.path

  // Worktrees commonly nest under the repo (e.g. .claude/worktrees/*), so a
  // subtree search from the main checkout would pull in every sibling worktree's
  // conversations and crowd out the repo's own. Exclude paths that belong to
  // another worktree of this repo.
  const siblingWorktreePaths = useMemo(() => {
    if (!worktree.isMain) return []
    const repo = reposToViews(repos).find((r) => r.path === worktree.repoPath)
    return (repo?.worktrees ?? [])
      .filter((w) => !w.isMain && w.path !== worktree.path)
      .map((w) => w.path)
  }, [repos, worktree.isMain, worktree.repoPath, worktree.path])

  // Over-fetch a little so the sibling filter still leaves a full list.
  const { hits: raw } = useConversationSearch({
    query: filter,
    projectPath: scope,
    limit: siblingWorktreePaths.length > 0 ? MINI_LIMIT * 3 : MINI_LIMIT,
    debounceMs: 150,
  })
  const hits = raw
    .filter((h) => h.resumeValue)
    .filter(
      (h) =>
        !siblingWorktreePaths.some(
          (p) => h.projectPath === p || h.projectPath?.startsWith(`${p}/`),
        ),
    )
    .slice(0, MINI_LIMIT)

  async function create(agentKind: AgentKind) {
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind, cwd: worktree.path })
    onOpened(sessionId)
  }
  async function resume(hit: ConversationHit) {
    if (!hit.resumeKind || !hit.resumeValue) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: hit.agentKind as AgentKind,
      cwd: hit.projectPath ?? worktree.path,
      resume: { kind: hit.resumeKind, value: hit.resumeValue },
      conversationId: hit.id,
      ...(hit.name || hit.title ? { title: hit.name ?? hit.title } : {}),
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
      <button type="button" onClick={() => void create('shell')}>
        New Shell
      </button>
      <div className="menu-section">Resume</div>
      <input
        type="text"
        className="menu-search"
        placeholder="Search history…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {hits.length === 0 && <div className="menu-empty">No matching history</div>}
      {hits.map((hit) => (
        <button key={hit.id} type="button" className="menu-resume" onClick={() => void resume(hit)}>
          <span className="menu-resume-title">↻ {hit.name || hit.title || hit.id}</span>
          {hit.updatedAt && (
            <span className="menu-resume-when">{relativeTime(hit.updatedAt, now)}</span>
          )}
        </button>
      ))}
    </div>
  )
}
