/**
 * THE ARCHIVED UPSTREAM OUTBOX, READ-ONLY (POD-309, ADR 5 D8).
 *
 * `upstream_outbox` held issue mutations a NODE queued for a hub it could not reach.
 * POD-309 deletes every WRITER (`UpstreamForwarder` and the repository's enqueue /
 * delete / attempt-bump methods) and keeps ONE reader, because D8 permits archiving the
 * schema and forbids "silent discard of poison/pending work".
 *
 * These cases pin the read against the REAL table and the REAL SQL — a fake source
 * would prove nothing about a column name or an ORDER BY, and the operator report
 * (apps/server/src/upstream-retirement.test.ts) is the only consumer, so a wrong column
 * here surfaces as an empty report rather than as an error.
 */

import { describe, expect, it } from 'vitest'
import { SyncRepository } from './sync-repository'
import {
  createTestSyncDatabase,
  createTestSyncQueries,
  TEST_WORKSPACE_ID,
  testSyncServerTables,
} from './test-support'

function parkRow(
  db: ReturnType<typeof createTestSyncDatabase>,
  mutationId: string,
  proc: string,
  queuedAt: number,
  queueOrder: number,
): void {
  db.prepare(
    'INSERT INTO upstream_outbox (workspace_id, mutation_id, proc, input, queued_at, queue_order) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    TEST_WORKSPACE_ID,
    mutationId,
    proc,
    JSON.stringify({ id: 'iss_1', mutationId }),
    queuedAt,
    queueOrder,
  )
}

describe('listParkedUpstreamMutations — the archived outbox, read-only', () => {
  it('reports nothing on a database with an empty outbox', async () => {
    const db = createTestSyncDatabase()
    expect(
      await new SyncRepository(
        createTestSyncQueries(db),
        testSyncServerTables,
        TEST_WORKSPACE_ID,
      ).listParkedUpstreamMutations(),
    ).toEqual([])
  })

  /**
   * The positive control AND the ordering claim in one, deliberately. A reader that
   * returned `[]` unconditionally — a typo'd table name, a WHERE that matches nothing —
   * satisfies the empty case above perfectly, so the empty case alone is not evidence
   * that anything works. Rows are inserted OUT of queue order so FIFO is measured
   * rather than coincidental with insertion order. The order is the `queue_order` the
   * queue-order migration numbered them with from (queued_at, rowid) (POD-7075).
   */
  it('returns every parked row in queue order, with its proc', async () => {
    const db = createTestSyncDatabase()
    parkRow(db, 'm-late', 'close', 3_000, 3)
    parkRow(db, 'm-early', 'update', 1_000, 1)
    parkRow(db, 'm-mid', 'claim', 2_000, 2)
    expect(
      await new SyncRepository(
        createTestSyncQueries(db),
        testSyncServerTables,
        TEST_WORKSPACE_ID,
      ).listParkedUpstreamMutations(),
    ).toEqual([
      { mutationId: 'm-early', proc: 'update', queuedAt: 1_000 },
      { mutationId: 'm-mid', proc: 'claim', queuedAt: 2_000 },
      { mutationId: 'm-late', proc: 'close', queuedAt: 3_000 },
    ])
  })

  /**
   * THE RETIREMENT, as a property of the OBJECT rather than of the source file.
   *
   * A grep for `enqueueUpstreamMutation` is satisfied by a rename. This asserts the
   * repository instance exposes no writer for the archived table at all — which is what
   * "archived" means operationally: the rows are preserved and nothing may add to,
   * drain, or retry them. The positive half runs first so the check cannot pass against
   * a repository that failed to construct.
   */
  it('exposes a reader and NO writer for the archived table', () => {
    const repo = new SyncRepository(
      createTestSyncQueries(),
      testSyncServerTables,
      TEST_WORKSPACE_ID,
    )
    const surface = repo as unknown as Record<string, unknown>
    expect(typeof surface.listParkedUpstreamMutations).toBe('function')
    for (const writer of [
      'enqueueUpstreamMutation',
      'deleteUpstreamMutation',
      'bumpUpstreamMutationAttempts',
      'listUpstreamOutbox',
    ]) {
      expect(surface[writer]).toBeUndefined()
    }
  })
})
