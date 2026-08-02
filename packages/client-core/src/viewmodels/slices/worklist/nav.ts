/**
 * WORKLIST SLICE — navigation structure (POD-330).
 *
 * The sidebar's repo/worktree tree: the machines slice's repo structure
 * DECORATED with the sessions and issues that live in it. That decoration is
 * the whole reason `worklist -> machines` is an edge and not a cycle — the
 * structure is a machine fact (multi-user doc §3.1.1, owned compute), the
 * sessions/issues on top of it are the worklist's.
 *
 * Nothing here knows about unified work ROWS. Row construction, banding,
 * folding and status copy are the worklist's other modules; this one answers
 * "what is in the tree, and in what order".
 *
 * PER-USER STATE ARRIVES AS DATA. `pins` is passed IN, never read from storage:
 * per doc §3.3 and POD-1076 pins/snooze/readAt become replicated per-user rows
 * keyed (userId, entityId), so they converge across that user's devices. No
 * slice may reach for localStorage; POD-329 enforces that boundary.
 *
 * Depends on F2, F3 and the machines slice.
 * Platform-neutral: no DOM, no storage.
 */
import type { GitRepositoryWire, RepoId, SessionMeta } from '@podium/model'
import { indexSessionOwnership, sessionsForWorktree, type SessionOwnershipIndex } from '../../session-ownership'
import { sortSessionsForSidebar } from '../../session-urgency'
import type { PinState, RepoView, WorktreeView } from '../../types'
import { reposToViews } from '../machines/facts'
import type { IssueNavigationModel } from '../issues'

export interface WorktreeNavView extends WorktreeView {
  repoName: string
  sessions: SessionMeta[]
  /** Non-archived issues whose worktree this is. When non-empty, the sidebar
   *  renders the issue block(s) instead of the bare worktree row. */
  issues: IssueNavigationModel[]
}

export interface RepoNavView {
  path: string
  name: string
  worktrees: WorktreeNavView[]
  machines?: { machineId: string; path: string }[]
  originUrl?: string
  repoId?: RepoId
}

export interface SidebarSections {
  /** Shared ownership work for this exact repo/session/issue snapshot. */
  sessionOwnership?: SessionOwnershipIndex
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }

/** Sessions shown in the sidebar — shells never appear there (they stay in the
 *  main-view tab strip). */
export function sidebarSessions(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => s.agentKind !== 'shell')
}

export function sidebarSections(
  repos: GitRepositoryWire[],
  sessions: SessionMeta[],
  pins: PinState,
  now: number = Date.now(),
  issues: IssueNavigationModel[] = [],
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)
  sessions = sidebarSessions(sessions)
  // worktree path → its non-archived issues (an issue owns at most one worktree;
  // several issues may point at the same worktree — the worktree shows under each).
  const issuesByWorktree = new Map<string, IssueNavigationModel[]>()
  for (const issue of issues) {
    if (issue.archived || !issue.worktreePath) continue
    const list = issuesByWorktree.get(issue.worktreePath)
    if (list) list.push(issue)
    else issuesByWorktree.set(issue.worktreePath, [issue])
  }

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  const allWorktreePaths = allWorktrees.map(({ worktree }) => worktree.path)
  const sessionOwnership = indexSessionOwnership(sessions, issues, allWorktreePaths)
  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(
      sessionsForWorktree(sessions, worktree.path, allWorktreePaths, sessionOwnership),
      now,
    ),
    issues: issuesByWorktree.get(worktree.path) ?? [],
  })

  const navRepo = (repo: RepoView): RepoNavView => ({
    path: repo.path,
    name: repo.name,
    worktrees: repo.worktrees
      .filter((worktree) => !pinnedWorktreePaths.has(worktree.path))
      .map((worktree) => navWorktree(repo, worktree)),
    machines: repo.machines,
    ...(repo.originUrl !== undefined ? { originUrl: repo.originUrl } : {}),
    ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
  })

  return {
    sessionOwnership,
    // A PINNED PATH THAT RESOLVES TO NOTHING SIMPLY DOES NOT RENDER. Under the
    // scoped feed a pin may name a worktree on a machine this principal can no
    // longer SEE; the pin is per-user state and survives, the row does not
    // appear, and nothing here fabricates a placeholder that would imply the
    // worktree exists in a form the user can act on.
    pinnedWorktrees: pins.worktrees
      .map((path) => allWorktrees.find(({ worktree }) => worktree.path === path))
      .filter((item): item is { repo: RepoView; worktree: WorktreeView } => item !== undefined)
      .map(({ repo, worktree }) => navWorktree(repo, worktree)),
    pinnedRepos: pins.repos
      .map((path) => repoViews.find((repo) => repo.path === path))
      .filter((repo): repo is RepoView => repo !== undefined)
      .map(navRepo),
    repos: repoViews
      .filter((repo) => !pinnedRepoPaths.has(repo.path))
      .map(navRepo)
      .filter((repo) => repo.worktrees.length > 0),
  }
}

/** lastUsedAt maps aggregated to the repo (for repo ordering / "most recent repo")
 *  and per-worktree (for worktree ordering). A session's cwd is its worktree path;
 *  cwds not matching any known worktree aggregate under themselves. Extracted from
 *  Sidebar so the unified layout's "New <Agent> in <Repo>" shares the exact logic. */
export function lastUsedMaps(
  sections: SidebarSections,
  sessions: SessionMeta[],
): { byRepo: Map<string, number>; byWorktree: Map<string, number> } {
  const worktreeToRepo = new Map<string, string>()
  for (const repo of sections.repos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const repo of sections.pinnedRepos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const wt of sections.pinnedWorktrees) worktreeToRepo.set(wt.path, wt.repoPath)
  const byRepo = new Map<string, number>()
  const byWorktree = new Map<string, number>()
  for (const s of sessions) {
    const ts = new Date(s.lastActiveAt).getTime()
    const repoPath = worktreeToRepo.get(s.cwd) ?? s.cwd
    if (ts > (byRepo.get(repoPath) ?? 0)) byRepo.set(repoPath, ts)
    if (ts > (byWorktree.get(s.cwd) ?? 0)) byWorktree.set(s.cwd, ts)
  }
  return { byRepo, byWorktree }
}
