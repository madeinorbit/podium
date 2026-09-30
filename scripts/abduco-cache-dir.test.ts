import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { abducoCacheDir, abducoCachePath, REPO_ROOT } from './abduco-cross'

/**
 * The abduco helper cache was correct and never hit (POD-3162): it lived at
 * `<root>/dist-bun/abduco-cache`, and a release packages from a fresh detached
 * worktree in /tmp where that gitignored directory is always created empty. These
 * tests pin the two halves of the fix — the cache is now keyed on the repository,
 * not the checkout, and the source hash still decides what a hit MEANS.
 */
const cleanup: string[] = []
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true })
})

function checkouts(): { common: string; worktrees: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'podium-abduco-key-'))
  cleanup.push(root)
  const common = join(root, 'repo/.git')
  execFileSync('mkdir', ['-p', join(common, 'worktrees')])
  const worktrees = ['checkout-a', 'release-snapshot'].map((name) => {
    const worktree = join(root, name)
    execFileSync('mkdir', ['-p', join(common, 'worktrees', name)])
    execFileSync('mkdir', ['-p', worktree])
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(common, 'worktrees', name)}\n`)
    return worktree
  })
  return { common, worktrees }
}

describe('abducoCacheDir', () => {
  it('gives two checkouts of one repository the same cache, so a /tmp release hits', () => {
    const [checkout, snapshot] = checkouts().worktrees as [string, string]
    expect(abducoCacheDir(snapshot)).toBe(abducoCacheDir(checkout))
  })

  it('lands outside the checkout, which is what a throwaway worktree cannot carry', () => {
    const [checkout] = checkouts().worktrees as [string, string]
    const dir = abducoCacheDir(checkout)
    expect(dir.startsWith(checkout)).toBe(false)
    expect(dirname(dir).endsWith(join('podium', 'abduco'))).toBe(true)
  })

  it('separates unrelated repositories', () => {
    const [first] = checkouts().worktrees as [string, string]
    const [second] = checkouts().worktrees as [string, string]
    expect(abducoCacheDir(first)).not.toBe(abducoCacheDir(second))
  })

  it('honours PODIUM_ABDUCO_CACHE_DIR, which is how CI pins it back into the checkout', () => {
    const previous = process.env.PODIUM_ABDUCO_CACHE_DIR
    try {
      process.env.PODIUM_ABDUCO_CACHE_DIR = '/pinned/abduco'
      expect(abducoCacheDir('/anywhere')).toBe('/pinned/abduco')
      // A relative override resolves against the root, as an actions/cache `path` reads it.
      process.env.PODIUM_ABDUCO_CACHE_DIR = 'dist-bun/abduco-cache'
      expect(abducoCacheDir('/repo')).toBe('/repo/dist-bun/abduco-cache')
    } finally {
      if (previous === undefined) delete process.env.PODIUM_ABDUCO_CACHE_DIR
      else process.env.PODIUM_ABDUCO_CACHE_DIR = previous
    }
  })

  it('still names entries by platform and source hash, so relocating widened nothing', () => {
    const [checkout, snapshot] = checkouts().worktrees as [string, string]
    const hash = 'a'.repeat(64)
    // Same source, different checkout: the same entry, which is the cache hit.
    expect(abducoCachePath('darwin-aarch64', hash, snapshot)).toBe(
      abducoCachePath('darwin-aarch64', hash, checkout),
    )
    // A touched abduco.c moves every platform's entry.
    for (const platform of ['linux-x86_64', 'darwin-aarch64'] as const) {
      const before = abducoCachePath(platform, hash, checkout)
      const after = abducoCachePath(platform, 'b'.repeat(64), checkout)
      expect(after).not.toBe(before)
      expect(basename(before).startsWith(`${platform}-`)).toBe(true)
    }
  })

  it('prints the resolved directory for the shell callers that must not re-derive it', () => {
    const printed = execFileSync('bun', ['scripts/abduco-cross.ts', '--print-cache-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
    expect(printed).toBe(abducoCacheDir())
  })
})
