import type { GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { reposToViews } from '@/lib/derive'

/**
 * Client-side mirror of the server's concierge thread identity (issue #64/#65):
 * one thread per repo, id `concierge_<base64url(repoPath)>`. Deterministic and
 * reversible, so the web can bind the panel to a repo's thread BEFORE the thread
 * exists server-side (the first `superagent.concierge` send creates + seeds it).
 */
export function conciergeThreadId(repoPath: string): string {
  const bytes = new TextEncoder().encode(repoPath)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `concierge_${b64url}`
}

/** Reverse of {@link conciergeThreadId}; undefined for non-concierge ids or
 *  malformed base64url. */
export function conciergeRepoPath(threadId: string): string | undefined {
  if (!threadId.startsWith('concierge_')) return undefined
  try {
    const b64 = threadId.slice('concierge_'.length).replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** "Concierge — <repo basename>": the thread-list pill and panel-header label. */
export function conciergeLabel(repoPath: string): string {
  return `Concierge — ${repoPath.split('/').pop() || repoPath}`
}

export type ConciergeRepoResolution =
  | { kind: 'repo'; repoPath: string }
  | { kind: 'pick'; candidates: { name: string; path: string }[] }
  | { kind: 'none' }

/**
 * Which repo does the + button's concierge bind to? In priority order:
 * 1. the selected worktree's containing repo,
 * 2. the focused session's (pane A) cwd's containing repo,
 * 3. the only repo, when exactly one is registered,
 * 4. otherwise: ask — return the candidate list for a picker.
 */
export function resolveConciergeRepo(opts: {
  repos: GitRepositoryWire[]
  selectedWorktree: string | null
  sessions: SessionMeta[]
  paneA: string | null
}): ConciergeRepoResolution {
  const views = reposToViews(opts.repos)
  if (views.length === 0) return { kind: 'none' }
  const worktreeToRepo = new Map<string, string>()
  for (const repo of views) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
    worktreeToRepo.set(repo.path, repo.path)
  }
  if (opts.selectedWorktree) {
    const repoPath = worktreeToRepo.get(opts.selectedWorktree)
    if (repoPath) return { kind: 'repo', repoPath }
  }
  if (opts.paneA) {
    const focused = opts.sessions.find((s) => s.sessionId === opts.paneA)
    const repoPath = focused && worktreeToRepo.get(focused.cwd)
    if (repoPath) return { kind: 'repo', repoPath }
  }
  const first = views[0]
  if (views.length === 1 && first) return { kind: 'repo', repoPath: first.path }
  return { kind: 'pick', candidates: views.map((r) => ({ name: r.name, path: r.path })) }
}
