/**
 * GIT DELIVERY: converge a development checkout without risking local work.
 *
 * A development checkout is allowed to contain agent worktrees and uncommitted
 * changes. That makes it unsuitable for forceful convergence: refuse before
 * fetching or checking out anything when the checkout is dirty, and never
 * manufacture a clean tree by deleting or resetting user work.
 */
export type GitRun = (
  cmd: string,
  args: string[],
) => {
  status: number | null
  stdout: string
}

export type GitConvergenceResult = { ok: true } | { ok: false; reason: string }

function failed(reason: string): GitConvergenceResult {
  return { ok: false, reason }
}

function validArgument(value: string): boolean {
  return value.length > 0 && !value.startsWith('-')
}

/**
 * Fetch and check out the requested development revision.
 *
 * The caller supplies the process runner so this safety gate can be tested
 * without executing git. No command in this sequence can erase the checkout.
 */
export function convergeViaGit(
  artifact: { repo: string; sha: string },
  deps: { run: GitRun },
): GitConvergenceResult {
  if (!validArgument(artifact.repo) || !validArgument(artifact.sha)) {
    return failed('invalid-git-reference')
  }

  const clean = deps.run('git', [
    '-C',
    artifact.repo,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])
  if (clean.status !== 0) return failed('status-failed')
  if (clean.stdout.length > 0) return failed('dirty-working-tree')

  const fetched = deps.run('git', ['-C', artifact.repo, 'fetch', '--all', '--prune'])
  if (fetched.status !== 0) return failed('fetch-failed')

  const checkedOut = deps.run('git', ['-C', artifact.repo, 'checkout', '--detach', artifact.sha])
  if (checkedOut.status !== 0) return failed('checkout-failed')

  return { ok: true }
}
