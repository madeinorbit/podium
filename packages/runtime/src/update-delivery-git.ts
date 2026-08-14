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
) => Promise<{
  status: number | null
  stdout: string
}>

/** Conventional timeout exit code, used here to name a step the budget killed. */
export const GIT_TIMED_OUT_STATUS = 124

/**
 * A step the CALLER cancelled, as distinct from one the budget killed.
 *
 * Both end the convergence, but they mean opposite things to whoever reads the
 * refusal: `timed-out` is this daemon giving up on a remote, `cancelled` is a
 * newer grant superseding the one being applied. Collapsing them would report a
 * healthy hand-off as a failure against the remote.
 */
export const GIT_ABORTED_STATUS = 125

/**
 * Whole-convergence budget for git delivery.
 *
 * Git delivery runs three steps, and bounding each one separately does not
 * bound the sequence: three four-minute steps are twelve minutes, which
 * outlives the server's ten-minute silence deadline — the server would mark the
 * machine stuck and could re-grant while this one was still working. One shared
 * budget for the whole convergence is what keeps the daemon's failure earlier
 * than the server's.
 *
 * The steps are awaited rather than blocking (POD-2046), so a superseding grant
 * now aborts them promptly. The budget remains the bound that matters when
 * nobody is cancelling — a `git fetch` against an unreachable remote.
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
  return async (cmd, args) => {
    const remaining = totalMs - (now() - startedAt)
    if (remaining <= 0) return { status: GIT_TIMED_OUT_STATUS, stdout: '' }
    return await run(cmd, args, remaining)
  }
}

export type GitConvergenceResult = { ok: true } | { ok: false; reason: string }

function failed(reason: string): GitConvergenceResult {
  return { ok: false, reason }
}

/** The reason a step ended the whole convergence, or undefined if it ran. */
function stoppedBy(status: number | null): 'timed-out' | 'cancelled' | undefined {
  if (status === GIT_TIMED_OUT_STATUS) return 'timed-out'
  if (status === GIT_ABORTED_STATUS) return 'cancelled'
  return undefined
}

function validArgument(value: string): boolean {
  return value.length > 0 && !value.startsWith('-')
}

/**
 * Fetch and check out the requested development revision.
 *
 * The caller supplies the process runner so this safety gate can be tested
 * without executing git. No command in this sequence can erase the checkout.
 *
 * Every step is AWAITED, never blocking: this runs on the daemon's only thread,
 * which also carries PTY output, the server link and hook ingest (POD-2046).
 * Do not reintroduce a synchronous runner here.
 */
export async function convergeViaGit(
  artifact: { repo: string; sha: string },
  deps: { run: GitRun },
): Promise<GitConvergenceResult> {
  if (!validArgument(artifact.repo) || !validArgument(artifact.sha)) {
    return failed('invalid-git-reference')
  }

  const clean = await deps.run('git', [
    '-C',
    artifact.repo,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])
  const cleanStopped = stoppedBy(clean.status)
  if (cleanStopped) return failed(cleanStopped)
  if (clean.status !== 0) return failed('status-failed')
  if (clean.stdout.length > 0) return failed('dirty-working-tree')

  // The coordinating source host commonly has already moved its clean main
  // checkout to the target while its still-running server reports the previous
  // boot identity. In that case there is nothing to deliver. Checking out the
  // same SHA with --detach needlessly abandons main, which prevents the next
  // pull from moving HEAD and therefore prevents the next dev update from ever
  // being published.
  const current = await deps.run('git', ['-C', artifact.repo, 'rev-parse', 'HEAD'])
  const currentStopped = stoppedBy(current.status)
  if (currentStopped) return failed(currentStopped)
  if (current.status !== 0) return failed('status-failed')
  if (current.stdout.trim().startsWith(artifact.sha)) return { ok: true }

  const fetched = await deps.run('git', ['-C', artifact.repo, 'fetch', '--all', '--prune'])
  const fetchedStopped = stoppedBy(fetched.status)
  if (fetchedStopped) return failed(fetchedStopped)
  if (fetched.status !== 0) return failed('fetch-failed')

  const checkedOut = await deps.run('git', [
    '-C',
    artifact.repo,
    'checkout',
    '--detach',
    artifact.sha,
  ])
  const checkedOutStopped = stoppedBy(checkedOut.status)
  if (checkedOutStopped) return failed(checkedOutStopped)
  if (checkedOut.status !== 0) return failed('checkout-failed')

  return { ok: true }
}
