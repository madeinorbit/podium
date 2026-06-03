import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
import type { RepoView, WorktreeView } from './types'

export function reposToViews(repos: GitRepositoryWire[]): RepoView[] {
  return repos.map((r) => {
    const main: WorktreeView = {
      path: r.path,
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
      repoPath: r.path,
      isMain: true,
    }
    const linked: WorktreeView[] = r.worktrees.map((w) => ({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      repoPath: r.path,
      isMain: false,
    }))
    return { path: r.path, name: r.path.split('/').pop() || r.path, worktrees: [main, ...linked] }
  })
}

export function sessionsForWorktree(sessions: SessionMeta[], worktreePath: string): SessionMeta[] {
  return sessions.filter((s) => s.cwd === worktreePath)
}

export function resumableForWorktree(
  convs: ConversationSummaryWire[],
  worktreePath: string,
): ConversationSummaryWire[] {
  return convs.filter((c) => c.resume && c.projectPath === worktreePath)
}

/** Under the repo root but not matched to any of its worktrees (deduped against worktree matches). */
export function resumableForRepoFallback(
  convs: ConversationSummaryWire[],
  repoPath: string,
  worktreePaths: string[],
): ConversationSummaryWire[] {
  const wt = new Set(worktreePaths)
  return convs.filter(
    (c) =>
      c.resume &&
      c.projectPath !== undefined &&
      !wt.has(c.projectPath) &&
      (c.projectPath === repoPath || c.projectPath.startsWith(`${repoPath}/`)),
  )
}
