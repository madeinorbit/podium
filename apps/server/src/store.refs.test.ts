/**
 * Human-facing ids (#474) — store-level behaviour: prefix derivation +
 * collision, transactional letter allocation, per-repo DRAFT counter, and the
 * migration backfill over colliding repo names.
 */
import { asIssueId, asMachineId, asRepoId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
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
    await s.close()
  })

  it('honours a validated explicit override and rejects a bad/duplicate one', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', asMachineId('__local__'), undefined, 'PDM')
    expect(await s.repos.prefixForPath('/a/podium')).toBe('PDM')
    await expect(s.repos.addRepo('/b/thing', asMachineId('__local__'), undefined, 'lower'),
    ).rejects.toThrow()
    await expect(s.repos.addRepo('/c/thing', asMachineId('__local__'), undefined, 'PDM')).rejects.toThrow(
      /already in use/,
    )
    await s.close()
  })

  it('resolves a prefix back to its repo', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const repo = await s.repos.repoForPrefix('POD')
    expect(repo?.path).toBe('/a/podium')
    expect(await s.repos.repoForPrefix('ZZZ')).toBeNull()
    await s.close()
  })

  it('setRepoPrefix renames server-wide and enforces uniqueness', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    await s.repos.addRepo('/b/other', s.hostMachineId)
    await s.repos.setRepoPrefix(asMachineId('__local__'), '/a/podium', 'PODX')
    expect(await s.repos.prefixForPath('/a/podium')).toBe('PODX')
    const otherPrefix = (await s.repos.prefixForPath('/b/other'))!
    await expect(s.repos.setRepoPrefix(asMachineId('__local__'), '/a/podium', otherPrefix)).rejects.toThrow(
      /already used/,
    )
    await s.close()
  })
})

describe('repo base branches (POD-2065)', () => {
  /** A registry over a fake daemon whose repository has `branches`; `answers:
   *  false` models a machine that cannot be reached. */
  function registry(s: SessionStore, branches: string[], answers = true) {
    const asked: string[] = []
    const reg = {
      modules: {
        machines: { defaultMachine: async () => s.hostMachineId },
        rpc: {
          repoOp: async (_op: string, _cwd: string, args?: Record<string, string>) => {
            asked.push(args?.ref ?? '')
            if (!answers) return { ok: false, output: 'no daemon answered the git request in time' }
            const ref = args?.ref ?? ''
            return ref === 'HEAD' || branches.some((b) => ref === `refs/heads/${b}`)
              ? { ok: true, output: 'deadbeef' }
              : { ok: false, output: 'fatal: Needed a single revision' }
          },
        },
        issues: { reports: { store: { publishRepos: async () => {} } } },
      },
    } as unknown as SessionRegistry
    return { repos: new RepoRegistry(reg, s), asked }
  }

  it('stores a branch the repository has, for every checkout of it, and clears with null', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const { repos, asked } = registry(s, ['main', 'tf.dev'])
    await repos.setDefaultParentBranch('/a/podium', 'tf.dev')
    expect(asked).toEqual(['refs/heads/tf.dev'])
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium')).toBe('tf.dev')
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium/.worktrees/x')).toBe('tf.dev')
    expect((await s.repos.listRepos())[0]?.defaultParentBranch).toBe('tf.dev')
    // The prefix row it shares is untouched.
    expect(await s.repos.prefixForPath('/a/podium')).toBe('POD')
    await repos.setDefaultParentBranch('/a/podium', null)
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium')).toBeNull()
    await s.close()
  })

  it('refuses a branch the repository does not have, and says so', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const { repos } = registry(s, ['main'])
    await expect(repos.setDefaultParentBranch('/a/podium', 'tf.dev')).rejects.toThrow(
      "branch 'tf.dev' does not exist in /a/podium",
    )
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium')).toBeNull()
    await s.close()
  })

  it('refuses revision syntax before asking the repository', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const { repos, asked } = registry(s, ['tf.dev', 'feature/tf.dev'])
    for (const bad of ['tf.dev~1', 'tf.dev^{commit}', '-x', 'a..b', 'x@{1}', 'a b', 'x.lock', 'x/']) {
      await expect(repos.setDefaultParentBranch('/a/podium', bad)).rejects.toThrow(
        `invalid branch name '${bad}'`,
      )
    }
    expect(asked).toEqual([])
    await repos.setDefaultParentBranch('/a/podium', 'feature/tf.dev')
    expect(asked).toEqual(['refs/heads/feature/tf.dev'])
    await s.close()
  })

  it('keeps a base set before the checkout reported its origin', async () => {
    const s = await memStore()
    const a = asMachineId('machine-a')
    const b = asMachineId('machine-b')
    const origin = 'git@example.com:acme/podium.git'
    await s.repos.addRepo('/a/podium', a, origin)
    // B's checkout has no origin yet: a path-derived identity with its own prefix row.
    await s.repos.addRepo('/b/podium', b)
    await s.repos.setRepoDefaultParentBranch(b, '/b/podium', 'tf.dev')
    await s.repos.updateRepoOrigin(b, '/b/podium', origin)
    expect(await s.repos.defaultParentBranchForIssueRepo('/b/podium', b)).toBe('tf.dev')
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium', a)).toBe('tf.dev')
    await s.close()
  })

  it("keeps the origin repository's base when both checkouts had one", async () => {
    const s = await memStore()
    const a = asMachineId('machine-a')
    const b = asMachineId('machine-b')
    const origin = 'git@example.com:acme/podium.git'
    await s.repos.addRepo('/a/podium', a, origin)
    await s.repos.addRepo('/b/podium', b)
    await s.repos.setRepoDefaultParentBranch(a, '/a/podium', 'main')
    await s.repos.setRepoDefaultParentBranch(b, '/b/podium', 'tf.dev')
    await s.repos.updateRepoOrigin(b, '/b/podium', origin)
    expect(await s.repos.defaultParentBranchForIssueRepo('/b/podium', b)).toBe('main')
    await s.close()
  })

  it('does not blame the branch when the repository did not answer', async () => {
    const s = await memStore()
    await s.repos.addRepo('/a/podium', s.hostMachineId)
    const { repos } = registry(s, ['tf.dev'], false)
    await expect(repos.setDefaultParentBranch('/a/podium', 'tf.dev')).rejects.toThrow(
      /could not read the repository at \/a\/podium/,
    )
    expect(await s.repos.defaultParentBranchForIssueRepo('/a/podium')).toBeNull()
    await s.close()
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
    await s.close()
  })

  it('crosses Z -> AA', async () => {
    const s = await memStore()
    let last = ''
    for (let i = 0; i < 27; i++) last = await s.issues.allocateSessionLetter(asIssueId('iss_z'))
    expect(last).toBe('AA')
    await s.close()
  })
})

describe('per-repo DRAFT counter', () => {
  it('increments and never reuses an ordinal', async () => {
    const s = await memStore()
    expect(await s.repos.nextDraftSeq(asRepoId('repo_x'))).toBe(1)
    expect(await s.repos.nextDraftSeq(asRepoId('repo_x'))).toBe(2)
    expect(await s.repos.nextDraftSeq(asRepoId('repo_y'))).toBe(1)
    await s.close()
  })
})

// The "migration backfill" test (colliding repo names → unique prefixes) was
// removed with the legacy migration chain [spec:SP-4428]: it drove the deleted
// human-facing-ids migration's one-time backfill directly. Runtime prefix
// assignment on a fresh database is exercised through the SessionStore-based ref
// tests above.
