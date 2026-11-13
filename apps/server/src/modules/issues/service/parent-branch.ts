/**
 * WHICH BRANCH A NEW ISSUE IS CUT FROM, AND WHETHER IT STILL EXISTS [POD-2065].
 *
 * `gitWorkflow.defaultParentBranch` is one instance-wide value, but an instance
 * hosts several repositories. Configuring `tf.dev` for Podium development stamped
 * `tf.dev` onto every new issue in every repo, and a repo with no such ref then
 * failed at start with git's bare `fatal: invalid reference: tf.dev`.
 *
 * Two rules, at two moments:
 *  - CREATE takes, in order: the caller's explicit parent (a stacked issue names
 *    another issue's branch; never probed or replaced), the repository's own base
 *    branch, the instance default — both stored as configured, unprobed — and only
 *    when neither is set, the repository's detected base (`main`, `master`, then
 *    the branch its root has checked out).
 *  - START refuses a stored parent the repo cannot resolve, naming both fixes. It
 *    never rewrites the stored value: an existing issue's parent is not retargeted
 *    behind anyone's back.
 *
 * Both only act on a POSITIVE answer from the repository. A daemon that is offline
 * or slow cannot tell "missing" from "unreachable", so the old choice stands and
 * the existing failure paths report what actually went wrong.
 */

import type { RepoOp } from '@podium/protocol'

type RepoOpPort = (
  op: Extract<RepoOp, 'revParseVerify' | 'statusProbe'>,
  cwd: string,
  args?: Record<string, string>,
) => Promise<{ ok: boolean; output: string }>

/** How long create waits for the repository before falling back to `main`.
 *  Create is interactive (the new-task dialog, `podium issue create`), and repoOp's
 *  own deadline is 35s — far too long to hold a dialog on a probe. */
export const PARENT_PROBE_BUDGET_MS = 3_000

/** The branch `git status -b` reports the root on, or null when detached/unborn. */
export function checkedOutBranch(statusOutput: string): string | null {
  const header = statusOutput.split('\n', 1)[0] ?? ''
  if (!header.startsWith('## ')) return null
  const rest = header.slice(3)
  if (rest.startsWith('HEAD (no branch)') || rest.startsWith('No commits yet')) return null
  const branch = rest.split('...', 1)[0]?.trim() ?? ''
  return branch === '' ? null : branch
}

async function resolves(repoOp: RepoOpPort, repoPath: string, ref: string): Promise<boolean> {
  try {
    return (await repoOp('revParseVerify', repoPath, { ref })).ok
  } catch {
    return false
  }
}

/** The base the repository at `repoPath` reports — `main`, `master`, then the
 *  branch its root has checked out — or null when it has none or did not answer. */
export async function detectBaseBranch(
  repoOp: RepoOpPort,
  repoPath: string,
): Promise<string | null> {
  for (const ref of ['main', 'master']) {
    if (await resolves(repoOp, repoPath, ref)) return ref
  }
  try {
    const status = await repoOp('statusProbe', repoPath)
    return status.ok ? checkedOutBranch(status.output) : null
  } catch {
    return null
  }
}

/** The parent a new issue in `repoPath` is cut from when neither the caller, the
 *  repository nor the instance named one: its detected base, else `main`. */
export async function defaultParentBranchFor(
  repoOp: RepoOpPort,
  repoPath: string,
  budgetMs = PARENT_PROBE_BUDGET_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  try {
    return (await Promise.race([detectBaseBranch(repoOp, repoPath), timeout])) ?? 'main'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The refusal text for a start whose parent branch `repoPath` cannot resolve, or
 * null when it resolves or the repository did not answer (HEAD unresolvable too).
 * `repoDefault` and `instanceDefault` say where a missing default came from.
 */
export async function missingParentBranchRefusal(
  repoOp: RepoOpPort,
  input: {
    repoPath: string
    parentBranch: string
    issueRef: string
    repoDefault: string | null
    instanceDefault: string
  },
): Promise<string | null> {
  const { repoPath, parentBranch, issueRef } = input
  if (await resolves(repoOp, repoPath, parentBranch)) return null
  if (!(await resolves(repoOp, repoPath, 'HEAD'))) return null
  const detected = await detectBaseBranch(repoOp, repoPath)
  const target = detected && detected !== parentBranch ? detected : '<branch>'
  const source =
    input.repoDefault === parentBranch
      ? ` '${parentBranch}' is this repository's base branch, which it no longer has.`
      : input.instanceDefault.trim() === parentBranch
        ? ` '${parentBranch}' is the instance's default parent branch (Settings → Projects → Default base branch), which this repository does not have.`
        : ''
  return (
    `parent branch '${parentBranch}' does not exist in ${repoPath}.${source} ` +
    `For new tasks, set this repository's base branch (sidebar project menu → Base branch, or Settings → Projects). ` +
    `For this task: podium issue update --id ${issueRef} --parent-branch ${target}. ` +
    `Or create '${parentBranch}' in that repository. Then start the task again.`
  )
}
