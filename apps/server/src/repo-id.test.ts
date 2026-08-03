import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveRepoId,
  isPathFallbackRepoId,
  canonicalizeRepoOrigin,
  readLocalOriginUrl,
} from './repo-id'

describe('canonicalizeRepoOrigin', () => {
  it('normalizes ssh scp-style, ssh:// and https:// spellings identically', () => {
    const expected = 'github.com/owner/repo'
    expect(canonicalizeRepoOrigin('git@github.com:owner/repo.git')).toBe(expected)
    expect(canonicalizeRepoOrigin('ssh://git@github.com/owner/repo.git')).toBe(expected)
    expect(canonicalizeRepoOrigin('https://github.com/owner/repo.git')).toBe(expected)
    expect(canonicalizeRepoOrigin('https://github.com/owner/repo')).toBe(expected)
    expect(canonicalizeRepoOrigin('https://user:pass@github.com/owner/repo.git/')).toBe(expected)
  })

  it('lowercases host, keeps only non-default ports', () => {
    expect(canonicalizeRepoOrigin('https://GitHub.COM/Owner/Repo')).toBe('github.com/Owner/Repo')
    expect(canonicalizeRepoOrigin('https://git.example.com:443/o/r')).toBe('git.example.com/o/r')
    expect(canonicalizeRepoOrigin('ssh://git@git.example.com:22/o/r.git')).toBe('git.example.com/o/r')
    expect(canonicalizeRepoOrigin('ssh://git@git.example.com:2222/o/r.git')).toBe(
      'git.example.com:2222/o/r',
    )
    expect(canonicalizeRepoOrigin('http://example.com:8080/o/r')).toBe('example.com:8080/o/r')
  })

  it('returns null for empty/unparseable input', () => {
    expect(canonicalizeRepoOrigin('')).toBeNull()
    expect(canonicalizeRepoOrigin('   ')).toBeNull()
    expect(canonicalizeRepoOrigin(null)).toBeNull()
    expect(canonicalizeRepoOrigin(undefined)).toBeNull()
    expect(canonicalizeRepoOrigin('/just/a/path')).toBeNull()
    expect(canonicalizeRepoOrigin('https://hostonly.example.com')).toBeNull()
  })
})

describe('deriveRepoId', () => {
  it('same origin in different spellings and paths → same id', () => {
    const a = deriveRepoId({
      originUrl: 'git@github.com:o/r.git',
      machineId: 'm1',
      path: '/home/a/r',
    })
    const b = deriveRepoId({
      originUrl: 'https://github.com/o/r',
      machineId: 'm2',
      path: '/srv/checkouts/r',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^repo_[0-9a-f]{16}$/)
  })

  it('falls back to deterministic (machineId, path) hash without an origin', () => {
    const a = deriveRepoId({ machineId: 'm1', path: '/x' })
    expect(a).toBe(deriveRepoId({ originUrl: 'not a url at all ???', machineId: 'm1', path: '/x' }))
    expect(a).toMatch(/^repo_[0-9a-f]{16}$/)
    expect(a).not.toBe(deriveRepoId({ machineId: 'm2', path: '/x' }))
    expect(a).not.toBe(deriveRepoId({ machineId: 'm1', path: '/y' }))
  })

  it('isPathFallbackRepoId distinguishes fallback from origin-derived ids', () => {
    const fallback = deriveRepoId({ machineId: 'm1', path: '/x' })
    const originId = deriveRepoId({ originUrl: 'git@h.com:o/r', machineId: 'm1', path: '/x' })
    expect(isPathFallbackRepoId(fallback, 'm1', '/x')).toBe(true)
    expect(isPathFallbackRepoId(null, 'm1', '/x')).toBe(true)
    expect(isPathFallbackRepoId(originId, 'm1', '/x')).toBe(false)
  })
})

describe('readLocalOriginUrl', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads origin url from a plain .git dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'repoid-'))
    mkdirSync(join(dir, '.git'))
    writeFileSync(
      join(dir, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:o/r.git\n',
    )
    expect(readLocalOriginUrl(dir)).toBe('git@github.com:o/r.git')
  })

  it('follows gitdir + commondir indirection (worktrees)', () => {
    dir = mkdtempSync(join(tmpdir(), 'repoid-'))
    const main = join(dir, 'main')
    const wt = join(dir, 'wt')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    mkdirSync(wt)
    writeFileSync(
      join(main, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    )
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    expect(readLocalOriginUrl(wt)).toBe('https://github.com/o/r.git')
  })

  it('returns null for nonexistent paths and repos without an origin', () => {
    expect(readLocalOriginUrl('/definitely/not/a/real/path')).toBeNull()
    dir = mkdtempSync(join(tmpdir(), 'repoid-'))
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tbare = false\n')
    expect(readLocalOriginUrl(dir)).toBeNull()
  })
})
