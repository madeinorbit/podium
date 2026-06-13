import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { panelLabel, reposToViews } from './derive'
import { relativeTime } from './home'
import { useStore } from './store'
import { type ConversationHit, useConversationSearch } from './useConversationSearch'

export type { ConversationHit }

/**
 * Conversation search over the durable server-side index (FTS keyword now;
 * vector lane joins when an embeddings provider is configured). The worktree
 * filter defaults to where the user opened the search from.
 */
export function SearchView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, repos, selectedWorktree, setSelectedWorktree, setPane, setView } = useStore()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<string>(selectedWorktree ?? '')
  const now = Date.now()

  const worktrees = useMemo(
    () => reposToViews(repos).flatMap((r) => r.worktrees.map((w) => ({ ...w, repoName: r.name }))),
    [repos],
  )

  // Debounced live search; empty query browses by recency.
  const { hits, busy } = useConversationSearch({
    query,
    ...(scope ? { projectPath: scope } : {}),
    limit: 50,
    debounceMs: 180,
  })

  const resume = async (hit: ConversationHit) => {
    if (!hit.resumeKind || !hit.resumeValue) return
    const cwd = hit.projectPath ?? scope
    if (!cwd) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: hit.agentKind as 'claude-code' | 'codex',
      cwd,
      resume: { kind: hit.resumeKind, value: hit.resumeValue },
      conversationId: hit.id,
      ...(hit.name || hit.title ? { title: hit.name ?? hit.title } : {}),
    })
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
    onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search conversations"
      >
        <div className="search-head">
          <input
            // biome-ignore lint/a11y/noAutofocus: a search modal exists to be typed into
            autoFocus
            type="text"
            placeholder="Search all conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Everywhere</option>
            {worktrees.map((w) => (
              <option key={w.path} value={w.path}>
                {w.repoName} / {w.branch ?? w.path.split('/').pop()}
              </option>
            ))}
          </select>
          <button type="button" className="search-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="search-results">
          {busy && hits.length === 0 && <div className="empty">Searching…</div>}
          {!busy && hits.length === 0 && (
            <div className="empty">
              {query ? 'No conversations match.' : 'No conversations indexed yet.'}
            </div>
          )}
          {hits.map((hit) => (
            <div key={hit.id} className="search-hit">
              <div className="search-hit-main">
                <span className="search-hit-title">{hit.name || hit.title || hit.id}</span>
                <span className="search-hit-kind">{kindLabel(hit.agentKind)}</span>
                {hit.updatedAt && (
                  <span className="search-hit-when">{relativeTime(hit.updatedAt, now)}</span>
                )}
              </div>
              {hit.summary && <div className="search-hit-summary">{hit.summary}</div>}
              <div className="search-hit-meta">
                <span className="search-hit-path" title={hit.projectPath}>
                  {hit.projectPath?.split('/').slice(-2).join('/')}
                </span>
                {typeof hit.messageCount === 'number' && <span>{hit.messageCount} messages</span>}
                {hit.resumeValue && (
                  <button type="button" onClick={() => void resume(hit)}>
                    ↻ Resume
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function kindLabel(agentKind: string): string {
  if (agentKind === 'claude-code' || agentKind === 'codex' || agentKind === 'shell') {
    return panelLabel(agentKind)
  }
  return agentKind
}
