import { describe, expect, it } from 'vitest'
import { normalizeOriginUrl, repoNameFromOrigin } from './git-identity'

// Folded in from packages/runtime/src/git.test.ts when POD-299 deleted that
// re-export shim: these cases only ever exercised the model's implementation
// through it, so they belong at the canonical home.
describe('normalizeOriginUrl', () => {
  it('matches scp-style and https forms of the same repo', () => {
    const a = normalizeOriginUrl('git@github.com:me/proj.git')
    const b = normalizeOriginUrl('https://github.com/me/proj')
    expect(a).toBe('github.com/me/proj')
    expect(a).toBe(b)
  })
  it('lowercases host but not path, strips .git and trailing slash', () => {
    expect(normalizeOriginUrl('https://GitHub.com/Me/Proj.git/')).toBe('github.com/Me/Proj')
  })
  it('handles ssh:// and a port', () => {
    expect(normalizeOriginUrl('ssh://git@github.com:22/me/proj.git')).toBe('github.com/me/proj')
  })
  it('returns empty string for missing/garbage input', () => {
    expect(normalizeOriginUrl(undefined)).toBe('')
    expect(normalizeOriginUrl('')).toBe('')
    expect(normalizeOriginUrl('not a url')).toBe('not a url')
  })
})

describe('repoNameFromOrigin', () => {
  it('names the repo, not the folder it happens to sit in', () => {
    // The case this exists for: a backup clone whose directory is bak_podium.
    expect(repoNameFromOrigin('https://github.com/lumenfall/podium.git')).toBe('podium')
  })

  it('reads every spelling of the same remote identically', () => {
    for (const url of [
      'https://github.com/lumenfall/podium.git',
      'https://github.com/lumenfall/podium',
      'http://github.com/lumenfall/podium.git',
      'ssh://git@github.com/lumenfall/podium.git',
      'ssh://git@github.com:22/lumenfall/podium.git',
      'git@github.com:lumenfall/podium.git',
      'https://user:token@github.com/lumenfall/podium.git',
      'https://github.com/lumenfall/podium/',
    ])
      expect(repoNameFromOrigin(url)).toBe('podium')
  })

  it('takes the last segment of a nested path (self-hosted groups)', () => {
    expect(repoNameFromOrigin('https://gitlab.example.com/team/sub/group/podium.git')).toBe(
      'podium',
    )
  })

  it('handles a local/filesystem origin', () => {
    expect(repoNameFromOrigin('/srv/git/podium.git')).toBe('podium')
  })

  it('returns null when the origin names no repo — the caller falls back to the folder', () => {
    expect(repoNameFromOrigin(undefined)).toBeNull()
    expect(repoNameFromOrigin('')).toBeNull()
    expect(repoNameFromOrigin('   ')).toBeNull()
    // A bare host has no repo segment; "podium" alone is not a URL we can trust.
    expect(repoNameFromOrigin('https://github.com')).toBeNull()
    expect(repoNameFromOrigin('https://github.com/')).toBeNull()
    expect(repoNameFromOrigin('nonsense')).toBeNull()
  })
})
