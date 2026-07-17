import { repoNameFromOrigin } from '@podium/domain'
import type { GitRepositoryWire } from '@podium/protocol'

/** Display name for a scanned repo: its ORIGIN's repo name, since a clone's
 *  folder is not its identity (~/bak_podium of .../podium.git lists as "podium").
 *  Only a repo with no usable origin is named after its folder — that is all we
 *  know about it. The full path stays on the row as the disambiguator. */
function repoDisplayName(path: string, originUrl?: string): string {
  return repoNameFromOrigin(originUrl) ?? folderName(path)
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export type RepoCandidate = {
  path: string
  name: string
  branch?: string
  hasOrigin: boolean
  hidden: boolean
  worktreeCount: number
  defaultSelected: boolean
  /** Machine-scan classification (POD-787). Registered rows start CHECKED and stay
   *  toggleable — unchecking one removes that repo (POD-814). */
  status?: 'registered' | 'auto-registered' | 'candidate'
  /** Other machines that carry the same repo (origin match). */
  alsoOn?: string[]
}

/** The wire shape of one discovered repo from discovery.scanMachine (POD-787). */
export type MachineScanRepo = {
  path: string
  originUrl?: string
  branch?: string
  status: 'registered' | 'auto-registered' | 'candidate'
  alsoOn: string[]
}

/** Rank tiered machine-scan results (POD-787): same ordering as a folder scan.
 *  `defaultSelected` covers unregistered candidates only — the results screen also
 *  starts registered/auto-registered rows checked, since they are already there. */
export function rankMachineScanRepos(repos: MachineScanRepo[]): RepoCandidate[] {
  return repos
    .map((repo): RepoCandidate => {
      const hidden = isHiddenRepoPath(repo.path)
      return {
        path: repo.path,
        name: repoDisplayName(repo.path, repo.originUrl),
        ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
        hasOrigin: typeof repo.originUrl === 'string' && repo.originUrl.length > 0,
        hidden,
        worktreeCount: 0,
        defaultSelected: repo.status === 'candidate' && !hidden,
        status: repo.status,
        alsoOn: repo.alsoOn,
      }
    })
    .sort(compareCandidates)
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
        name: repoDisplayName(repo.path, repo.originUrl),
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
