/**
 * THE REPO LIST IS READ ONCE PER PASS, NOT ONCE PER CALLER (POD-1638).
 *
 * AGAINST THE REAL MIGRATED SCHEMA, and asserting the CONSERVED QUANTITY — the
 * number of times the statement reaches SQLite — not a duration. Duration moves
 * with the machine and with load; the call count is the defect. Live attribution
 * caught `SELECT machine_id, path, origin_url, repo_id FROM repos ORDER BY rowid
 * ASC` running 24206 times in ONE second for 314678 rows, because every
 * `resolveRepoIdForPath` / `prefixForPath` call re-scanned the whole table (and
 * `repo_prefixes` with it). The session projection calls it once per session, so
 * a single list of ~1200 sessions paid ~1200 full scans of a 13-row table.
 *
 * WHY A PROBE RATHER THAN A FAKE REPOSITORY. The thing under test is how many
 * statements the repository ISSUES, which a fake cannot be wrong about. The
 * probe observes a real migrated database, so the rows the assertions read back
 * are the rows SQLite actually returned.
 *
 * THE PROBE IS THE EXECUTION SEAM [POD-3281]. It used to be a counting
 * `SqlDatabase` handed to the constructor; that wrapper disappears from the path
 * the moment this repository takes an executor instead of a handle. The seam
 * counts executions on whichever feed issued them, so the same assertions keep
 * measuring the same quantity through the conversion.
 *
 * Every "reads once" assertion below is paired with an assertion that a WRITE
 * makes the next read go back to the database, so none of them can be satisfied
 * by a repository that simply never reads at all, or by one that caches forever
 * and answers a registered repo with a stale miss.
 */

import { asMachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor, probeLegacyStatements } from './executor'
import { ReposRepository } from './repos'
import { TableWrites } from './table-writes'

const HOST = 'machine-host'

let counts: Map<string, number>
let repos: ReposRepository
let tableWrites: TableWrites
/** The migrated database. The bypassing writer issues its UPDATEs straight on
 *  it; `tableReads` only counts SELECTs, so its writes are not miscounted. */
let rawDb: SqlDatabase

/** Executions of any statement reading the `repos` or `repo_prefixes` tables. */
const tableReads = (table: string): number =>
  [...counts].reduce(
    (n, [sql, c]) => (sql.includes(`FROM ${table}`) && sql.startsWith('SELECT') ? n + c : n),
    0,
  )

beforeEach(async () => {
  rawDb = openMigratedTestDatabase()
  counts = new Map()
  probeLegacyStatements({ db: rawDb }, (observation) => {
    counts.set(observation.sql, (counts.get(observation.sql) ?? 0) + 1)
  })
  tableWrites = new TableWrites()
  // The probe patches `prepare` ON `rawDb` IN PLACE, and the executor's legacy
  // field is that same object, so the repository's statements are still observed
  // through the constructor change [POD-3281, POD-3254].
  repos = new ReposRepository(
    createBunStoreExecutor({ database: rawDb }),
    () => {},
    asMachineId(HOST),
    tableWrites,
  )
  await repos.addRepo('/home/u/alpha', asMachineId(HOST), undefined, 'AL')
  await repos.addRepo('/home/u/beta', asMachineId(HOST), undefined, 'BE')
  counts.clear()
})

describe('repo reads under a projection pass', () => {
  it('resolves many paths without re-scanning repos per path', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/home/u/alpha/.worktrees/w${i}`)
    const ids = paths.map((p) => repos.resolveRepoIdForPath(p))

    // Correctness first: every worktree path resolves to alpha's stable repo id,
    // so a cache that answered with a wrong (or empty) list would fail here.
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(await repos.resolveRepoIdForPath('/home/u/alpha'))

    // 50 resolutions must not be 50 table scans — and must not be ZERO either.
    // `toBeLessThanOrEqual` alone is satisfied by a probe that counts nothing,
    // which is how an instrument dies without turning a suite red (POD-3281,
    // spec §6 rule 14: assert the mechanism, and test the arm the passing test
    // does not walk).
    expect(tableReads('repos')).toBeLessThanOrEqual(1)
    expect(tableReads('repos')).toBeGreaterThan(0)
  })

  it('resolves prefixes for many paths without re-scanning repo_prefixes per path', () => {
    const prefixes = Array.from({ length: 50 }, (_, i) =>
      repos.prefixForPath(`/home/u/beta/.worktrees/w${i}`),
    )

    expect(new Set(prefixes)).toEqual(new Set(['BE']))
    expect(tableReads('repo_prefixes')).toBeLessThanOrEqual(2)
    // Same pairing: a dead probe reports 0 and would pass the bound above.
    expect(tableReads('repo_prefixes')).toBeGreaterThan(0)
  })

  it('sees a repo registered after the first read', async () => {
    expect(await repos.prefixForPath('/home/u/gamma/src')).toBeNull()

    await repos.addRepo('/home/u/gamma', asMachineId(HOST), undefined, 'GA')

    // The paired admission: a cache that never invalidates would still say null.
    expect(await repos.prefixForPath('/home/u/gamma/src')).toBe('GA')
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/home/u/gamma')
  })

  it('sees a repo removed after the first read', async () => {
    expect(await repos.resolveRepoIdForPath('/home/u/alpha/x')).toBe(
      await repos.resolveRepoIdForPath('/home/u/alpha'),
    )
    const before = await repos.resolveRepoIdForPath('/home/u/alpha/x')

    await repos.removeRepo('/home/u/alpha', asMachineId(HOST))

    // With alpha gone the path no repo row claims falls back to a derived id,
    // which is a DIFFERENT value — a stale cache would still return `before`.
    expect(await repos.resolveRepoIdForPath('/home/u/alpha/x')).not.toBe(before)
    expect((await repos.listRepos()).map((r) => r.path)).not.toContain('/home/u/alpha')
  })

  it('sees a prefix changed after the first read', async () => {
    expect(await repos.prefixForPath('/home/u/alpha/x')).toBe('AL')

    await repos.setRepoPrefix(asMachineId(HOST), '/home/u/alpha', 'AZ')

    expect(await repos.prefixForPath('/home/u/alpha/x')).toBe('AZ')
  })
})

/**
 * THE WRITERS THAT DO NOT GO THROUGH THIS CLASS (POD-1638) — AND THERE ARE NONE
 * LEFT.
 *
 * The first version of the cache justified itself with "this class is the only
 * writer of both tables", proved by grepping `UPDATE repos`. That proof could not
 * see `SessionStore.migrateLegacyMachineIdentity`, which built
 * `UPDATE OR REPLACE "${table}" SET "${column}" = ?` from `sqlite_master` on the
 * store's RAW handle — no literal table name in the source, and no trip through
 * the invalidating `prepare` wrapper. The result was `listRepos()` answering with
 * the PRE-upgrade machine id, which is a correctness bug on a live instance. The
 * regression test that pinned that seam lived here.
 *
 * IT WENT WITH ITS WRITER at POD-3246: the upgrade is deleted, and no production
 * code writes `repos` outside this class any more. What the test asserted was
 * that ONE caller remembered to call `invalidate()`, so re-pointing it at a
 * bypassing write authored by the test itself would only have pinned the test's
 * own `invalidate()` call — a green that says nothing.
 *
 * The seam is still real, and POD-3247 owns it: the invalidation moves from a
 * proxy that inspects SQL text to something the store owns, and the fixture that
 * proves a bypassing writer cannot serve a stale registry belongs to that
 * mechanism, not to a boot upgrade that no longer exists.
 */
describe('registry cache vs writers that bypass the repository', () => {
  /**
   * THE SEAM, DRIVEN WITHOUT A CALLER (POD-3247), which is the only way left to
   * drive it and the reason it is worth a test at all.
   *
   * POD-3246 took the last bypassing writer out of the tree, so this mechanism has
   * no production caller today. It is not speculative: it is the shape of every
   * statement the async query layer will run through an executor, and the failure
   * it prevents — `listRepos()` answering from a read taken before someone else's
   * write — is one that already reached a live instance once.
   *
   * So the write below is issued on the handle DIRECTLY, with no repository
   * involved and nothing about it this class could recognise if it were still
   * reading SQL text.
   */
  it('a write announced to the store, from no repository at all, drops the held read', async () => {
    // Hold the read, so there is something to go stale. Without this the assertion
    // at the end passes against a cache that is simply empty.
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/home/u/alpha')

    rawDb.prepare("UPDATE repos SET path = '/renamed' WHERE path = '/home/u/alpha'").run()

    // Still stale, and that is the point: the ANNOUNCEMENT is what fixes this, not
    // the write. Skipping this step would leave a test that passes against a
    // repository holding no cache at all.
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/home/u/alpha')

    tableWrites.wrote('repos')

    expect((await repos.listRepos()).map((r) => r.path)).toContain('/renamed')
  })

  it('announces per table, so an unrelated table does not drop the read', async () => {
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/home/u/alpha')
    rawDb.prepare("UPDATE repos SET path = '/renamed' WHERE path = '/home/u/alpha'").run()

    // The counterfactual for the test above: if any announcement dropped the read,
    // that test would hold for any argument and would not be about `repos` at all.
    tableWrites.wrote('sessions')
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/home/u/alpha')

    // The other subscribed table, because the prefix map is held by the same read.
    tableWrites.wrote('repo_prefixes')
    expect((await repos.listRepos()).map((r) => r.path)).toContain('/renamed')
  })
})
