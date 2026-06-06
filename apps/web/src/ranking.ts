import type { GitRepositoryWire } from '@podium/protocol'

export type RepoCandidate = {
  path: string
  name: string
  branch?: string
  hasOrigin: boolean
  hidden: boolean
  worktreeCount: number
  defaultSelected: boolean
}

/**
 * A repo is "hidden/system" when any segment of its absolute path begins with a
 * dot (e.g. ~/.claude/..., ~/.config/...). These sort to the bottom of the scan
 * results and are unchecked by default. Empty segments (leading slash) and the
 * "." / ".." segments don't count.
 */
export function isHiddenRepoPath(path: string): boolean {
  return path
    .split('/')
    .some((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.startsWith('.'))
}

function pathDepth(path: string): number {
  return path.split('/').filter((seg) => seg !== '').length
}

/**
 * Rank scan results for the selection screen. Real projects come first — those
 * with a remote, then shallower paths, then alphabetical — and hidden/system
 * repos sort last (and default unchecked). Worktree entries are dropped: the repo
 * root is the selectable unit, and its worktrees follow automatically once added.
 */
export function rankRepoCandidates(repos: GitRepositoryWire[]): RepoCandidate[] {
  return repos
    .filter((repo) => repo.kind !== 'worktree')
    .map((repo): RepoCandidate => {
      const hidden = isHiddenRepoPath(repo.path)
      return {
        path: repo.path,
        name: repo.path.split('/').filter(Boolean).pop() ?? repo.path,
        ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
        hasOrigin: typeof repo.originUrl === 'string' && repo.originUrl.length > 0,
        hidden,
        worktreeCount: repo.worktrees.length,
        defaultSelected: !hidden,
      }
    })
    .sort(compareCandidates)
}

function compareCandidates(a: RepoCandidate, b: RepoCandidate): number {
  if (a.hidden !== b.hidden) return a.hidden ? 1 : -1
  if (a.hasOrigin !== b.hasOrigin) return a.hasOrigin ? -1 : 1
  const byDepth = pathDepth(a.path) - pathDepth(b.path)
  if (byDepth !== 0) return byDepth
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}
