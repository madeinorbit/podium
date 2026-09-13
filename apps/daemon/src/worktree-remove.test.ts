/**
 * FREEING A WORKTREE THAT CONTAINS A SUBMODULE (PDM-373).
 *
 * `git worktree remove` refuses outright when the worktree's index carries a
 * gitlink — "fatal: working trees containing submodules cannot be moved or
 * removed" — and it refuses BEFORE it looks at whether the worktree is clean.
 * Both of podium's worktree-freeing paths (`issue stop` and `issue cleanup`)
 * send the same `worktreeRemove` op, so on any superproject with a submodule
 * neither can ever free anything: 126 worktrees had accumulated on the machine
 * this was found on.
 *
 * These cases run REAL git against real repositories built in a temp dir. The
 * property they pin is the one the manual recipe preserved and a fix must not
 * lose: the worktree goes, the BRANCH SURVIVES AT THE IDENTICAL SHA, and work
 * that was never committed is refused rather than discarded.
 *
 * Note what is NOT delegated to git here. git's own clean check lives behind
 * the same `--force` that waives the submodule refusal, so escalating to
 * `--force` would waive both at once; the clean probe these cases exercise has
 * to be run separately, and it is `--ignore-submodules=none` precisely because
 * that is the spelling `git worktree remove` uses for its own.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeWorktreeWithSubmodules } from './worktree-remove'

const execFileAsync = promisify(execFile)

const IDENTITY = [
  '-c',
  'user.name=podium test',
  '-c',
  'user.email=test@podium.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'protocol.file.allow=always',
]

const git = async (cwd: string, ...argv: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...IDENTITY, ...argv])
  return stdout.trim()
}

/** superproject + one submodule + one worktree; the worktree's submodule is checked out. */
async function fixture(opts: { withSubmodule: boolean }): Promise<{
  root: string
  repo: string
  worktree: string
  branch: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'podium-wt-remove-'))
  const repo = join(root, 'super')
  await execFileAsync('git', ['init', '-q', '-b', 'main', repo])
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
  if (opts.withSubmodule) {
    const sub = join(root, 'sub')
    await execFileAsync('git', ['init', '-q', '-b', 'main', sub])
    await git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub root')
    await git(repo, 'submodule', 'add', '-q', '--', sub, 'oss/dep')
    await git(repo, 'commit', '-q', '-m', 'add submodule')
  }
  const worktree = join(root, 'wt')
  const branch = 'issue/1-example'
  await git(repo, 'worktree', 'add', '-q', '-b', branch, '--', worktree)
  if (opts.withSubmodule) await git(worktree, 'submodule', 'update', '--init', '-q')
  return { root, repo, worktree, branch }
}

describe('removeWorktreeWithSubmodules', () => {
  let root: string | undefined

  beforeEach(() => {
    root = undefined
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('frees a clean worktree containing a submodule and keeps the branch at the same sha', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    // The branch carries work: the property under test is that it survives.
    writeFileSync(join(fx.worktree, 'landed.txt'), 'landed\n')
    await git(fx.worktree, 'add', 'landed.txt')
    await git(fx.worktree, 'commit', '-q', '-m', 'work')
    const sha = await git(fx.repo, 'rev-parse', fx.branch)

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok, res.output).toBe(true)
    expect(existsSync(fx.worktree)).toBe(false)
    expect(await git(fx.repo, 'rev-parse', fx.branch)).toBe(sha)
    expect(await git(fx.repo, 'worktree', 'list', '--porcelain')).not.toContain(fx.worktree)
  })

  it('refuses a submodule worktree carrying uncommitted work inside the submodule', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    const stranded = join(fx.worktree, 'oss/dep/unsaved.txt')
    writeFileSync(stranded, 'never committed\n')

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok).toBe(false)
    expect(existsSync(stranded)).toBe(true)
    expect(res.output).toMatch(/modified or untracked|uncommitted|unsaved/i)
  })

  it('refuses a submodule worktree carrying uncommitted work in the superproject', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    const stranded = join(fx.worktree, 'unsaved.txt')
    writeFileSync(stranded, 'never committed\n')

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok).toBe(false)
    expect(existsSync(stranded)).toBe(true)
    expect(res.output).toMatch(/modified or untracked/i)
  })

  /**
   * The superproject is spotless in this case — gitlink committed, HEAD matching,
   * `git status` empty. The only copy of the submodule's branch lives in the
   * worktree's own object store, which removal destroys.
   */
  it('refuses when a submodule carries a commit on a local branch that is on no remote', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    const sub = join(fx.worktree, 'oss/dep')
    await git(sub, 'checkout', '-q', '-b', 'oss-work')
    await git(sub, 'commit', '-q', '--allow-empty', '-m', 'unpushed submodule work')
    const sha = await git(sub, 'rev-parse', 'HEAD')
    await git(fx.worktree, 'add', 'oss/dep')
    await git(fx.worktree, 'commit', '-q', '-m', 'bump gitlink')
    expect(await git(fx.worktree, 'status', '--porcelain', '--ignore-submodules=none')).toBe('')

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/submodule 'oss\/dep' carries 1 commit on a local branch/i)
    expect(existsSync(sub)).toBe(true)
    expect(await git(sub, 'rev-parse', 'oss-work')).toBe(sha)
  })

  /** The other direction: once that work is on a remote, the guard lets go. */
  it('frees the worktree once the submodule branch is on a remote', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    const sub = join(fx.worktree, 'oss/dep')
    await git(sub, 'checkout', '-q', '-b', 'oss-work')
    await git(sub, 'commit', '-q', '--allow-empty', '-m', 'submodule work')
    await git(sub, 'push', '-q', 'origin', 'oss-work')
    await git(fx.worktree, 'add', 'oss/dep')
    await git(fx.worktree, 'commit', '-q', '-m', 'bump gitlink')
    const branchSha = await git(fx.repo, 'rev-parse', fx.branch)

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok, res.output).toBe(true)
    expect(existsSync(fx.worktree)).toBe(false)
    expect(await git(fx.repo, 'rev-parse', fx.branch)).toBe(branchSha)
  })

  it('refuses a LOCKED submodule worktree — the lock outranks the escalation', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    await git(fx.repo, 'worktree', 'lock', '--', fx.worktree)

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok).toBe(false)
    expect(existsSync(fx.worktree)).toBe(true)
    expect(res.output).toMatch(/locked/i)
  })

  it('discards a dirty submodule worktree when the caller forces, keeping the branch', async () => {
    const fx = await fixture({ withSubmodule: true })
    root = fx.root
    writeFileSync(join(fx.worktree, 'unsaved.txt'), 'discarded\n')
    const sha = await git(fx.repo, 'rev-parse', fx.branch)

    const res = await removeWorktreeWithSubmodules({
      repoPath: fx.repo,
      path: fx.worktree,
      force: true,
    })

    expect(res.ok, res.output).toBe(true)
    expect(existsSync(fx.worktree)).toBe(false)
    expect(await git(fx.repo, 'rev-parse', fx.branch)).toBe(sha)
  })

  it('still frees a worktree with no submodule', async () => {
    const fx = await fixture({ withSubmodule: false })
    root = fx.root
    const sha = await git(fx.repo, 'rev-parse', fx.branch)

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok, res.output).toBe(true)
    expect(existsSync(fx.worktree)).toBe(false)
    expect(await git(fx.repo, 'rev-parse', fx.branch)).toBe(sha)
  })

  it('still refuses a dirty worktree with no submodule', async () => {
    const fx = await fixture({ withSubmodule: false })
    root = fx.root
    const stranded = join(fx.worktree, 'unsaved.txt')
    writeFileSync(stranded, 'never committed\n')

    const res = await removeWorktreeWithSubmodules({ repoPath: fx.repo, path: fx.worktree })

    expect(res.ok).toBe(false)
    expect(existsSync(stranded)).toBe(true)
  })

  it('reports the builder error when the path is missing', async () => {
    const res = await removeWorktreeWithSubmodules({ repoPath: tmpdir(), path: '' })
    expect(res).toEqual({ ok: false, output: 'missing args' })
  })
})
