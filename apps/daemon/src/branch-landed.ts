import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertSafeRef, repoOpCommand } from './repo-op'

const execFileAsync = promisify(execFile)

/** Same kill budget the generic repo-op path runs every git under. */
const GIT_OPTS = { timeout: 120_000, maxBuffer: 1024 * 1024 } as const

/**
 * Comparing content is not free — `git cherry` computes a patch-id for every
 * commit on BOTH sides — so the range is bounded and an over-large comparison
 * refuses with a sentence instead of sitting on the 120s kill budget.
 */
const DEFAULT_MAX_COMMITS = 2000

/**
 * THREE ANSWERS, NOT TWO.
 *
 * `not-landed` and `undecidable` both mean "do not delete this branch", and the
 * caller treats them the same way. They are kept apart because they mean
 * opposite things to a human: one says the work is not in the parent, the other
 * says this predicate declines to judge the shape it was handed. Collapsing
 * them would turn "I cannot tell" into "your work is missing".
 */
export type LandedVerdict = {
  verdict: 'landed' | 'not-landed' | 'undecidable'
  output: string
}

const undecidable = (output: string): LandedVerdict => ({
  verdict: 'undecidable',
  output: `cannot determine whether the work landed: ${output}`,
})

const failed = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** execFile's rejection carries the child's exit status on `code`. */
const exitCode = (err: unknown): number | undefined =>
  typeof (err as { code?: unknown } | null)?.code === 'number'
    ? ((err as { code: number }).code)
    : undefined

const git = (cwd: string, ...argv: string[]): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('git', ['-C', cwd, ...argv], GIT_OPTS)

const CHERRY_LINE = /^([+-]) ([0-9a-f]{7,40})(?: (.*))?$/

/**
 * Turn `git cherry -v` output into a verdict, given how many commits the caller
 * expects a line for.
 *
 * THE COUNT IS THE POINT. `git cherry` walks with `--no-merges`, so it reports
 * on FEWER commits than it was asked about whenever the branch carries a merge
 * — silently, with no marker of any kind. Read as "no '+' lines, therefore
 * landed", an empty report from such a branch is a false clear, and the caller
 * refuses merges outright for that reason. This accounting is the second lock
 * on the same door: whatever git declines to report on, it cannot be counted as
 * landed, because the line for it is missing.
 */
export function interpretCherry(input: {
  lines: string[]
  expectedCommits: number
}): LandedVerdict {
  const { lines, expectedCommits } = input
  const parsed: { mark: string; sha: string; subject: string }[] = []
  for (const line of lines) {
    const m = CHERRY_LINE.exec(line)
    if (!m) return undecidable(`could not parse git cherry output line: '${line}'`)
    parsed.push({ mark: m[1] as string, sha: m[2] as string, subject: m[3] ?? '' })
  }
  if (parsed.length !== expectedCommits) {
    return undecidable(
      `git cherry accounted for ${parsed.length} of ${expectedCommits} commit(s) on the branch; ` +
        'a commit it did not report on cannot be counted as landed',
    )
  }
  const missing = parsed.filter((p) => p.mark === '+')
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).map((p) => `  ${p.sha.slice(0, 9)} ${p.subject}`)
    const more = missing.length > shown.length ? `\n  …and ${missing.length - shown.length} more` : ''
    return {
      verdict: 'not-landed',
      output:
        `${missing.length} of ${parsed.length} commit(s) have no equivalent in the parent ` +
        `branch:\n${shown.join('\n')}${more}`,
    }
  }
  return {
    verdict: 'landed',
    output: `all ${parsed.length} commit(s) are present in the parent branch by patch-id equivalence`,
  }
}

/**
 * Does the parent branch already contain this branch's WORK (PDM-392)?
 *
 * `cleanup` used to ask `git merge-base --is-ancestor`, which asks whether a
 * COMMIT is in that history. Under an integration model that cherry-picks each
 * leaf onto the integration branch, the commit changes while the work does not,
 * so ancestry answers "no" forever and cleanup can never finish.
 *
 * SHAPED LIKE PDM-373's ESCALATION: run the op's own argv unchanged, and only
 * when it refuses ask the more expensive question. Ancestry stays the fast path
 * — it is exact, it is one exec, and it is still the right answer whenever it
 * says yes. The content comparison only runs for the case that used to be a
 * dead end.
 *
 * EVERY SHAPE IT CANNOT JUDGE REFUSES. Deleting a branch is irreversible in a
 * way that leaving it is not, so there is no "probably". Named here so a reader
 * can check the list against the code: an unsafe ref; refs that do not resolve;
 * histories with no common ancestor; a branch carrying a merge commit (a merge
 * has no single diff, and `git cherry` does not report on it at all); a
 * comparison larger than the bound; any git invocation that fails; and any
 * report that does not account for every commit.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: work that landed in the parent and
 * was then REVERTED there still reads as landed, because the landing commit is
 * still in the range and still carries the matching patch-id. That work remains
 * in the parent's history and is recoverable from it, which is why this is a
 * named limitation rather than a refusal — but it is a limitation.
 */
export async function branchLandedVerdict(opts: {
  repoPath: string
  branch: string
  parentBranch: string
  maxCommits?: number
}): Promise<LandedVerdict> {
  const { repoPath, branch, parentBranch } = opts
  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS
  const bad = assertSafeRef(branch, 'branch') ?? assertSafeRef(parentBranch, 'parentBranch')
  if (bad) return undecidable(bad)

  // (1) Ancestry, unchanged — the shipped question, still the cheapest true answer.
  const ancestry = repoOpCommand('isMergedInto', { branch, parentBranch })
  if ('error' in ancestry) return undecidable(ancestry.error)
  try {
    await git(repoPath, ...ancestry.argv)
    return {
      verdict: 'landed',
      output: `'${branch}' is an ancestor of '${parentBranch}'`,
    }
  } catch (err) {
    // Exit 1 is merge-base's answer "no". Anything else is a broken question —
    // an unknown ref, a corrupt repo — and must not fall through to a content
    // comparison that would report it as "no common ancestor".
    if (exitCode(err) !== 1) return undecidable(failed(err))
  }

  try {
    // (2) A common ancestor, or there is nothing to compare against.
    let base: string
    try {
      base = (await git(repoPath, 'merge-base', '--', branch, parentBranch)).stdout.trim()
    } catch {
      return undecidable(`'${branch}' and '${parentBranch}' have no common ancestor`)
    }
    if (!base) return undecidable(`'${branch}' and '${parentBranch}' have no common ancestor`)
    const range = `${base}..${branch}`

    // (3) Merges: see interpretCherry. This is the guard that keeps an evil
    //     merge's resolution — content that exists on no other branch — from
    //     being read as landed because git cherry said nothing about it.
    const merges = (await git(repoPath, 'rev-list', '--merges', range)).stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
    if (merges.length > 0) {
      return undecidable(
        `'${branch}' carries ${merges.length} merge commit(s) since '${parentBranch}'; ` +
          'a merge has no single diff, so content-equivalence cannot see what its ' +
          'resolution introduced (git cherry does not report on it at all)',
      )
    }

    // (4) How many commits a full report must account for.
    const expected = Number.parseInt(
      (await git(repoPath, 'rev-list', '--no-merges', '--count', range)).stdout.trim(),
      10,
    )
    if (!Number.isSafeInteger(expected)) return undecidable('could not count the branch commits')
    if (expected === 0) {
      // Unreachable behind (1): an empty range means the branch IS an ancestor.
      // It refuses rather than reports "all 0 commits landed" if it ever is.
      return undecidable(`'${branch}' has no commits since '${parentBranch}' yet is not its ancestor`)
    }

    // (5) The bound, on both sides — git cherry patch-ids the parent range too.
    const parentCount = Number.parseInt(
      (await git(repoPath, 'rev-list', '--count', `${base}..${parentBranch}`)).stdout.trim(),
      10,
    )
    if (!Number.isSafeInteger(parentCount)) return undecidable('could not count the parent commits')
    if (expected > maxCommits || parentCount > maxCommits) {
      return undecidable(
        `comparing ${expected} branch commit(s) against ${parentCount} parent commit(s) ` +
          `exceeds the bound of ${maxCommits}`,
      )
    }

    // (6) The comparison itself. `git cherry` takes no `--` separator, which is
    //     why both refs were validated above.
    const { stdout } = await git(repoPath, 'cherry', '-v', parentBranch, branch)
    const lines = stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l !== '')
    return interpretCherry({ lines, expectedCommits: expected })
  } catch (err) {
    return undecidable(failed(err))
  }
}

/** git's refusal to delete a branch it does not consider merged. */
const NOT_FULLY_MERGED = /not fully merged/i

/**
 * Delete an issue's branch — THE SECOND WALL (PDM-392).
 *
 * `git branch -d` runs its own merged check, and under cherry-pick integration
 * it refuses every landed leaf exactly as `merge-base --is-ancestor` did. So
 * fixing only podium's guard would remove the worktree and still leave the
 * branch: the same partial outcome, one step later, and no disk reclaimed.
 *
 * THE ESCALATION LIVES HERE, WITH THE EVIDENCE. `-D` is never added to the op
 * table, and the server is never given a way to ask for a forced delete; it
 * asks for a delete and names the parent, and this function decides whether the
 * CONTENT justifies one. `branchDeleteForce` stays what it was: restricted to
 * the integrate-tmp/* namespace. Without a parent branch there is nothing to
 * compare against and the shipped `-d` refusal stands untouched.
 */
export async function deleteBranchIfLanded(opts: {
  repoPath: string
  branch: string
  parentBranch?: string
}): Promise<{ ok: boolean; output: string }> {
  const cmd = repoOpCommand('branchDelete', { branch: opts.branch })
  if ('error' in cmd) return { ok: false, output: cmd.error }
  const run = async (argv: string[]): Promise<{ ok: boolean; output: string }> => {
    try {
      const { stdout, stderr } = await git(opts.repoPath, ...argv)
      return { ok: true, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() }
    } catch (err) {
      return { ok: false, output: failed(err) }
    }
  }
  const first = await run(cmd.argv)
  if (first.ok || !opts.parentBranch || !NOT_FULLY_MERGED.test(first.output)) return first
  const verdict = await branchLandedVerdict({
    repoPath: opts.repoPath,
    branch: opts.branch,
    parentBranch: opts.parentBranch,
  })
  if (verdict.verdict !== 'landed') {
    return { ok: false, output: `${first.output}\n(content check: ${verdict.output})` }
  }
  const bad = assertSafeRef(opts.branch, 'branch')
  if (bad) return { ok: false, output: bad }
  const forced = await run(['branch', '-D', '--', opts.branch])
  if (!forced.ok) return forced
  return {
    ok: true,
    output: `${forced.output}\n(git -d refused it as unmerged; deleted on content: ${verdict.output})`,
  }
}
