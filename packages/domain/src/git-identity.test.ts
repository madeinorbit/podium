import { describe, expect, it } from 'vitest'
import { repoNameFromOrigin } from './git-identity'

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
