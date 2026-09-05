/**
 * Assertion custody for the query capability (spec rule 21).
 *
 * POD-3338 originally pinned a runtime refusal in SyncRepository. POD-3416
 * moved the guard with rule 27b to SessionStore. The async flip makes
 * SessionStore construction private and gives every RootStoreExecutor one
 * required `queries` capability, so the impossible construction is now
 * rejected by TypeScript before it can reach a runtime branch.
 */

import { describe, it } from 'vitest'
import type { QueryClient, RootStoreExecutor } from './store/executor'

describe('SessionStore query capability construction', () => {
  it('refuses an executor with no queries capability at compile time', () => {
    const withoutQueries = {} as Omit<RootStoreExecutor<QueryClient>, 'queries'>

    // @ts-expect-error TS2741: Property 'queries' is missing in type
    // 'Omit<RootStoreExecutor<QueryClient>, "queries">' but required in type
    // 'RootStoreExecutor<QueryClient>'.
    const rejected: RootStoreExecutor<QueryClient> = withoutQueries

    void rejected
  })
})
