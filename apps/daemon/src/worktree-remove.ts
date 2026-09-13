import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { repoOpCommand } from './repo-op'

const execFileAsync = promisify(execFile)

/** Same kill budget the generic repo-op path runs every git under. */
const GIT_OPTS = { timeout: 120_000, maxBuffer: 1024 * 1024 } as const

export type WorktreeRemoveResult = { ok: boolean; output: string }

const failed = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * git's flat refusal, raised by `validate_no_submodules()` in
 * builtin/worktree.c BEFORE the clean check.
 *
 * WHAT IT ACTUALLY TESTS, because it is not what the message says. First, does
 * `<worktree gitdir>/modules` exist — and if so it refuses outright, without
 * reading anything. Only when that directory is absent does it fall back to
 * looking for a POPULATED gitlink in the index.
 *
 * Two consequences, both measured (git 2.43.0). A worktree whose submodule was
 * never initialised has no `modules` directory and no populated gitlink, so it
 * frees today without any of this — which is why the defect looks intermittent:
 * it bites exactly the worktrees somebody actually worked in. And `git
 * submodule deinit` does NOT lift the refusal, because it empties the checkout
 * and leaves `modules` standing.
 */
const SUBMODULE_REFUSAL = /working trees containing submodules cannot be moved or removed/i

const git = (cwd: string, ...argv: string[]): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('git', ['-C', cwd, ...argv], GIT_OPTS)

/**
 * Paths of the worktree's submodules that have a checkout. `git submodule
 * status` prefixes an uninitialized entry with '-'; those carry no objects of
 * their own and nothing can be stranded in them.
 */
async function checkedOutSubmodules(worktreePath: string): Promise<string[]> {
  const { stdout } = await git(worktreePath, 'submodule', 'status')
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('-'))
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((p): p is string => !!p)
}

/**
 * Work that removing the worktree would destroy, expressed as a refusal or null.
 *
 * TWO KINDS, AND ONLY ONE OF THEM IS GIT'S.
 *
 * (a) Modified or untracked files. `git worktree remove` checks this itself —
 *     but behind the SAME `--force` that waives the submodule refusal, so
 *     escalating to `--force` waives both at once and we have to ask separately.
 *     The spelling is git's own (`--ignore-submodules=none`, builtin/worktree.c),
 *     so a dirty submodule counts here exactly as it would have.
 *
 * (b) Commits on a local branch INSIDE a submodule that are on no remote. This
 *     has no analogue in git's check and it is the sharper hazard here: a
 *     worktree's submodule gitdir is its OWN object store, under
 *     `.git/worktrees/<name>/modules/<path>`, not the superproject root's. So
 *     the superproject can be spotlessly clean — gitlink committed, HEAD
 *     matching — while the only copy of a submodule branch lives inside the
 *     directory we are about to delete. `inspectRemovableWorktree` asks the
 *     equivalent question of the SUPERPROJECT before it ever gets here; nothing
 *     asked it of the submodules, because until now nothing could remove one.
 */
async function strandedWork(worktreePath: string): Promise<string | null> {
  const { stdout: dirty } = await git(
    worktreePath,
    'status',
    '--porcelain',
    '--ignore-submodules=none',
  )
  if (dirty.trim() !== '') {
    return (
      `refusing removal: '${worktreePath}' contains modified or untracked files ` +
      `(git's own check, which --force would waive):\n${dirty.trim()}`
    )
  }
  for (const sub of await checkedOutSubmodules(worktreePath)) {
    const { stdout: count } = await git(
      join(worktreePath, sub),
      'rev-list',
      '--count',
      '--branches',
      '--not',
      '--remotes',
    )
    const unpushed = Number.parseInt(count.trim(), 10)
    if (!Number.isSafeInteger(unpushed)) {
      return `refusing removal: cannot count unpushed commits in submodule '${sub}'`
    }
    if (unpushed > 0) {
      return (
        `refusing removal: submodule '${sub}' carries ${unpushed} ` +
        `commit${unpushed === 1 ? '' : 's'} on a local branch that is on no remote; ` +
        "this worktree holds that submodule's only object store, so removing it " +
        'would strand that work (push the submodule branch first)'
      )
    }
  }
  return null
}

/**
 * Free a worktree, keeping its branch (PDM-373).
 *
 * The argv is `repoOpCommand('worktreeRemove')`'s, unchanged — this is the one
 * place that RUNS it, so both callers of the op (`issue stop` and `issue
 * cleanup`) are bound by whatever this function decides. The escalation is
 * deliberately NOT a second entry in the op table: an op is a fixed argv, and
 * "try, then ask a question, then retry differently" is not one.
 *
 * ON A SUBMODULE REFUSAL, ASK GIT'S OWN QUESTION AND THEN FORCE. A single
 * `--force` waives the submodule refusal and the clean check; it does NOT waive
 * the worktree LOCK (that needs `-f -f`), so a locked worktree still refuses and
 * an operator's lock still means what it says. `strandedWork` puts the clean
 * check back, and adds the one git has no analogue for.
 *
 * The branch is untouched either way: `git worktree remove` removes the checkout
 * and the administrative directory, never a ref.
 */
export async function removeWorktreeWithSubmodules(opts: {
  repoPath: string
  path: string
  force?: boolean
}): Promise<WorktreeRemoveResult> {
  const cmd = repoOpCommand('worktreeRemove', {
    path: opts.path,
    ...(opts.force ? { force: '1' } : {}),
  })
  if ('error' in cmd) return { ok: false, output: cmd.error }
  const run = async (argv: string[]): Promise<WorktreeRemoveResult> => {
    try {
      const { stdout, stderr } = await git(opts.repoPath, ...argv)
      return { ok: true, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() }
    } catch (err) {
      return { ok: false, output: failed(err) }
    }
  }
  const first = await run(cmd.argv)
  if (first.ok || opts.force || !SUBMODULE_REFUSAL.test(first.output)) return first
  let stranded: string | null
  try {
    stranded = await strandedWork(opts.path)
  } catch (err) {
    // The probe is the only thing standing in for git's own guard. If it cannot
    // be answered, the answer is the refusal we already have.
    return { ok: false, output: `${first.output}\n(clean probe failed: ${failed(err)})` }
  }
  if (stranded) return { ok: false, output: stranded }
  return await run(['worktree', 'remove', '--force', '--', opts.path])
}
