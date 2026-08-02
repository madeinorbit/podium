import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertSafeRef, repoOpCommand } from './repo-op'

describe('repoOpCommand', () => {
  it('builds read ops', () => {
    expect(repoOpCommand('status')).toEqual({
      bin: 'git',
      argv: ['status', '--porcelain=v1', '-b'],
    })
    expect(repoOpCommand('log')).toEqual({ bin: 'git', argv: ['log', '--oneline', '-20'] })
  })
  it('git dock panel ops are lock-free reads [POD-114]', () => {
    expect(repoOpCommand('logPanel')).toEqual({
      bin: 'git',
      argv: ['--no-optional-locks', 'log', '-50', '--format=%h%x09%H%x09%cI%x09%an%x09%s'],
    })
    expect(repoOpCommand('diffFile', { path: 'src/a.ts' })).toEqual({
      bin: 'git',
      argv: ['--no-optional-locks', 'diff', 'HEAD', '--', 'src/a.ts'],
    })
    // A dash path is inert after `--` (pathspec, never an option).
    expect(repoOpCommand('diffFile', { path: '-D' })).toEqual({
      bin: 'git',
      argv: ['--no-optional-locks', 'diff', 'HEAD', '--', '-D'],
    })
    expect(repoOpCommand('diffFile', {})).toEqual({ error: 'missing args' })
  })
  it('builds clone with an absolute destination and literal origin', () => {
    expect(
      repoOpCommand('clone', { originUrl: '--upload-pack=evil', path: '/home/u/src/repo' }),
    ).toEqual({
      bin: 'git',
      argv: ['clone', '--', '--upload-pack=evil', '/home/u/src/repo'],
    })
    expect(
      repoOpCommand('clone', { originUrl: 'https://example.test/repo.git', path: 'relative' }),
    ).toEqual({ error: 'clone path must be absolute' })
    expect(repoOpCommand('clone', {})).toEqual({ error: 'missing args' })
  })
  /**
   * POD-1405 — the object half of a handoff, for a machine that has no session to
   * move. `git bundle create` has NO `--` protecting its rev slots, so an
   * unguarded value like `--all` parses as an option and bundles the whole
   * repository; and neither op may take a filesystem path shaped by a caller.
   */
  it('bundleCreate guards every rev slot and refuses a relative output', () => {
    expect(
      repoOpCommand('bundleCreate', {
        out: '/stage/t.bundle',
        ref: 'integration/x',
        bases: `${'a'.repeat(40)},${'b'.repeat(40)}`,
      }),
    ).toEqual({
      bin: 'git',
      argv: [
        'bundle',
        'create',
        '/stage/t.bundle',
        'integration/x',
        `^${'a'.repeat(40)}`,
        `^${'b'.repeat(40)}`,
      ],
    })
    // No bases is legal — a target that shares nothing gets the full history.
    expect(repoOpCommand('bundleCreate', { out: '/stage/t.bundle', ref: 'main' })).toEqual({
      bin: 'git',
      argv: ['bundle', 'create', '/stage/t.bundle', 'main'],
    })
    // The rev slots refuse a dash rather than passing it to git as an option.
    expect(repoOpCommand('bundleCreate', { out: '/stage/t.bundle', ref: '--all' })).toEqual({
      error: "unsafe ref: must not start with '-' (got '--all')",
    })
    expect(
      repoOpCommand('bundleCreate', { out: '/stage/t.bundle', ref: 'main', bases: '--all' }),
    ).toEqual({ error: "unsafe base: must not start with '-' (got '--all')" })
    expect(repoOpCommand('bundleCreate', { out: 'relative.bundle', ref: 'main' })).toEqual({
      error: 'bundle path must be absolute',
    })
    expect(repoOpCommand('bundleCreate', {})).toEqual({ error: 'missing args' })
  })

  it('bundleFetch takes the bundle as a positional and guards the ref', () => {
    expect(repoOpCommand('bundleFetch', { bundle: '/stage/t.bundle', ref: 'main' })).toEqual({
      bin: 'git',
      argv: ['fetch', '--', '/stage/t.bundle', 'main'],
    })
    expect(repoOpCommand('bundleFetch', { bundle: '/stage/t.bundle', ref: '--exec=evil' })).toEqual(
      { error: "unsafe ref: must not start with '-' (got '--exec=evil')" },
    )
    expect(repoOpCommand('bundleFetch', { bundle: 'relative', ref: 'main' })).toEqual({
      error: 'bundle path must be absolute',
    })
    expect(repoOpCommand('bundleFetch', {})).toEqual({ error: 'missing args' })
  })

  it('worktreeAdd with and without start point (options before --, positionals after)', () => {
    expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x' })).toEqual({
      bin: 'git',
      argv: ['worktree', 'add', '-b', 'issue/1-x', '--', '/r/wt'],
    })
    expect(
      repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x', startPoint: 'main' }),
    ).toEqual({ bin: 'git', argv: ['worktree', 'add', '-b', 'issue/1-x', '--', '/r/wt', 'main'] })
  })
  it('worktreeAddExisting attaches a preserved branch (no -b/-B) [spec:SP-9904]', () => {
    expect(repoOpCommand('worktreeAddExisting', { path: '/r/wt', branch: 'issue/1-x' })).toEqual({
      bin: 'git',
      argv: ['worktree', 'add', '--', '/r/wt', 'issue/1-x'],
    })
    expect(repoOpCommand('worktreeAddExisting', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeAddExisting', { path: '/r/wt', branch: '-D' })).toEqual({
      error: "unsafe branch: must not start with '-' (got '-D')",
    })
  })
  it('rebase / mergeFfOnly / prCreate', () => {
    expect(repoOpCommand('rebase', { parentBranch: 'main' })).toEqual({
      bin: 'git',
      argv: ['rebase', '--', 'main'],
    })
    expect(repoOpCommand('mergeFfOnly', { branch: 'issue/1-x' })).toEqual({
      bin: 'git',
      argv: ['merge', '--ff-only', '--', 'issue/1-x'],
    })
    expect(repoOpCommand('prCreate', { branch: 'issue/1-x', parentBranch: 'main' })).toEqual({
      bin: 'gh',
      argv: ['pr', 'create', '--base', 'main', '--head', 'issue/1-x', '--fill'],
    })
  })
  it('cleanup ops: worktreeRemove / branchDelete / isMergedInto (never --force / -D by default)', () => {
    expect(repoOpCommand('worktreeRemove', { path: '/r/.worktrees/issue-1-x' })).toEqual({
      bin: 'git',
      argv: ['worktree', 'remove', '--', '/r/.worktrees/issue-1-x'],
    })
    expect(
      repoOpCommand('worktreeRemove', { path: '/r/.worktrees/issue-1-x', force: '1' }),
    ).toEqual({
      bin: 'git',
      argv: ['worktree', 'remove', '--force', '--', '/r/.worktrees/issue-1-x'],
    })
    expect(repoOpCommand('branchDelete', { branch: 'issue/1-x' })).toEqual({
      bin: 'git',
      argv: ['branch', '-d', '--', 'issue/1-x'],
    })
    expect(repoOpCommand('isMergedInto', { branch: 'issue/1-x', parentBranch: 'main' })).toEqual({
      bin: 'git',
      argv: ['merge-base', '--is-ancestor', '--', 'issue/1-x', 'main'],
    })
  })
  it('integrate ops: worktreeAddReset / checkoutReset / checkout / rebaseAbort (issue #70)', () => {
    expect(
      repoOpCommand('worktreeAddReset', {
        path: '/r/.worktrees/integrate-9-e',
        branch: 'integrate/9-e',
        startPoint: 'main',
      }),
    ).toEqual({
      bin: 'git',
      argv: ['worktree', 'add', '-B', 'integrate/9-e', '--', '/r/.worktrees/integrate-9-e', 'main'],
    })
    expect(repoOpCommand('checkoutReset', { branch: 'integrate/9-e', startPoint: 'main' })).toEqual(
      { bin: 'git', argv: ['checkout', '-B', 'integrate/9-e', 'main'] },
    )
    expect(repoOpCommand('checkout', { branch: 'integrate/9-e' })).toEqual({
      bin: 'git',
      argv: ['checkout', 'integrate/9-e'],
    })
    expect(repoOpCommand('rebaseAbort')).toEqual({ bin: 'git', argv: ['rebase', '--abort'] })
  })
  it('branchDeleteForce only inside the integrate-tmp/ namespace', () => {
    expect(repoOpCommand('branchDeleteForce', { branch: 'integrate-tmp/3' })).toEqual({
      bin: 'git',
      argv: ['branch', '-D', '--', 'integrate-tmp/3'],
    })
    expect(repoOpCommand('branchDeleteForce', { branch: 'issue/3-x' })).toEqual({
      error: 'branchDeleteForce is restricted to integrate-tmp/* refs',
    })
    expect(repoOpCommand('branchDeleteForce', { branch: 'main' })).toEqual({
      error: 'branchDeleteForce is restricted to integrate-tmp/* refs',
    })
    // namespace guard composes with dash hardening: '-D…' fails startsWith first
    expect(repoOpCommand('branchDeleteForce', { branch: '-D' })).toEqual({
      error: 'branchDeleteForce is restricted to integrate-tmp/* refs',
    })
  })
  it('reports missing args', () => {
    expect(repoOpCommand('worktreeAddReset', { path: '/r/wt', branch: 'integrate/1-x' })).toEqual({
      error: 'missing args',
    })
    expect(repoOpCommand('checkoutReset', { branch: 'integrate/1-x' })).toEqual({
      error: 'missing args',
    })
    expect(repoOpCommand('checkout', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('branchDeleteForce', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeAdd', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('rebase', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeRemove', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('branchDelete', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('isMergedInto', { branch: 'issue/1-x' })).toEqual({
      error: 'missing args',
    })
  })

  describe('leading-dash hardening (issue #81)', () => {
    it('assertSafeRef rejects leading-dash values with a readable label', () => {
      expect(assertSafeRef('issue/1-x', 'branch')).toBeNull()
      expect(assertSafeRef('-D', 'branch')).toBe(
        "unsafe branch: must not start with '-' (got '-D')",
      )
      expect(assertSafeRef('--force', 'startPoint')).toBe(
        "unsafe startPoint: must not start with '-' (got '--force')",
      )
    })
    it('validation-guarded ops reject dash values before spawn (no -- support)', () => {
      // checkout: `--` means pathspec; checkout -B: `--` breaks the start-point slot
      expect(repoOpCommand('checkout', { branch: '-D' })).toEqual({
        error: "unsafe branch: must not start with '-' (got '-D')",
      })
      expect(repoOpCommand('checkoutReset', { branch: '--force', startPoint: 'main' })).toEqual({
        error: "unsafe branch: must not start with '-' (got '--force')",
      })
      expect(repoOpCommand('checkoutReset', { branch: 'integrate/9-e', startPoint: '-D' })).toEqual(
        { error: "unsafe startPoint: must not start with '-' (got '-D')" },
      )
      // gh pr create: flag-value slots, `--` gives no protection
      expect(repoOpCommand('prCreate', { branch: '-D', parentBranch: 'main' })).toEqual({
        error: "unsafe branch: must not start with '-' (got '-D')",
      })
      expect(repoOpCommand('prCreate', { branch: 'issue/1-x', parentBranch: '--force' })).toEqual({
        error: "unsafe parentBranch: must not start with '-' (got '--force')",
      })
      // worktree add -b/-B: the branch is an option argument `--` cannot protect
      expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: '-D' })).toEqual({
        error: "unsafe branch: must not start with '-' (got '-D')",
      })
      expect(
        repoOpCommand('worktreeAddReset', { path: '/r/wt', branch: '--force', startPoint: 'main' }),
      ).toEqual({ error: "unsafe branch: must not start with '-' (got '--force')" })
    })
    it('--separated ops keep dash values in ref/path slots (spawn-side literal)', () => {
      expect(repoOpCommand('rebase', { parentBranch: '-D' })).toEqual({
        bin: 'git',
        argv: ['rebase', '--', '-D'],
      })
      expect(repoOpCommand('mergeFfOnly', { branch: '--force' })).toEqual({
        bin: 'git',
        argv: ['merge', '--ff-only', '--', '--force'],
      })
      expect(repoOpCommand('branchDelete', { branch: '-D' })).toEqual({
        bin: 'git',
        argv: ['branch', '-d', '--', '-D'],
      })
      expect(repoOpCommand('isMergedInto', { branch: '-D', parentBranch: 'main' })).toEqual({
        bin: 'git',
        argv: ['merge-base', '--is-ancestor', '--', '-D', 'main'],
      })
      expect(repoOpCommand('worktreeRemove', { path: '--force' })).toEqual({
        bin: 'git',
        argv: ['worktree', 'remove', '--', '--force'],
      })
    })
  })
})

describe('repoOpCommand against a real git scratch repo (issue #81)', () => {
  let repo: string
  const git = (argv: string[], cwd = repo): { code: number; out: string } => {
    try {
      const out = execFileSync('git', argv, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }
  const run = (cmd: ReturnType<typeof repoOpCommand>): { code: number; out: string } => {
    if ('error' in cmd) throw new Error(`builder refused: ${cmd.error}`)
    if (cmd.bin !== 'git') throw new Error('scratch test only runs git')
    return git(cmd.argv)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'podium-repo-op-'))
    git(['init', '-q', '-b', 'main'])
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ])
    git(['branch', 'victim']) // a branch a forced '-D' would try to delete
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('mergeFfOnly with a crafted --force branch is a ref-not-found, not a forced merge', () => {
    const r = run(repoOpCommand('mergeFfOnly', { branch: '--force' }))
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/not something we can merge/)
  })
  it('branchDelete with branch "-D" does not become a force-delete flag', () => {
    const r = run(repoOpCommand('branchDelete', { branch: '-D' }))
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/branch '-D' not found/)
    // the real branch that a parsed -D could have nuked is still there
    expect(git(['show-ref', '--verify', 'refs/heads/victim']).code).toBe(0)
  })
  it('rebase with a crafted "-D" upstream fails as invalid upstream, not an option', () => {
    const r = run(repoOpCommand('rebase', { parentBranch: '-D' }))
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/invalid upstream '-D'/)
  })
  it('isMergedInto with a dash ref is an object-name error, not an option', () => {
    const r = run(repoOpCommand('isMergedInto', { branch: '--force', parentBranch: 'main' }))
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/Not a valid object name/)
  })
  /**
   * POD-1405 END TO END, AGAINST REAL GIT — a commit that exists on NO shared
   * remote reaching a second repository.
   *
   * This is the failure the whole issue is about: our integration branches never
   * reach origin, so a clone on another machine cannot resolve the start point no
   * matter how it fetches. Asserting the argv would only prove the builder agrees
   * with itself; the claim worth pinning is that the OBJECTS actually arrive.
   *
   * The second repo is a fresh `git init`, NOT a clone — it shares no remote and
   * no history with the source, which is the state a newly-provisioned machine is
   * in and the state a fetch cannot rescue.
   */
  it('moves a commit into a repository that shares no remote with the source', () => {
    const other = mkdtempSync(join(tmpdir(), 'podium-repo-op-target-'))
    const bundle = join(other, 'transfer.bundle')
    try {
      git(['init', '-q', '-b', 'main'], other)
      // A commit that exists ONLY here.
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'local-only'])
      const sha = git(['rev-parse', 'HEAD']).out.trim()

      // The target genuinely cannot see it — the precondition, asserted rather
      // than assumed, so this cannot pass by the commit already being there.
      expect(git(['cat-file', '-e', sha], other).code).not.toBe(0)

      expect(run(repoOpCommand('bundleCreate', { out: bundle, ref: 'main' })).code).toBe(0)
      const fetched = repoOpCommand('bundleFetch', { bundle, ref: 'main' })
      if ('error' in fetched) throw new Error(`builder refused: ${fetched.error}`)
      expect(git(fetched.argv, other).code).toBe(0)

      // The object is now reachable there, which is exactly what a later
      // `worktree add <path> <startPoint>` needs in order to resolve.
      expect(git(['cat-file', '-e', sha], other).code).toBe(0)
      expect(git(['rev-parse', 'FETCH_HEAD'], other).out.trim()).toBe(sha)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('happy paths still work through the -- forms', () => {
    expect(
      run(repoOpCommand('isMergedInto', { branch: 'victim', parentBranch: 'main' })).code,
    ).toBe(0)
    expect(run(repoOpCommand('mergeFfOnly', { branch: 'victim' })).code).toBe(0)
    expect(run(repoOpCommand('branchDelete', { branch: 'victim' })).code).toBe(0)
    const wt = join(repo, '.worktrees', 'issue-1-x')
    expect(
      run(repoOpCommand('worktreeAdd', { path: wt, branch: 'issue/1-x', startPoint: 'main' })).code,
    ).toBe(0)
    expect(run(repoOpCommand('worktreeRemove', { path: wt })).code).toBe(0)
  })
})
