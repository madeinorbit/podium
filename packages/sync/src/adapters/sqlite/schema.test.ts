/**
 * THE ADAPTER'S SCHEMA, AND THE FIXTURE THAT MIRRORS IT.
 *
 * `test-support.ts` hand-writes the DDL for the tables this adapter's repository
 * reads, so that the package's own unit tests can exercise real SQL without
 * depending on `apps/server`'s migrator. Its comment has said "keep in sync with
 * that schema" since it was written, which is a convention, and a convention
 * between two files in different packages is a drift waiting to happen: the
 * fixture would keep passing against a column the product no longer has, and the
 * suite would go green on a shape nothing deployed.
 *
 * POD-305 gave this adapter the schema-as-code, so the mirroring is now
 * CHECKABLE. These tests compare the fixture's actual columns against the drizzle
 * schema's declared ones.
 *
 * The drizzle-orm import is an AUTHORING import — a devDependency, exactly as in
 * `apps/server/src/migrations/schema.ts`. Runtime code never imports drizzle-orm,
 * and this is a test.
 */

import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { appliedMutations, changes, feedIdentity } from './schema'
import { FeedIdentityRegistry } from '../../feed'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, createTestSyncRepository } from './test-support'

/** The column names the drizzle schema declares for a table. */
const declaredColumns = (table: Parameters<typeof getTableConfig>[0]): string[] =>
  getTableConfig(table)
    .columns.map((c) => c.name)
    .sort()

/** The column names the in-memory fixture actually creates. */
function fixtureColumns(table: string): string[] {
  const db = createTestSyncDatabase()
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  db.close()
  return rows.map((r) => r.name).sort()
}

describe('the test fixture mirrors the adapter-owned schema', () => {
  it('agrees on the change log’s columns, including the provenance triple', () => {
    // The one that would have drifted: POD-305 added three columns to the real
    // table, and without this the fixture would have kept creating the old shape
    // while every test using it passed.
    expect(fixtureColumns('changes')).toEqual(declaredColumns(changes))
  })

  it('agrees on the receipt table’s columns', () => {
    expect(fixtureColumns('applied_mutations')).toEqual(declaredColumns(appliedMutations))
  })

  it('agrees on the feed-identity table’s columns (ADR 2 D1)', () => {
    expect(fixtureColumns('feed_identity')).toEqual(declaredColumns(feedIdentity))
  })

  it('the comparison is not vacuous — both sides are non-empty and specific', () => {
    // Guard against the shape where `getTableConfig` returns nothing and the
    // fixture's PRAGMA also returns nothing, making every assertion above
    // `[] === []`.
    expect(declaredColumns(changes)).toContain('causation_id')
    expect(fixtureColumns('changes')).toContain('seq')
    expect(declaredColumns(changes).length).toBeGreaterThan(6)
  })
})

describe('the change log keeps AUTOINCREMENT', () => {
  it('declares seq as an autoincrementing primary key', () => {
    // Not stylistic. Without AUTOINCREMENT, SQLite reuses the rowids of deleted
    // rows — and head-pruning (ADR 2 D5) deletes from the TAIL of the log, so a
    // reused seq would hand two different changes the same position in the ONE
    // global sequence and every replica that saw the first would skip the second.
    const seq = getTableConfig(changes).columns.find((c) => c.name === 'seq')
    expect(seq?.primary).toBe(true)
    expect((seq as { autoIncrement?: boolean } | undefined)?.autoIncrement).toBe(true)
  })

  it('and the fixture creates it that way too', () => {
    // sqlite_master is the only place the keyword survives — PRAGMA table_info
    // reports the column as an ordinary INTEGER primary key either way, so a
    // fixture that lost AUTOINCREMENT would pass the column comparison above.
    const db = createTestSyncDatabase()
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'changes'").get() as { sql: string }
    ).sql
    db.close()
    expect(ddl.toUpperCase()).toContain('AUTOINCREMENT')
  })
})

/**
 * THE DURABLE HALF OF `FeedIdentityStore` (ADR 2 D1).
 *
 * The kernel's registry is tested in `../../feed/identity.test.ts` against a
 * plain object, which is right — the kernel may not name SQLite. But a port with
 * no working implementation is mechanism-present and coverage-absent, and "the
 * authority PERSISTS feedId/epoch" is the half of D1 that a restore depends on.
 * So the round trip is exercised here, in the one layer allowed to know what a
 * database is.
 */
describe('feed identity persists, and there is exactly one of it', () => {
  it('round-trips, and reads null before anything was written', () => {
    const repo = createTestSyncRepository()
    // The paired half: without it, a `readFeedIdentity` that returned a constant
    // would satisfy the round trip and nothing would notice.
    expect(repo.readFeedIdentity()).toBeNull()

    repo.writeFeedIdentity({ feedId: 'feed-a', epoch: '01JQ0P8Z3M4N5R6T7V8W9XAYBZ' }, 1_700_000)
    expect(repo.readFeedIdentity()).toEqual({
      feedId: 'feed-a',
      epoch: '01JQ0P8Z3M4N5R6T7V8W9XAYBZ',
    })
  })

  it('a bump REPLACES the row rather than appending a second generation', () => {
    // Two rows here would mean two answers to "which epoch is this feed on?", and
    // whichever one a query returned first is the one clients would trust. The
    // row count is the assertion; equality of the read alone would pass against an
    // append-only table whose SELECT happened to return the newest row.
    const db = createTestSyncDatabase()
    const repo = new SyncRepository(db)
    repo.writeFeedIdentity({ feedId: 'feed-a', epoch: '01JQ0P8Z3M4N5R6T7V8W9XAYBZ' }, 1)
    repo.writeFeedIdentity({ feedId: 'feed-a', epoch: '01JQ0P9Q1C2D3E4F5G6H7J8K9M' }, 2)

    expect(repo.readFeedIdentity()?.epoch).toBe('01JQ0P9Q1C2D3E4F5G6H7J8K9M')
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM feed_identity').get() as { n: number }
    expect(n).toBe(1)
    db.close()
  })

  it('drives the SHIPPED registry end to end, so the port and the table agree', () => {
    // The seam itself, and the case that would catch a column-name mismatch that
    // both halves' own tests miss. `FeedIdentityRegistry` is the kernel's; the
    // store is this adapter's; neither file alone proves they compose.
    const repo = createTestSyncRepository()
    let index = 0
    const mint = () => ['feed-x', '01JQ0PB5X7Y8Z9A0B1C2D3E4F5', '01JQ0PC6Y8Z9A0B1C2D3E4F5G6'][index++] as string
    const store = {
      readIdentity: () => repo.readFeedIdentity(),
      writeIdentity: (identity: { feedId: string; epoch: string }) =>
        repo.writeFeedIdentity(identity, 1_700_000),
    }

    const minted = new FeedIdentityRegistry(store, mint).current()
    // THE RESTART: a fresh registry, over the same durable store, with a mint that
    // would produce a different value if it were consulted.
    const afterRestart = new FeedIdentityRegistry(store, mint).current()
    expect(afterRestart).toEqual(minted)
    expect(afterRestart.feedId).toBe('feed-x')
  })
})
