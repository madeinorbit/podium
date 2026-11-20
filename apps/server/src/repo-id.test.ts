import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { canonicalizeRepoOrigin, deriveRepoId, isPathFallbackRepoId } from './repo-id'

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
    expect(canonicalizeRepoOrigin('ssh://git@git.example.com:22/o/r.git')).toBe(
      'git.example.com/o/r',
    )
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
      machineId: asMachineId('m1'),
      path: '/home/a/r',
    })
    const b = deriveRepoId({
      originUrl: 'https://github.com/o/r',
      machineId: asMachineId('m2'),
      path: '/srv/checkouts/r',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^repo_[0-9a-f]{16}$/)
  })

  it('falls back to deterministic (machineId, path) hash without an origin', () => {
    const a = deriveRepoId({ machineId: asMachineId('m1'), path: '/x' })
    expect(a).toBe(
      deriveRepoId({ originUrl: 'not a url at all ???', machineId: asMachineId('m1'), path: '/x' }),
    )
    expect(a).toMatch(/^repo_[0-9a-f]{16}$/)
    expect(a).not.toBe(deriveRepoId({ machineId: asMachineId('m2'), path: '/x' }))
    expect(a).not.toBe(deriveRepoId({ machineId: asMachineId('m1'), path: '/y' }))
  })

  it('isPathFallbackRepoId distinguishes fallback from origin-derived ids', () => {
    const fallback = deriveRepoId({ machineId: asMachineId('m1'), path: '/x' })
    const originId = deriveRepoId({
      originUrl: 'git@h.com:o/r',
      machineId: asMachineId('m1'),
      path: '/x',
    })
    expect(isPathFallbackRepoId(fallback, asMachineId('m1'), '/x')).toBe(true)
    expect(isPathFallbackRepoId(null, asMachineId('m1'), '/x')).toBe(true)
    expect(isPathFallbackRepoId(originId, asMachineId('m1'), '/x')).toBe(false)
  })
})

it('machine paths: Windows spelling variants have one path-fallback repo identity', () => {
  const machineId = asMachineId('windows')
  const repo = deriveRepoId({ machineId, path: 'C:\\src\\podium' })
  for (const path of ['c:/src/podium/', 'C:\\src\\podium\\', 'c:\\src\\podium'])
    expect(deriveRepoId({ machineId, path })).toBe(repo)
  expect(deriveRepoId({ machineId, path: '/src/podium' })).not.toBe(repo)
  expect(deriveRepoId({ machineId, path: '/src/Podium' })).not.toBe(
    deriveRepoId({ machineId, path: '/src/podium' }),
  )
})
