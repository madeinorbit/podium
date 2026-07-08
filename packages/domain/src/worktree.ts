/** The worktree that CONTAINS `cwd`: the longest root with `cwd === root` or
 *  `cwd` under `root/`. Longest-match matters because a repo root contains its
 *  own `.worktrees/*` checkouts — a session in one belongs to the worktree, not
 *  the parent repo. Null when no root contains the cwd. */
export function worktreeForCwd(cwd: string, worktreePaths: string[]): string | null {
  let best: string | null = null
  for (const root of worktreePaths) {
    if (cwd !== root && !cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
    if (best === null || root.length > best.length) best = root
  }
  return best
}
