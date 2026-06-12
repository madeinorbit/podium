import type { AgentKind } from '@podium/protocol'
import { type JSX, useEffect, useRef, useState } from 'react'
import { relativeTime } from './home'
import type { ConversationHit } from './SearchView'
import { useStore } from './store'
import type { WorktreeView } from './types'

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
  const { trpc } = useStore()
  const [filter, setFilter] = useState('')
  const [hits, setHits] = useState<ConversationHit[]>([])
  const seq = useRef(0)
  const now = Date.now()
  // Main worktree searches the whole repo subtree so repo-level conversations
  // that matched no specific worktree are not lost; others stay exact.
  const scope = worktree.isMain ? worktree.repoPath : worktree.path

  useEffect(() => {
    const mySeq = ++seq.current
    const t = setTimeout(() => {
      trpc.conversations.search
        .query({
          ...(filter.trim() ? { query: filter.trim() } : {}),
          projectPath: scope,
          limit: MINI_LIMIT,
        })
        .then((rows) => {
          if (seq.current === mySeq)
            setHits((rows as ConversationHit[]).filter((h) => h.resumeValue))
        })
        .catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [trpc, filter, scope])

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
