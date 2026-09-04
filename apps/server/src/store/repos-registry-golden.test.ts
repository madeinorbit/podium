/**
 * GOLDEN TESTS FOR THE REGISTRY CACHE DROP AND THE BATCH RESOLVER [POD-3395].
 *
 * Both `invalidateRegistry` and `repoIdResolver` are measured by the coverage
 * census (POD-3244) as INDIRECTLY GUARDED ONLY: every lane executes them, no
 * test names either. That is the most dangerous class in the census, because a
 * conversion that breaks one turns some OTHER file red with a message about
 * something else, and the wave brief names these two specifically.
 *
 * `invalidateRegistry` is the meeting point of the two invalidation halves
 * (POD-3247, POD-3362): this class calls it before its own writes, and the
 * store's per-table announcement calls it for writes this class never sees.
 * `store/repos-read-cost.test.ts` drives the announcement route and the
 * per-method ordering guard reads the file's source. Neither calls the method
 * itself, so nothing pins what the method DOES.
 *
 * `repoIdResolver` is the batch form of `resolveRepoIdForPath` and the file says
 * the ordering IS the resolution rule. It is pinned here directly rather than
 * through the one-path form, because the one-path form delegates to this one —
 * so a test of the delegate proves nothing about a conversion that reimplements
 * the roots list.
 *
 * These assert against a real migrated database and, where the claim is about
 * how many times a statement runs, against the executor's statement probe —
 * a counted read is the mechanism, and the returned rows are the same either way
 * (spec section 6 rule 14).
 */

import { asMachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveRepoId } from '../repo-id'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor, probeLegacyStatements } from './executor'
import { ReposRepository } from './repos'
import { TableWrites } from './table-writes'

const HOST = asMachineId('machine-host')

let rawDb: SqlDatabase
let repos: ReposRepository
let counts: Map<string, number>

/** Executions of the registry's own `repos` read. */
const registryReads = (): number =>
  [...counts].reduce(
    (n, [sql, c]) => (sql.startsWith('SELECT') && sql.includes('FROM repos') ? n + c : n),
    0,
  )

beforeEach(() => {
  rawDb = openMigratedTestDatabase()
  counts = new Map()
  probeLegacyStatements({ db: rawDb }, (observation) => {
    counts.set(observation.sql, (counts.get(observation.sql) ?? 0) + 1)
  })
  repos = new ReposRepository(
    createBunStoreExecutor({ database: rawDb }),
    () => {},
    HOST,
    new TableWrites(),
  )
})

describe('ReposRepository.invalidateRegistry', () => {
  it('makes the next read go back to the database', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    repos.listRepos()
    counts.clear()

    // The held read answers with no statement at all — the paired half, without
    // which the assertion after the drop is satisfied by a repository that never
    // caches.
    repos.listRepos()
    expect(registryReads()).toBe(0)

    repos.invalidateRegistry()
    repos.listRepos()
    expect(registryReads()).toBe(1)
  })

  it('is what lets a read see a write this repository never issued', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    expect(repos.listRepos().map((r) => r.path)).toEqual(['/home/u/alpha'])

    // A writer that goes straight to the connection: the shape every statement
    // the query layer runs through the executor has, from this class's point of
    // view. The read is STALE until something drops it, and saying so is the
    // point — the seam is cooperative, not a guarantee (POD-3362).
    rawDb
      .prepare(
        'INSERT INTO repos (machine_id, path, origin_url, repo_name, repo_id, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('machine-host', '/home/u/beta', null, 'beta', 'repo_beta', '2026-01-01T00:00:00.000Z')

    expect(repos.listRepos().map((r) => r.path)).toEqual(['/home/u/alpha'])

    repos.invalidateRegistry()

    expect(repos.listRepos().map((r) => r.path)).toEqual(['/home/u/alpha', '/home/u/beta'])
  })

  it('drops the prefix half of the read as well as the rows', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    const repoId = repos.listRepos()[0]?.repoId
    expect(repoId).not.toBeNull()

    rawDb
      .prepare('UPDATE repo_prefixes SET prefix = ? WHERE repo_id = ?')
      .run('ZZ', repoId as string)

    expect(repos.listRepos()[0]?.prefix).toBe('AL')

    repos.invalidateRegistry()

    // Two reads are held behind one field; a conversion that re-reads the rows
    // and keeps the prefix map would pass every assertion above this one.
    expect(repos.listRepos()[0]?.prefix).toBe('ZZ')
  })

  it('is safe with nothing held', () => {
    repos.invalidateRegistry()
    repos.invalidateRegistry()

    expect(repos.listRepos()).toEqual([])
  })
})

describe('ReposRepository.repoIdResolver', () => {
  it('resolves a path under a registered root to that root repo id', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    const alpha = repos.listRepos()[0]?.repoId

    const resolve = repos.repoIdResolver()

    expect(resolve('/home/u/alpha')).toBe(alpha)
    expect(resolve('/home/u/alpha/src/deep/file')).toBe(alpha)
  })

  it('gives the longest containing root, not the first one registered', () => {
    repos.addRepo('/home/u', HOST, undefined, 'HU')
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    const byPath = new Map(repos.listRepos().map((r) => [r.path, r.repoId]))

    const resolve = repos.repoIdResolver()

    // Registration order puts the SHORTER root first, so a resolver that took
    // the first match would answer with /home/u here.
    expect(resolve('/home/u/alpha/src')).toBe(byPath.get('/home/u/alpha'))
    expect(resolve('/home/u/other/src')).toBe(byPath.get('/home/u'))
  })

  it('does not treat a sibling with a shared prefix as contained', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    const alpha = repos.listRepos()[0]?.repoId

    const resolve = repos.repoIdResolver()

    // `/home/u/alphabet` starts with `/home/u/alpha` as a STRING and is a
    // different repo. The separator is what makes containment mean containment.
    expect(resolve('/home/u/alphabet')).not.toBe(alpha)
  })

  it('falls back to the (host machine, path) derivation for an unclaimed path', () => {
    const resolve = repos.repoIdResolver()

    expect(resolve('/home/u/unregistered')).toBe(
      deriveRepoId({ machineId: HOST, path: '/home/u/unregistered' }),
    )
  })

  it('normalizes a trailing slash on the path it is asked about', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    const alpha = repos.listRepos()[0]?.repoId

    const resolve = repos.repoIdResolver()

    expect(resolve('/home/u/alpha/')).toBe(alpha)
    expect(resolve('/home/u/alpha/src/')).toBe(alpha)
  })

  it('reads the registry once for the whole set', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
    repos.invalidateRegistry()
    counts.clear()

    const resolve = repos.repoIdResolver()
    for (let i = 0; i < 25; i += 1) resolve(`/home/u/alpha/w${i}`)

    // One read for the resolver, none for the 25 resolutions — the property the
    // batch form exists for. Exactly one rather than at most one, so a probe
    // that counted nothing fails here instead of reading as a perfect cache.
    expect(registryReads()).toBe(1)
  })

  it('answers from the registry it was taken with, not from a later one', () => {
    repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')

    const resolve = repos.repoIdResolver()
    const before = resolve('/home/u/beta/src')

    repos.addRepo('/home/u/beta', HOST, undefined, 'BE')

    // The file says the returned function holds a SNAPSHOT and that a caller
    // must not keep one across a write. This pins that it really is a snapshot:
    // a resolver that re-read the registry per call would answer with beta's id
    // on the second call and nothing else in the suite would notice.
    expect(resolve('/home/u/beta/src')).toBe(before)
    expect(repos.resolveRepoIdForPath('/home/u/beta/src')).not.toBe(before)
  })
})
