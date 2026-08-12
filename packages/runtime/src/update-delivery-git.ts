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
  /** Milliseconds this step may take. Runners that ignore it are unbounded. */
  timeoutMs?: number,
) => {
  status: number | null
  stdout: string
}

/** Conventional timeout exit code, used here to name a step the budget killed. */
export const GIT_TIMED_OUT_STATUS = 124

/**
 * Whole-convergence budget for git delivery.
 *
 * Git delivery is SYNCHRONOUS and runs three steps. Bounding each step
 * separately does not bound the sequence: three four-minute steps are twelve
 * minutes, which outlives the server's ten-minute silence deadline — the server
 * would mark the machine stuck and could re-grant while the daemon was still
 * blocked and unable to observe any cancellation. One shared budget for the
 * whole convergence is what keeps the daemon's failure earlier than the
 * server's.
 */
export const GIT_CONVERGENCE_BUDGET_MS = 8 * 60_000

/**
 * Wrap a runner so every step of ONE convergence draws from a single budget.
 * Once it is spent, further steps fail immediately instead of starting.
 */
export function withGitBudget(
  run: GitRun,
  opts: { totalMs?: number; now?: () => number } = {},
): GitRun {
  const totalMs = opts.totalMs ?? GIT_CONVERGENCE_BUDGET_MS
  const now = opts.now ?? Date.now
  const startedAt = now()
  return (cmd, args) => {
    const remaining = totalMs - (now() - startedAt)
    if (remaining <= 0) return { status: GIT_TIMED_OUT_STATUS, stdout: '' }
    return run(cmd, args, remaining)
  }
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
  if (clean.status === GIT_TIMED_OUT_STATUS) return failed('timed-out')
  if (clean.status !== 0) return failed('status-failed')
  if (clean.stdout.length > 0) return failed('dirty-working-tree')

  // The coordinating source host commonly has already moved its clean main
  // checkout to the target while its still-running server reports the previous
  // boot identity. In that case there is nothing to deliver. Checking out the
  // same SHA with --detach needlessly abandons main, which prevents the next
  // pull from moving HEAD and therefore prevents the next dev update from ever
  // being published.
  const current = deps.run('git', ['-C', artifact.repo, 'rev-parse', 'HEAD'])
  if (current.status === GIT_TIMED_OUT_STATUS) return failed('timed-out')
  if (current.status !== 0) return failed('status-failed')
  if (current.stdout.trim().startsWith(artifact.sha)) return { ok: true }

  const fetched = deps.run('git', ['-C', artifact.repo, 'fetch', '--all', '--prune'])
  if (fetched.status === GIT_TIMED_OUT_STATUS) return failed('timed-out')
  if (fetched.status !== 0) return failed('fetch-failed')

  const checkedOut = deps.run('git', ['-C', artifact.repo, 'checkout', '--detach', artifact.sha])
  if (checkedOut.status === GIT_TIMED_OUT_STATUS) return failed('timed-out')
  if (checkedOut.status !== 0) return failed('checkout-failed')

  return { ok: true }
}
