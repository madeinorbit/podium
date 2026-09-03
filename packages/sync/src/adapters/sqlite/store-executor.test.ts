/**
 * The executor port's two arms (POD-3338).
 *
 * Neither is walked by the repository's other suites, which all build over a
 * fixture executor that HAS a connection. The refusal in particular is the whole
 * reason `legacy` is resolved at construction rather than per statement, so it
 * needs an assertion of its own or the reasoning is only a comment.
 */

import { describe, expect, it } from 'vitest'
import { syncStoreExecutorOver } from './store-executor'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, testSyncServerTables } from './test-support'

describe('the sync adapter executor port', () => {
  it('runs the adapter statements on the connection the executor carries', () => {
    const db = createTestSyncDatabase()
    const repo = new SyncRepository(syncStoreExecutorOver(db), testSyncServerTables)

    repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-1' }, 1)

    // Read back through the SAME connection the port handed over, not through
    // the repository — so the assertion is that the port carried the handle,
    // not merely that the repository is self-consistent.
    expect(db.prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1').get()).toEqual(
      { feed_id: 'feed-1', epoch: 'epoch-1' },
    )
  })

  it('refuses at CONSTRUCTION when the executor carries no connection', () => {
    // The shape a fake or a remote driver produces: an executor whose `legacy`
    // is absent because there is no bun:sqlite connection behind it.
    expect(() => new SyncRepository({ legacy: undefined }, testSyncServerTables)).toThrow(
      /legacy connection/,
    )
  })
})
