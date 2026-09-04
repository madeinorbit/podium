/**
 * The query port carries the composition root's capability, both halves
 * (POD-3338 for the port, POD-3416 for what it now carries).
 *
 * Neither assertion is made by the repository's other suites, which all build
 * over the fixture and then read back through the repository itself — so they
 * pass whether the port carried anything of the caller's or the repository
 * quietly opened something of its own.
 *
 * THE REFUSAL THAT USED TO LIVE HERE IS GONE, and deliberately: the port's
 * capability was optional while it named the executor's `legacy` handle, so the
 * repository threw at construction when it was absent. Spec rule 27b moved that
 * check to `apps/server`'s `store.ts`, which asserts the seam ONCE where the
 * whole repository set is constructed — so the case this test drove can no longer
 * be produced through a constructor the compiler accepts.
 */

import { describe, expect, it } from 'vitest'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, createTestSyncQueries, testSyncServerTables } from './test-support'

describe('the sync adapter query port', () => {
  it('runs the adapter statements on the connection the port carries', () => {
    const db = createTestSyncDatabase()
    const repo = new SyncRepository(createTestSyncQueries(db), testSyncServerTables)

    repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-1' }, 1)

    // Read back through the SAME connection the port was built over, not through
    // the repository — so the assertion is that the port carried the caller's
    // database, not merely that the repository is self-consistent.
    expect(
      db.prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1').get(),
    ).toEqual({ feed_id: 'feed-1', epoch: 'epoch-1' })
  })

  it('runs its statements inside a span the CALLER opened, as a savepoint', () => {
    // The property the port's `transact` exists for: `SessionStore.transact`
    // wraps an `appendChanges`, and the inner span must degrade to a savepoint
    // rather than open a second transaction on the same connection. Asserted by
    // ROLLING THE OUTER SPAN BACK — if the repository had opened a transaction of
    // its own it would have committed independently and the rows would survive.
    const db = createTestSyncDatabase()
    const queries = createTestSyncQueries(db)
    const repo = new SyncRepository(queries, testSyncServerTables)

    expect(() =>
      queries.transact(() => {
        repo.appendChanges([{ entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{}' }], 1)
        expect(repo.maxChangeSeq()).toBe(1)
        throw new Error("roll the caller's span back")
      }),
    ).toThrow("roll the caller's span back")

    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 })
  })
})
