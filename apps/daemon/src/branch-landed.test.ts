/**
 * "IS THIS WORK IN THAT HISTORY" — THE QUESTION CLEANUP MEANT TO ASK (PDM-392).
 *
 * `cleanup` gated on `git merge-base --is-ancestor <branch> <parentBranch>`.
 * Under an integration model that CHERRY-PICKS every leaf onto the integration
 * branch and re-gates it there, a leaf branch is never an ancestor of its
 * parent, so that guard answers "not merged" for work that landed cleanly hours
 * ago — every single time, for every leaf. The guard is doing exactly what it
 * says; its question is the wrong one.
 *
 * Ancestry asks "is this COMMIT in that history". Cleanup means to ask "is this
 * WORK in that history", and a cherry-pick changes the commit while preserving
 * the work. These cases run REAL git against real repositories in a temp dir,
 * because the whole fix rests on measured git behaviour rather than on what
 * git's documentation can be read to promise.
 *
 * THE PROPERTY THAT MATTERS IS NOT "SAYS LANDED MORE OFTEN". Deleting a branch
 * is irreversible in a way that leaving it is not, so the predicate has a THIRD
 * answer: it refuses when it cannot tell. Every shape below that it declines to
 * judge is a case where a yes/no predicate would have had to guess, and the
 * merge case is one where guessing destroys the only copy of real work.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { branchLandedVerdict, deleteBranchIfLanded, interpretCherry } from './branch-landed'

const execFileAsync = promisify(execFile)

const IDENTITY = [
  '-c',
  'user.name=podium test',
  '-c',
  'user.email=test@podium.invalid',
  '-c',
  'commit.gpgsign=false',
]

const git = async (cwd: string, ...argv: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...IDENTITY, ...argv])
  return stdout.trim()
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A repo on `main` with one root commit. */
async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'podium-landed-'))
  roots.push(root)
  const path = join(root, 'r')
  await execFileAsync('git', ['init', '-q', '-b', 'main', path])
  await git(path, 'commit', '-q', '--allow-empty', '-m', 'root')
  return path
}

/** Commit `text` into `file` on the current branch. */
async function commit(path: string, file: string, text: string, subject: string): Promise<void> {
  writeFileSync(join(path, file), `${text}\n`)
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', subject)
}

const sha = (path: string, ref: string): Promise<string> => git(path, 'rev-parse', ref)

describe('branchLandedVerdict', () => {
  it('says landed when the branch is an ancestor of the parent', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'merge', '-q', '--ff-only', 'leaf')

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('landed')
    expect(v.output).toMatch(/ancestor/i)
  })

  it('says landed when every commit was cherry-picked into the parent under new shas', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await commit(r, 'b.txt', 'two', 'leaf: two')
    await git(r, 'checkout', '-q', 'main')
    await commit(r, 'other.txt', 'elsewhere', 'somebody else landed first')
    await git(r, 'cherry-pick', `${await sha(r, 'leaf~1')}`, `${await sha(r, 'leaf')}`)

    // The shipped guard's question, for contrast: still "no", and always will be.
    await expect(
      execFileAsync('git', ['-C', r, 'merge-base', '--is-ancestor', '--', 'leaf', 'main']),
    ).rejects.toThrow()

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('landed')
    expect(v.output).toMatch(/2 commit/)
  })

  it('says not landed when one of the branch commits never reached the parent', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await commit(r, 'b.txt', 'two', 'leaf: two')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'cherry-pick', `${await sha(r, 'leaf~1')}`)

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('not-landed')
    expect(v.output).toContain('leaf: two')
    expect(v.output).not.toContain('leaf: one')
  })

  it('says not landed when the parent squashed the branch into one commit', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await commit(r, 'b.txt', 'two', 'leaf: two')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'merge', '--squash', 'leaf')
    await git(r, 'commit', '-q', '-m', 'squashed leaf')

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('not-landed')
  })

  it('says not landed for a look-alike branch whose commits differ in content', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'the real thing', 'leaf: one')
    await git(r, 'checkout', '-q', 'main')
    // Same file, same subject, different content: a patch-id must not match it.
    await commit(r, 'a.txt', 'something else entirely', 'leaf: one')

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('not-landed')
    expect(v.output).toContain('leaf: one')
  })

  /**
   * THE CASE THAT MAKES THE THIRD ANSWER NECESSARY.
   *
   * Measured, git 2.43.0: `git cherry` walks with --no-merges, so a merge
   * commit is never reported — neither as landed nor as missing. A merge whose
   * resolution introduced content of its own ("evil merge") therefore produces
   * EMPTY cherry output, which a two-valued predicate reads as "everything
   * landed". The file below exists only on the branch. A predicate that said
   * landed here would delete the only copy.
   */
  it('refuses a branch carrying a merge commit, whose content git cherry cannot see', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'side')
    await commit(r, 's.txt', 'side work', 'side: work')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'cherry-pick', `${await sha(r, 'side')}`)
    await git(r, 'checkout', '-q', '-b', 'leaf', `${await sha(r, 'main~1')}`)
    await git(r, 'merge', '--no-ff', '--no-commit', 'side').catch(() => undefined)
    writeFileSync(join(r, 'only-copy.txt'), 'this exists nowhere else\n')
    await git(r, 'add', '-A')
    await git(r, 'commit', '-q', '-m', 'leaf: merge side (evil resolution)')

    // The trap, stated as a fact about git rather than as a claim about us.
    const cherry = await git(r, 'cherry', '-v', 'main', 'leaf')
    expect(cherry).toBe('')
    await expect(execFileAsync('git', ['-C', r, 'cat-file', '-e', 'main:only-copy.txt'])).rejects.toThrow()

    const v = await branchLandedVerdict({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/merge commit/i)
  })

  it('refuses when the branch and the parent share no history', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '--orphan', 'alien')
    await git(r, 'rm', '-rq', '--cached', '.').catch(() => undefined)
    await commit(r, 'x.txt', 'alien', 'alien: root')

    const v = await branchLandedVerdict({ repoPath: r, branch: 'alien', parentBranch: 'main' })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/no common ancestor/i)
  })

  it('refuses rather than compare more commits than its bound allows', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await commit(r, 'b.txt', 'two', 'leaf: two')
    await git(r, 'checkout', '-q', 'main')
    // Without this the cherry-picks below would land on the SAME parent with the
    // same content and message, reproduce leaf's shas exactly, and fast-forward
    // main onto leaf — making it a true ancestor and testing nothing.
    await commit(r, 'other.txt', 'elsewhere', 'somebody else landed first')
    await git(r, 'cherry-pick', `${await sha(r, 'leaf~1')}`, `${await sha(r, 'leaf')}`)

    const v = await branchLandedVerdict({
      repoPath: r,
      branch: 'leaf',
      parentBranch: 'main',
      maxCommits: 1,
    })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/bound|too many/i)
  })

  it('refuses a branch name that could parse as a git option', async () => {
    const r = await repo()
    const v = await branchLandedVerdict({ repoPath: r, branch: '--upload-pack=x', parentBranch: 'main' })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/unsafe branch/i)
  })
})

/**
 * The accounting half, as a pure function. `git cherry` is the comparison
 * engine, but trusting it means trusting that it reported on EVERY commit —
 * and the merge case above is proof that it silently reports on fewer than it
 * was asked about. So the caller states how many commits it expects a line
 * for, and a mismatch refuses instead of reading a short list as "all clear".
 */
describe('interpretCherry', () => {
  it('reads a full set of "-" lines as landed', () => {
    const v = interpretCherry({
      lines: ['- aaaaaaa leaf: one', '- bbbbbbb leaf: two'],
      expectedCommits: 2,
    })
    expect(v.verdict).toBe('landed')
  })

  it('reads a "+" line as not landed and names the commit', () => {
    const v = interpretCherry({
      lines: ['- aaaaaaa leaf: one', '+ bbbbbbb leaf: two'],
      expectedCommits: 2,
    })
    expect(v.verdict).toBe('not-landed')
    expect(v.output).toContain('leaf: two')
  })

  it('refuses when git reported on fewer commits than the branch has', () => {
    const v = interpretCherry({ lines: ['- aaaaaaa leaf: one'], expectedCommits: 2 })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/1 of 2/)
  })

  it('refuses an empty report rather than read it as "nothing outstanding"', () => {
    const v = interpretCherry({ lines: [], expectedCommits: 1 })
    expect(v.verdict).toBe('undecidable')
  })

  it('refuses a line it cannot parse', () => {
    const v = interpretCherry({ lines: ['? aaaaaaa who knows'], expectedCommits: 1 })
    expect(v.verdict).toBe('undecidable')
    expect(v.output).toMatch(/could not parse/i)
  })
})

/**
 * THE SECOND WALL. `git branch -d` refuses an unmerged branch, and under
 * cherry-pick integration a landed leaf is always "unmerged" to git. So fixing
 * only the podium-side guard would remove the worktree and still leave every
 * branch behind — the same partial outcome, one step later. The escalation to
 * -D lives HERE, next to the evidence, so that the server never gains a way to
 * ask for a forced delete: it can only ask for a delete, and this function
 * decides whether the content justifies one.
 */
describe('deleteBranchIfLanded', () => {
  it('deletes a branch that plain -d already accepts, without asking anything else', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'merge', '-q', '--ff-only', 'leaf')

    const res = await deleteBranchIfLanded({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(res.ok).toBe(true)
    expect(res.output).not.toMatch(/content/i)
    await expect(execFileAsync('git', ['-C', r, 'rev-parse', '--verify', 'leaf'])).rejects.toThrow()
  })

  it('deletes a cherry-picked branch that -d refuses, once the content check says landed', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await git(r, 'checkout', '-q', 'main')
    await commit(r, 'other.txt', 'elsewhere', 'somebody else landed first')
    await git(r, 'cherry-pick', `${await sha(r, 'leaf')}`)

    const res = await deleteBranchIfLanded({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(res.ok).toBe(true)
    expect(res.output).toMatch(/content/i)
    await expect(execFileAsync('git', ['-C', r, 'rev-parse', '--verify', 'leaf'])).rejects.toThrow()
  })

  it('keeps the branch at its identical sha when the content check refuses', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'side')
    await commit(r, 's.txt', 'side work', 'side: work')
    await git(r, 'checkout', '-q', 'main')
    await git(r, 'cherry-pick', `${await sha(r, 'side')}`)
    await git(r, 'checkout', '-q', '-b', 'leaf', `${await sha(r, 'main~1')}`)
    await git(r, 'merge', '--no-ff', '--no-commit', 'side').catch(() => undefined)
    writeFileSync(join(r, 'only-copy.txt'), 'this exists nowhere else\n')
    await git(r, 'add', '-A')
    await git(r, 'commit', '-q', '-m', 'leaf: merge side (evil resolution)')
    const before = await sha(r, 'leaf')
    await git(r, 'checkout', '-q', 'main')

    const res = await deleteBranchIfLanded({ repoPath: r, branch: 'leaf', parentBranch: 'main' })
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/merge commit/i)
    expect(await sha(r, 'leaf')).toBe(before)
  })

  it('never escalates when no parent branch is supplied', async () => {
    const r = await repo()
    await git(r, 'checkout', '-q', '-b', 'leaf')
    await commit(r, 'a.txt', 'one', 'leaf: one')
    await git(r, 'checkout', '-q', 'main')
    await commit(r, 'other.txt', 'elsewhere', 'somebody else landed first')
    await git(r, 'cherry-pick', `${await sha(r, 'leaf')}`)
    const before = await sha(r, 'leaf')

    const res = await deleteBranchIfLanded({ repoPath: r, branch: 'leaf' })
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/not fully merged/i)
    expect(await sha(r, 'leaf')).toBe(before)
  })
})
