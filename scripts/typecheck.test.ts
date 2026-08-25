import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessWorkspaceLinks,
  decideForce,
  fingerprint,
  sharedTurboCacheDir,
} from './typecheck'

/** A checkout with a real `.git` DIRECTORY, plus a linked worktree of it whose
 *  `.git` is the FILE git actually writes: `gitdir: <common>/worktrees/<name>`.
 *  That gitfile is the only thing tying the two together, and resolving it is
 *  exactly what the cache location depends on. */
function repoWithWorktree(): { main: string; linked: string; gitDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'podium-cachedir-'))
  const main = join(base, 'repo')
  const gitDir = join(main, '.git')
  mkdirSync(join(gitDir, 'worktrees', 'feature'), { recursive: true })
  const linked = join(base, 'wt-feature')
  mkdirSync(linked, { recursive: true })
  writeFileSync(join(linked, '.git'), `gitdir: ${join(gitDir, 'worktrees', 'feature')}\n`)
  return { main, linked, gitDir }
}

describe('sharedTurboCacheDir', () => {
  const saved = process.env.XDG_CACHE_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = saved
  })

  it('gives a linked worktree the SAME cache as its main checkout', () => {
    delete process.env.XDG_CACHE_HOME
    const { main, linked } = repoWithWorktree()
    expect(sharedTurboCacheDir(linked)).toBe(sharedTurboCacheDir(main))
  })

  it('defaults INSIDE the repository, and ignores the temp dir entirely', () => {
    // The regression this pins: the default used to be tmpdir(), so a host that
    // clears /tmp at boot deleted the whole cache with the machine. Every session
    // afterwards repaid the uncached cost and read it as "a fresh worktree is a
    // cold start".
    //
    // "Not under tmpdir()" would be a VACUOUS assertion here — the fixture repo is
    // itself created in tmpdir, so it passes for the wrong reason. The property
    // that actually distinguishes the two implementations is that the location is
    // a function of the REPOSITORY and not of the environment: move TMPDIR and the
    // answer must not move with it. Under the old code it did.
    delete process.env.XDG_CACHE_HOME
    const { main, gitDir } = repoWithWorktree()
    const before = sharedTurboCacheDir(main)
    expect(before.startsWith(resolve(gitDir))).toBe(true)

    const savedTmp = process.env.TMPDIR
    try {
      process.env.TMPDIR = join(mkdtempSync(join(tmpdir(), 'podium-elsewhere-')), 'moved')
      expect(sharedTurboCacheDir(main)).toBe(before)
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmp
    }
  })

  it('honours an ABSOLUTE XDG_CACHE_HOME and ignores a relative one', () => {
    const { main, linked, gitDir } = repoWithWorktree()
    process.env.XDG_CACHE_HOME = '/xdg-cache'
    expect(sharedTurboCacheDir(main).startsWith('/xdg-cache/podium/turbo/')).toBe(true)
    // Still one cache for the whole repo, not one per checkout.
    expect(sharedTurboCacheDir(linked)).toBe(sharedTurboCacheDir(main))
    // A relative value would resolve against each worktree's own cwd, silently
    // splitting the cache per checkout, so it is treated as unset.
    process.env.XDG_CACHE_HOME = 'relative/cache'
    expect(sharedTurboCacheDir(main).startsWith(resolve(gitDir))).toBe(true)
  })
})

describe('decideForce', () => {
  it('plain run forwards args untouched and stays cached', () => {
    const d = decideForce(['--concurrency=4', '--filter=@podium/web'], {})
    expect(d.error).toBeNull()
    expect(d.forceRequested).toBe(false)
    expect(d.forwardArgs).toEqual(['--concurrency=4', '--filter=@podium/web'])
  })

  it('refuses --force without a reason', () => {
    const d = decideForce(['--force'], {})
    expect(d.error).toContain('--uncached-because')
    expect(d.forwardArgs).not.toContain('--force')
  })

  it('refuses TURBO_FORCE env without a reason', () => {
    expect(decideForce([], { TURBO_FORCE: '1' }).error).toContain('--uncached-because')
    expect(decideForce([], { TURBO_FORCE: 'false' }).error).toBeNull()
  })

  it('refuses write-only --cache spellings without a reason', () => {
    expect(decideForce(['--cache=local:w,remote:w'], {}).error).toContain('--uncached-because')
    expect(decideForce(['--cache=local:rw'], {}).error).toBeNull()
  })

  it('a stated reason unlocks --force and strips the reason flag', () => {
    for (const args of [
      ['--force', '--uncached-because=suspect stale artifact'],
      ['--uncached-because', 'suspect stale artifact'],
    ]) {
      const d = decideForce(args, {})
      expect(d.error).toBeNull()
      expect(d.reason).toBe('suspect stale artifact')
      expect(d.forwardArgs).toEqual(['--force'])
    }
  })

  it('refuses an empty reason', () => {
    expect(decideForce(['--uncached-because='], {}).error).toContain('empty')
  })
})

describe('fingerprint', () => {
  const base = {
    bunfig: 'linker = "hoisted"\n',
    links: ['cli:packages/cli', 'model:packages/model'],
    runtime: { bun: '1.3.14', platform: 'linux', arch: 'x64' },
  }

  it('moves when bunfig.toml changes (the POD-1343 linker blind spot)', () => {
    expect(fingerprint({ ...base, bunfig: 'linker = "isolated"\n' })).not.toBe(fingerprint(base))
  })

  it('moves when a workspace link dangles or disappears', () => {
    expect(fingerprint({ ...base, links: ['cli:packages/cli', 'model!DANGLING'] })).not.toBe(
      fingerprint(base),
    )
    expect(fingerprint({ ...base, links: ['cli:packages/cli'] })).not.toBe(fingerprint(base))
  })

  it('moves when runtime identity changes', () => {
    expect(fingerprint({ ...base, runtime: { ...base.runtime, bun: '1.3.15' } })).not.toBe(
      fingerprint(base),
    )
    expect(fingerprint({ ...base, runtime: { ...base.runtime, arch: 'arm64' } })).not.toBe(
      fingerprint(base),
    )
  })

  it('moves when a workspace link points outside the checkout', () => {
    expect(fingerprint({ ...base, links: ['cli:packages/cli', 'model!EXTERNAL'] })).not.toBe(
      fingerprint(base),
    )
  })

  it('is stable for identical environments', () => {
    expect(fingerprint({ ...base })).toBe(fingerprint(base))
  })
})

describe('assessWorkspaceLinks', () => {
  it('allows stale links for deleted workspaces when healthy links remain', () => {
    expect(
      assessWorkspaceLinks(['model:packages/model', 'domain!DANGLING', 'agent-bridge!DANGLING']),
    ).toEqual({
      healthy: ['model:packages/model'],
      dangling: ['domain!DANGLING', 'agent-bridge!DANGLING'],
      external: [],
      error: null,
    })
  })

  it('refuses an uninstalled checkout and external workspace targets', () => {
    expect(assessWorkspaceLinks(['domain!DANGLING']).error).toContain('no usable')
    expect(assessWorkspaceLinks(['model:packages/model', 'runtime!EXTERNAL']).error).toContain(
      'outside this checkout',
    )
  })
})
