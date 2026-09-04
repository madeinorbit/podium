/**
 * Human-facing ids (#474) — store-level behaviour: prefix derivation +
 * collision, transactional letter allocation, per-repo DRAFT counter, and the
 * migration backfill over colliding repo names.
 */
import { asIssueId, asMachineId, asRepoId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

async function memStore(): Promise<SessionStore> {
  return await openTestStore(':memory:')
}

describe('repo prefixes', () => {
  it('derives POD for podium and a distinct prefix on a name collision', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    await s.repos.addRepo('/b/podium', s.hostMachineId) // same basename, different logical repo
    const prefixes = (await s.repos.listRepos()).map((r) => r.prefix)
    expect(prefixes[0]).toBe('POD')
    expect(prefixes[1]).not.toBe('POD')
    expect(new Set(prefixes).size).toBe(2)
    s.close()
  })

  it('honours a validated explicit override and rejects a bad/duplicate one', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', asMachineId('__local__'), undefined, 'PDM')
    expect(await s.repos.prefixForPath('/a/podium')).toBe('PDM')
    expect(() =>
      s.repos.addRepo('/b/thing', asMachineId('__local__'), undefined, 'lower'),
    ).toThrow()
    expect(() => s.repos.addRepo('/c/thing', asMachineId('__local__'), undefined, 'PDM')).toThrow(
      /already in use/,
    )
    s.close()
  })

  it('resolves a prefix back to its repo', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const repo = await s.repos.repoForPrefix('POD')
    expect(repo?.path).toBe('/a/podium')
    expect(await s.repos.repoForPrefix('ZZZ')).toBeNull()
    s.close()
  })

  it('setRepoPrefix renames server-wide and enforces uniqueness', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    await s.repos.addRepo('/b/other', s.hostMachineId)
    await s.repos.setRepoPrefix(asMachineId('__local__'), '/a/podium', 'PODX')
    expect(await s.repos.prefixForPath('/a/podium')).toBe('PODX')
    const otherPrefix = (await s.repos.prefixForPath('/b/other'))!
    expect(() => s.repos.setRepoPrefix(asMachineId('__local__'), '/a/podium', otherPrefix)).toThrow(
      /already used/,
    )
    s.close()
  })
})

describe('session letter allocation', () => {
  it('allocates A, B, C… and never reuses within an issue', async () => {
    const s = await memStore()
    const a = await s.issues.allocateSessionLetter(asIssueId('iss_1'))
    const b = await s.issues.allocateSessionLetter(asIssueId('iss_1'))
    const c = await s.issues.allocateSessionLetter(asIssueId('iss_1'))
    expect([a, b, c]).toEqual(['A', 'B', 'C'])
    // A different issue starts its own sequence.
    expect(await s.issues.allocateSessionLetter(asIssueId('iss_2'))).toBe('A')
    s.close()
  })

  it('crosses Z -> AA', async () => {
    const s = await memStore()
    let last = ''
    for (let i = 0; i < 27; i++) last = await s.issues.allocateSessionLetter(asIssueId('iss_z'))
    expect(last).toBe('AA')
    s.close()
  })
})

describe('per-repo DRAFT counter', () => {
  it('increments and never reuses an ordinal', async () => {
    const s = await memStore()
    expect(await s.repos.nextDraftSeq(asRepoId('repo_x'))).toBe(1)
    expect(await s.repos.nextDraftSeq(asRepoId('repo_x'))).toBe(2)
    expect(await s.repos.nextDraftSeq(asRepoId('repo_y'))).toBe(1)
    s.close()
  })
})

// The "migration backfill" test (colliding repo names → unique prefixes) was
// removed with the legacy migration chain [spec:SP-4428]: it drove the deleted
// human-facing-ids migration's one-time backfill directly. Runtime prefix
// assignment on a fresh database is exercised through the SessionStore-based ref
// tests above.
