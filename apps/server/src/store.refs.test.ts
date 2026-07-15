/**
 * Human-facing ids (#474) — store-level behaviour: prefix derivation +
 * collision, transactional letter allocation, per-repo DRAFT counter, and the
 * migration backfill over colliding repo names.
 */
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

function memStore(): SessionStore {
  return new SessionStore(':memory:')
}

describe('repo prefixes', () => {
  it('derives POD for podium and a distinct prefix on a name collision', () => {
    const s = memStore()
    s.repos.addRepo('/a/podium')
    s.repos.addRepo('/b/podium') // same basename, different logical repo
    const prefixes = s.repos.listRepos().map((r) => r.prefix)
    expect(prefixes[0]).toBe('POD')
    expect(prefixes[1]).not.toBe('POD')
    expect(new Set(prefixes).size).toBe(2)
    s.close()
  })

  it('honours a validated explicit override and rejects a bad/duplicate one', () => {
    const s = memStore()
    s.repos.addRepo('/a/podium', '__local__', undefined, 'PDM')
    expect(s.repos.prefixForPath('/a/podium')).toBe('PDM')
    expect(() => s.repos.addRepo('/b/thing', '__local__', undefined, 'lower')).toThrow()
    expect(() => s.repos.addRepo('/c/thing', '__local__', undefined, 'PDM')).toThrow(/already in use/)
    s.close()
  })

  it('resolves a prefix back to its repo', () => {
    const s = memStore()
    s.repos.addRepo('/a/podium')
    const repo = s.repos.repoForPrefix('POD')
    expect(repo?.path).toBe('/a/podium')
    expect(s.repos.repoForPrefix('ZZZ')).toBeNull()
    s.close()
  })

  it('setRepoPrefix renames server-wide and enforces uniqueness', () => {
    const s = memStore()
    s.repos.addRepo('/a/podium')
    s.repos.addRepo('/b/other')
    s.repos.setRepoPrefix('__local__', '/a/podium', 'PODX')
    expect(s.repos.prefixForPath('/a/podium')).toBe('PODX')
    const otherPrefix = s.repos.prefixForPath('/b/other')!
    expect(() => s.repos.setRepoPrefix('__local__', '/a/podium', otherPrefix)).toThrow(
      /already used/,
    )
    s.close()
  })
})

describe('session letter allocation', () => {
  it('allocates A, B, C… and never reuses within an issue', () => {
    const s = memStore()
    const a = s.issues.allocateSessionLetter('iss_1')
    const b = s.issues.allocateSessionLetter('iss_1')
    const c = s.issues.allocateSessionLetter('iss_1')
    expect([a, b, c]).toEqual(['A', 'B', 'C'])
    // A different issue starts its own sequence.
    expect(s.issues.allocateSessionLetter('iss_2')).toBe('A')
    s.close()
  })

  it('crosses Z -> AA', () => {
    const s = memStore()
    let last = ''
    for (let i = 0; i < 27; i++) last = s.issues.allocateSessionLetter('iss_z')
    expect(last).toBe('AA')
    s.close()
  })
})

describe('per-repo DRAFT counter', () => {
  it('increments and never reuses an ordinal', () => {
    const s = memStore()
    expect(s.repos.nextDraftSeq('repo_x')).toBe(1)
    expect(s.repos.nextDraftSeq('repo_x')).toBe(2)
    expect(s.repos.nextDraftSeq('repo_y')).toBe(1)
    s.close()
  })
})

// The "migration backfill" test (colliding repo names → unique prefixes) was
// removed with the legacy migration chain [spec:SP-4428]: it drove the deleted
// human-facing-ids migration's one-time backfill directly. Runtime prefix
// assignment on a fresh database is exercised through the SessionStore-based ref
// tests above.
