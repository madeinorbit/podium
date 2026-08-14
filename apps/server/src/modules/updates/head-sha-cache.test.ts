import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGitHeadShaCache,
  createHeadShaCache,
  locateGitRefs,
  readHeadStamp,
} from './head-sha-cache'

const execFileAsync = promisify(execFile)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'head-sha-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('locating the ref store', () => {
  it('reads an ordinary checkout, where HEAD and refs share a directory', async () => {
    await mkdir(join(dir, '.git'), { recursive: true })
    expect(await locateGitRefs(dir)).toEqual({
      gitDir: join(dir, '.git'),
      commonDir: join(dir, '.git'),
    })
  })

  it('follows a linked worktree to its own HEAD and the SHARED refs', async () => {
    // The shape every issue branch on this host runs from: `.git` is a file,
    // HEAD is private to the worktree, and `refs/` belongs to the main repo.
    const repo = join(dir, 'repo')
    const linked = join(repo, '.git', 'worktrees', 'issue-1')
    const tree = join(dir, 'tree')
    await mkdir(linked, { recursive: true })
    await mkdir(tree, { recursive: true })
    await writeFile(join(linked, 'commondir'), '../..\n')
    await writeFile(join(tree, '.git'), `gitdir: ${linked}\n`)

    expect(await locateGitRefs(tree)).toEqual({
      gitDir: linked,
      commonDir: join(repo, '.git'),
    })
  })

  it('gives up on a root that is not a checkout', async () => {
    expect(await locateGitRefs(dir)).toBeNull()
  })

  it('gives up on a `.git` file that points nowhere it understands', async () => {
    await writeFile(join(dir, '.git'), 'something else entirely\n')
    expect(await locateGitRefs(dir)).toBeNull()
  })
})

describe('the HEAD stamp', () => {
  async function checkout(head: string): Promise<{ gitDir: string; commonDir: string }> {
    const gitDir = join(dir, '.git')
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), head)
    return { gitDir, commonDir: gitDir }
  }

  it('is the commit itself when HEAD is detached', async () => {
    const where = await checkout('9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c\n')
    expect(await readHeadStamp(where)).toContain('9f1c2d3e')
  })

  it('changes when the branch tip moves, even rewritten in the same clock tick', async () => {
    // The case that must not depend on timing. A ref file is always the same
    // length, and the kernel's mtime comes off a coarse clock, so two writes
    // this close together are indistinguishable by stat — an earlier draft
    // stamped these by stat and this test passed or failed on whether the two
    // writes happened to straddle a tick.
    const where = await checkout('ref: refs/heads/main\n')
    const tip = join(where.commonDir, 'refs', 'heads', 'main')
    await writeFile(tip, `${'a'.repeat(40)}\n`)
    const before = await readHeadStamp(where)
    await writeFile(tip, `${'b'.repeat(40)}\n`)

    expect(await readHeadStamp(where)).not.toBe(before)
  })

  it('changes when the tip is packed away, though the branch has not moved', async () => {
    const where = await checkout('ref: refs/heads/main\n')
    await writeFile(join(where.commonDir, 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
    const before = await readHeadStamp(where)

    await writeFile(join(where.commonDir, 'packed-refs'), `${'a'.repeat(40)} refs/heads/main\n`)
    expect(await readHeadStamp(where)).not.toBe(before)
  })

  it('changes when HEAD moves to another branch', async () => {
    const where = await checkout('ref: refs/heads/main\n')
    const before = await readHeadStamp(where)
    await writeFile(join(where.gitDir, 'HEAD'), 'ref: refs/heads/other\n')
    expect(await readHeadStamp(where)).not.toBe(before)
  })

  it('holds still when nothing has happened', async () => {
    const where = await checkout('ref: refs/heads/main\n')
    await writeFile(join(where.commonDir, 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
    expect(await readHeadStamp(where)).toBe(await readHeadStamp(where))
  })

  it('refuses a HEAD it does not understand rather than guessing', async () => {
    expect(await readHeadStamp(await checkout('ref: ../../elsewhere\n'))).toBeNull()
    expect(await readHeadStamp(await checkout(''))).toBeNull()
    expect(await readHeadStamp({ gitDir: join(dir, 'absent'), commonDir: dir })).toBeNull()
  })
})

describe('the cache', () => {
  function fixture(options: { stamp?: () => string | null; ttlMs?: number } = {}) {
    let sha = 'aaaaaaa'
    let stamp: string | null = 'stamp-1'
    let clock = 0
    const calls: string[] = []
    const cache = createHeadShaCache({
      read: async () => {
        calls.push('read')
        return sha
      },
      stamp: async () => {
        calls.push('stamp')
        return options.stamp ? options.stamp() : stamp
      },
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      now: () => clock,
    })
    return {
      cache,
      calls,
      reads: () => calls.filter((c) => c === 'read').length,
      commit: (next: string, nextStamp: string) => {
        sha = next
        stamp = nextStamp
      },
      tick: (ms: number) => {
        clock += ms
      },
    }
  }

  it('asks git once, then answers from the stamp', async () => {
    const f = fixture()
    for (let i = 0; i < 10; i++) expect(await f.cache.read()).toBe('aaaaaaa')
    expect(f.reads()).toBe(1)
  })

  it('notices a commit', async () => {
    const f = fixture()
    expect(await f.cache.read()).toBe('aaaaaaa')
    f.commit('bbbbbbb', 'stamp-2')
    expect(await f.cache.read()).toBe('bbbbbbb')
    expect(f.reads()).toBe(2)
  })

  it('takes the stamp BEFORE the read, so a move cannot be cached as settled', async () => {
    // The other order pairs a pre-commit sha with a post-commit stamp, and that
    // pair never looks stale again.
    const f = fixture()
    await f.cache.read()
    expect(f.calls).toEqual(['stamp', 'read'])
  })

  it('asks git again once the ceiling passes, unchanged stamp or not', async () => {
    const f = fixture({ ttlMs: 30_000 })
    await f.cache.read()
    f.tick(29_999)
    await f.cache.read()
    expect(f.reads()).toBe(1)
    f.tick(2)
    await f.cache.read()
    expect(f.reads()).toBe(2)
  })

  it('does not restart the ceiling on a hit — or there would be no ceiling', async () => {
    const f = fixture({ ttlMs: 10_000 })
    await f.cache.read()
    for (let i = 0; i < 5; i++) {
      f.tick(2_000)
      await f.cache.read()
    }
    expect(f.reads()).toBe(2)
  })

  it('never caches against a stamp it could not take', async () => {
    // The fallback that makes every unrecognised checkout behave exactly as it
    // did before this cache existed.
    const f = fixture({ stamp: () => null })
    for (let i = 0; i < 5; i++) await f.cache.read()
    expect(f.reads()).toBe(5)
  })

  it('re-reads after invalidate, so a human never gets a cached answer', async () => {
    const f = fixture()
    await f.cache.read()
    f.cache.invalidate()
    await f.cache.read()
    expect(f.reads()).toBe(2)
  })

  it('coalesces readers that arrive together into one git call', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    const cache = createHeadShaCache({
      read: async () => {
        reads++
        await gate
        return 'aaaaaaa'
      },
      stamp: async () => 'stamp-1',
    })
    const all = Promise.all([cache.read(), cache.read(), cache.read()])
    release()
    expect(await all).toEqual(['aaaaaaa', 'aaaaaaa', 'aaaaaaa'])
    expect(reads).toBe(1)
  })

  it('does not cache a failed read', async () => {
    let fail = true
    let reads = 0
    const cache = createHeadShaCache({
      read: async () => {
        reads++
        if (fail) throw new Error('git exploded')
        return 'aaaaaaa'
      },
      stamp: async () => 'stamp-1',
    })
    await expect(cache.read()).rejects.toThrow('git exploded')
    fail = false
    expect(await cache.read()).toBe('aaaaaaa')
    expect(reads).toBe(2)
  })
})

/**
 * The layout tests above are built by hand, so they prove this module is
 * self-consistent — not that it reads what GIT actually writes. These drive a
 * real repository, which is the only thing that catches a wrong belief about
 * where a ref lives.
 */
describe('against a real repository', () => {
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Probe',
        GIT_AUTHOR_EMAIL: 'probe@example.invalid',
        GIT_COMMITTER_NAME: 'Probe',
        GIT_COMMITTER_EMAIL: 'probe@example.invalid',
      },
    })
    return stdout.trim()
  }

  async function repo(): Promise<string> {
    const root = join(dir, 'repo')
    await mkdir(root, { recursive: true })
    await git(root, 'init', '--initial-branch=main', '--quiet')
    await writeFile(join(root, 'a.txt'), 'one\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '--quiet', '-m', 'one')
    return root
  }

  const headOf = (root: string) => () => git(root, 'rev-parse', '--short=7', 'HEAD')

  it('serves the sha without git, and notices a commit when one lands', async () => {
    const root = await repo()
    let reads = 0
    const cache = createGitHeadShaCache(root, async () => {
      reads++
      return headOf(root)()
    })

    const first = await cache.read()
    expect(first).toBe(await headOf(root)())
    for (let i = 0; i < 5; i++) expect(await cache.read()).toBe(first)
    expect(reads).toBe(1)

    await writeFile(join(root, 'a.txt'), 'two\n')
    await git(root, 'commit', '--quiet', '-am', 'two')

    const second = await cache.read()
    expect(second).not.toBe(first)
    expect(second).toBe(await headOf(root)())
    expect(reads).toBe(2)
  })

  it('notices `git gc` packing the tip away, and still answers correctly', async () => {
    // The branch has not moved, so the sha is unchanged — but the loose ref is
    // gone, and a stamp that only watched that file would now be reading an
    // absent path forever.
    const root = await repo()
    const cache = createGitHeadShaCache(root, headOf(root))
    const before = await cache.read()

    await git(root, 'pack-refs', '--all')
    expect(await cache.read()).toBe(before)

    await writeFile(join(root, 'a.txt'), 'three\n')
    await git(root, 'commit', '--quiet', '-am', 'three')
    expect(await cache.read()).toBe(await headOf(root)())
  })

  it('follows a real linked worktree, which is how this server usually runs', async () => {
    const root = await repo()
    const tree = join(dir, 'linked')
    await git(root, 'worktree', 'add', '--quiet', '-b', 'side', tree)

    let reads = 0
    const cache = createGitHeadShaCache(tree, async () => {
      reads++
      return git(tree, 'rev-parse', '--short=7', 'HEAD')
    })

    const first = await cache.read()
    expect(first).toBe(await git(tree, 'rev-parse', '--short=7', 'HEAD'))
    await cache.read()
    expect(reads).toBe(1)

    // A commit in the WORKTREE moves a ref in the SHARED store. Stamping only
    // the worktree's own git dir would miss this entirely.
    await writeFile(join(tree, 'a.txt'), 'side\n')
    await git(tree, 'commit', '--quiet', '-am', 'side')

    expect(await cache.read()).toBe(await git(tree, 'rev-parse', '--short=7', 'HEAD'))
    expect(reads).toBe(2)
  })

  it('notices a checkout to another branch', async () => {
    const root = await repo()
    await git(root, 'branch', 'other')
    const cache = createGitHeadShaCache(root, headOf(root))
    await cache.read()

    await writeFile(join(root, 'a.txt'), 'main moves on\n')
    await git(root, 'commit', '--quiet', '-am', 'main')
    const onMain = await cache.read()

    await git(root, 'checkout', '--quiet', 'other')
    const onOther = await cache.read()
    expect(onOther).not.toBe(onMain)
    expect(onOther).toBe(await headOf(root)())
  })
})
