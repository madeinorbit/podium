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
 * WHY A COUNTING WRAPPER RATHER THAN A FAKE REPOSITORY. The thing under test is
 * how many statements the repository ISSUES, which a fake cannot be wrong about.
 * The wrapper delegates every call to a real migrated database, so the rows the
 * assertions read back are the rows SQLite actually returned.
 *
 * Every "reads once" assertion below is paired with an assertion that a WRITE
 * makes the next read go back to the database, so none of them can be satisfied
 * by a repository that simply never reads at all, or by one that caches forever
 * and answers a registered repo with a stale miss.
 */

import { asMachineId } from '@podium/model'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveRepoId } from '../repo-id'
import { SessionStore } from '../store'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { ReposRepository } from './repos'

const HOST = 'machine-host'

let counts: Map<string, number>
let repos: ReposRepository

/** Count executions per statement, delegating to the real database. */
function counting(db: SqlDatabase, into: Map<string, number>): SqlDatabase {
  const bump = (sql: string): void => {
    into.set(sql, (into.get(sql) ?? 0) + 1)
  }
  return {
    prepare(sql) {
      const st = db.prepare(sql)
      return {
        run: (...p: SqlParam[]) => {
          bump(sql)
          return st.run(...p)
        },
        get: (...p: SqlParam[]) => {
          bump(sql)
          return st.get(...p)
        },
        all: (...p: SqlParam[]) => {
          bump(sql)
          return st.all(...p)
        },
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

/** Executions of any statement reading the `repos` or `repo_prefixes` tables. */
const tableReads = (table: string): number =>
  [...counts].reduce(
    (n, [sql, c]) => (sql.includes(`FROM ${table}`) && sql.startsWith('SELECT') ? n + c : n),
    0,
  )

beforeEach(() => {
  const raw = openMigratedTestDatabase()
  counts = new Map()
  repos = new ReposRepository(counting(raw, counts), () => {}, asMachineId(HOST))
  repos.addRepo('/home/u/alpha', HOST, undefined, 'AL')
  repos.addRepo('/home/u/beta', HOST, undefined, 'BE')
  counts.clear()
})

describe('repo reads under a projection pass', () => {
  it('resolves many paths without re-scanning repos per path', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/home/u/alpha/.worktrees/w${i}`)
    const ids = paths.map((p) => repos.resolveRepoIdForPath(p))

    // Correctness first: every worktree path resolves to alpha's stable repo id,
    // so a cache that answered with a wrong (or empty) list would fail here.
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(repos.resolveRepoIdForPath('/home/u/alpha'))

    // 50 resolutions must not be 50 table scans.
    expect(tableReads('repos')).toBeLessThanOrEqual(1)
  })

  it('resolves prefixes for many paths without re-scanning repo_prefixes per path', () => {
    const prefixes = Array.from({ length: 50 }, (_, i) =>
      repos.prefixForPath(`/home/u/beta/.worktrees/w${i}`),
    )

    expect(new Set(prefixes)).toEqual(new Set(['BE']))
    expect(tableReads('repo_prefixes')).toBeLessThanOrEqual(2)
  })

  it('sees a repo registered after the first read', () => {
    expect(repos.prefixForPath('/home/u/gamma/src')).toBeNull()

    repos.addRepo('/home/u/gamma', HOST, undefined, 'GA')

    // The paired admission: a cache that never invalidates would still say null.
    expect(repos.prefixForPath('/home/u/gamma/src')).toBe('GA')
    expect(repos.listRepos().map((r) => r.path)).toContain('/home/u/gamma')
  })

  it('sees a repo removed after the first read', () => {
    expect(repos.resolveRepoIdForPath('/home/u/alpha/x')).toBe(
      repos.resolveRepoIdForPath('/home/u/alpha'),
    )
    const before = repos.resolveRepoIdForPath('/home/u/alpha/x')

    repos.removeRepo('/home/u/alpha', HOST)

    // With alpha gone the path no repo row claims falls back to a derived id,
    // which is a DIFFERENT value — a stale cache would still return `before`.
    expect(repos.resolveRepoIdForPath('/home/u/alpha/x')).not.toBe(before)
    expect(repos.listRepos().map((r) => r.path)).not.toContain('/home/u/alpha')
  })

  it('sees a prefix changed after the first read', () => {
    expect(repos.prefixForPath('/home/u/alpha/x')).toBe('AL')

    repos.setRepoPrefix(HOST, '/home/u/alpha', 'AZ')

    expect(repos.prefixForPath('/home/u/alpha/x')).toBe('AZ')
  })
})

/**
 * THE WRITERS THAT DO NOT GO THROUGH THIS CLASS (POD-1638 regression).
 *
 * The first version of the cache justified itself with "this class is the only
 * writer of both tables", proved by grepping `UPDATE repos`. That proof could not
 * see `SessionStore.migrateLegacyMachineIdentity`, which builds
 * `UPDATE OR REPLACE "${table}" SET "${column}" = ?` from `sqlite_master` on the
 * store's RAW handle — no literal table name in the source, and no trip through
 * the invalidating `prepare` wrapper. The result was `listRepos()` answering with
 * the PRE-upgrade machine id, which is a correctness bug on a live instance.
 *
 * `store.repo-id.test.ts` caught it, but that test is about POD-318 identity
 * stability and would keep passing if this cache were replaced by something else
 * with the same hole. This pins the SEAM: the bypassing writer invalidates.
 */
describe('registry cache vs writers that bypass the repository', () => {
  it('serves the upgraded machine id after the raw-handle identity migration', () => {
    const store = new SessionStore(':memory:')
    store.repos.addRepo('/legacy', '__local__')

    // Warm the cache BEFORE the migration — without this read the test passes
    // against a stale cache too, because there would be nothing cached to go
    // stale. The bug only exists for a reader that looked first.
    expect(store.repos.listRepos()[0]?.machineId).toBe('__local__')

    store.migrateLegacyMachineIdentity(store.hostMachineId)

    expect(store.repos.listRepos()[0]?.machineId).toBe(store.hostMachineId)
    expect(store.repos.listRepoPaths()).toEqual(['/legacy'])
    // The machine moved; the opaque stored id did NOT (POD-318).
    expect(store.repos.listRepos()[0]?.repoId).toBe(
      deriveRepoId({ machineId: '__local__', path: '/legacy' }),
    )
    store.close()
  })
})
