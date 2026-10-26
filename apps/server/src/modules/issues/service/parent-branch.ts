/**
 * WHICH BRANCH A NEW ISSUE IS CUT FROM, AND WHETHER IT STILL EXISTS [POD-2065].
 *
 * `gitWorkflow.defaultParentBranch` is one instance-wide value, but an instance
 * hosts several repositories. Configuring `tf.dev` for Podium development stamped
 * `tf.dev` onto every new issue in every repo, and a repo with no such ref then
 * failed at start with git's bare `fatal: invalid reference: tf.dev`.
 *
 * Two rules, at two moments:
 *  - CREATE picks a parent the selected repository can resolve. The configured
 *    default wins when the repo has it, so Podium keeps `tf.dev`; otherwise the
 *    repo's own base (`main`, `master`, then the branch its root has checked out).
 *    An explicit parent is the caller's choice — a stacked issue names another
 *    issue's branch — and is never probed or replaced.
 *  - START refuses a stored parent the repo cannot resolve, with the command that
 *    fixes it. It never rewrites the stored value: an existing issue's parent is
 *    not retargeted behind anyone's back.
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

/** How long create waits for the repository before keeping the unprobed choice.
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

/** The parent a new issue in `repoPath` is cut from when the caller named none. */
export async function defaultParentBranchFor(
  repoOp: RepoOpPort,
  repoPath: string,
  configured: string,
  budgetMs = PARENT_PROBE_BUDGET_MS,
): Promise<string> {
  const unprobed = configured.trim() || 'main'
  const probe = async (): Promise<string> => {
    const candidates = [...new Set([configured.trim(), 'main', 'master'].filter(Boolean))]
    for (const ref of candidates) {
      if (await resolves(repoOp, repoPath, ref)) return ref
    }
    try {
      const status = await repoOp('statusProbe', repoPath)
      const branch = status.ok ? checkedOutBranch(status.output) : null
      if (branch) return branch
    } catch {}
    return unprobed
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(unprobed), budgetMs)
  })
  try {
    return await Promise.race([probe(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The refusal text for a start whose parent branch `repoPath` cannot resolve, or
 * null when it resolves or the repository did not answer (HEAD unresolvable too).
 */
export async function missingParentBranchRefusal(
  repoOp: RepoOpPort,
  input: { repoPath: string; parentBranch: string; issueRef: string; configured: string },
): Promise<string | null> {
  const { repoPath, parentBranch, issueRef } = input
  if (await resolves(repoOp, repoPath, parentBranch)) return null
  if (!(await resolves(repoOp, repoPath, 'HEAD'))) return null
  const suggestion = await defaultParentBranchFor(repoOp, repoPath, input.configured)
  const target = suggestion !== parentBranch ? suggestion : '<branch>'
  const configuredNote =
    input.configured.trim() === parentBranch
      ? ` '${parentBranch}' is the instance's default parent branch (Settings → Git workflow → Default parent branch), which this repository does not have.`
      : ''
  return (
    `parent branch '${parentBranch}' does not exist in ${repoPath}.${configuredNote} ` +
    `Point this task at a branch that does — podium issue update --id ${issueRef} --parent-branch ${target} — ` +
    `or create '${parentBranch}' in that repository, then start the task again.`
  )
}
