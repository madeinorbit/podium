/**
 * The Stage A seam, for a test that builds ONE repository over its own database
 * [POD-3221 spec rule 27b].
 *
 * WHY THIS EXISTS. A converted repository takes the synchronous drizzle instance
 * in the constructor slot the `SqlDatabase` used to occupy, and production gets
 * it from `store.ts`, which asserts it once. A test that constructs a single
 * repository directly has no `SessionStore` to get it from, so before this helper
 * every such test wrote the executor construction and the undefined-check by
 * hand — and there are twenty of those call sites in the interactions suite
 * alone, across seven conversion waves.
 *
 * IT IS SETUP, NOT AN ORACLE. It changes how a test REACHES a repository and
 * nothing about what the test asserts, which is the line the conversion rules
 * draw (method §4: setup edits are allowed and listed; assertions are not).
 *
 * B1 RETIRES IT with the seam: when repositories take the asynchronous instance,
 * this returns that one instead, and the call sites do not move.
 */

import { createBunStoreExecutor } from '../store/executor'
import type { StoreQueries } from '../store/executor/sync-drizzle'

type BunBackedDatabase = Parameters<typeof createBunStoreExecutor>[0]['database']

/** The capability over `database`, refusing loudly rather than handing back undefined. */
export function stageASeam(database: BunBackedDatabase): StoreQueries {
  const queries = createBunStoreExecutor({ database }).syncQueries
  if (!queries) {
    throw new Error(
      'this test database is not bun-backed, so it carries no synchronous query ' +
        'capability and no converted repository can be built over it',
    )
  }
  return queries
}
