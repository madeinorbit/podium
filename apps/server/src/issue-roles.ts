export type Role = 'reader' | 'worker' | 'maintainer'

export const ROLE_RANK: Record<Role, number> = { reader: 0, worker: 1, maintainer: 2 }

/** Minimum role to call each issues.* procedure. Unlisted ⇒ 'reader'. Tunable policy. */
export const PROC_MIN_ROLE: Record<string, Role> = {
  // worker — do the work on issues
  claim: 'worker',
  update: 'worker',
  addComment: 'worker',
  defer: 'worker',
  close: 'worker',
  start: 'worker',
  addSession: 'worker',
  addShell: 'worker',
  action: 'worker',
  applySuggestion: 'worker',
  dismissSuggestion: 'worker',
  refreshAssistant: 'worker',
  depAdd: 'worker',
  // hits the external Linear API — keep anonymous readers from driving it
  linearSearch: 'worker',
  // maintainer — structural / destructive / cross-cutting
  create: 'maintainer',
  archive: 'maintainer',
  setLabels: 'maintainer',
  depRemove: 'maintainer',
  reparent: 'maintainer',
  supersede: 'maintainer',
  duplicate: 'maintainer',
}

/** Pure role resolution. maintainer iff token matches; worker iff cwd is inside an issue
 *  worktree; reader otherwise (fail-safe). */
export function resolveRole(
  cred: { token?: string; cwd?: string },
  env: { maintainerToken: string; issueWorktrees: string[] },
): Role {
  if (cred.token && env.maintainerToken && cred.token === env.maintainerToken) return 'maintainer'
  const cwd = cred.cwd
  if (
    cwd &&
    env.issueWorktrees.some((w) => cwd === w || cwd.startsWith(w.endsWith('/') ? w : `${w}/`))
  ) {
    return 'worker'
  }
  return 'reader'
}
