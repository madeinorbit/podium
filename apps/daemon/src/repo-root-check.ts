import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { isInside, sandboxRoot } from './file-access'

const execFileAsync = promisify(execFile)

/** Runs `git rev-parse` in a folder; injectable so a test can stand in for git. */
export type RevParse = (cwd: string, args: readonly string[]) => Promise<string>

const gitRevParse: RevParse = async (cwd, args) =>
  (await execFileAsync('git', ['-C', cwd, 'rev-parse', ...args], { timeout: 10_000 })).stdout

/** One answer of `rev-parse`, resolved the way git means it and then realpath'd:
 *  `--git-common-dir` may answer relative to the folder git ran in. */
async function resolvedLines(
  revParse: RevParse,
  cwd: string,
  args: readonly string[],
): Promise<string[] | undefined> {
  try {
    const lines = (await revParse(cwd, args)).split(/\r?\n/).filter((line) => line !== '')
    if (lines.length !== args.length) return undefined
    return await Promise.all(lines.map(async (line) => await realpath(resolve(cwd, line))))
  } catch {
    return undefined
  }
}

/**
 * WHICH REPOSITORY GIT WOULD REALLY USE IN A CALLER'S FOLDER (POD-7505).
 *
 * {@link sandboxRoot} proves the folder sits inside the registered repository,
 * but git does not stop at the folder: a `.git` file in a subfolder
 * (`gitdir: /home/a/repo/.git`) points it at another repository's history, and
 * `core.worktree` points it at another working tree. So git itself is asked,
 * and both of its answers must stay home:
 *
 * - the working tree (`--show-toplevel`) inside the sandbox: the repository,
 *   or the linked worktree the server recorded for it (`worktreeRoot`);
 * - the repository data (`--git-common-dir`) inside the registered repository,
 *   or the very one the registered repository itself uses (a registered root
 *   may itself be a linked worktree whose data lives in its main checkout).
 *
 * `worktreeRoot` is a linked worktree of `repoRoot` that lives outside it, such
 * as the sibling `<repo>-<branch>` the assistant's `create_worktree` makes. The
 * server sends one only from its own scan of the repository's worktrees, and the
 * common-dir rule is what makes it safe: a "worktree" of somebody else's
 * repository has somebody else's repository data.
 *
 * Answers the folder git should run in, or the refusal.
 */
export async function checkRepoOpRoot(
  opts: { cwd: string; repoRoot: string; worktreeRoot?: string | undefined },
  revParse: RevParse = gitRevParse,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const sandboxPath = opts.worktreeRoot ?? opts.repoRoot
  const sandbox = await sandboxRoot(opts.cwd, sandboxPath)
  if (!sandbox.ok) return sandbox
  let realRepo: string
  let realSandbox: string
  try {
    realRepo = await realpath(opts.repoRoot)
    realSandbox = await realpath(sandboxPath)
  } catch {
    return { ok: false, error: 'repository not found' }
  }
  const here = await resolvedLines(revParse, sandbox.real, ['--show-toplevel', '--git-common-dir'])
  if (here === undefined) return { ok: false, error: 'not a git working tree' }
  const [toplevel, common] = here as [string, string]
  if (!isInside(toplevel, realSandbox)) return { ok: false, error: 'worktree outside repository' }
  if (isInside(common, realRepo)) return { ok: true, cwd: sandbox.real }
  const own = await resolvedLines(revParse, realRepo, ['--git-common-dir'])
  return own !== undefined && own[0] === common
    ? { ok: true, cwd: sandbox.real }
    : { ok: false, error: 'git data outside repository' }
}
