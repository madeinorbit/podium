/**
 * Two workers of one Postgres-leg run get separate databases [POD-6980]: half 1 of the
 * pair, run beside `pg-test-isolation-2.test.ts`. See `test-support/pg-worker-isolation.ts`.
 */

import { describe, it } from 'vitest'
import { testStoreEngine } from '../test-support/pg-test-database'
import {
  PARTNER_TIMEOUT_MS,
  pairCanRun,
  provePgWorkerIsolation,
} from '../test-support/pg-worker-isolation'

describe.skipIf(testStoreEngine() !== 'pg' || !pairCanRun())('postgres worker isolation', () => {
  it(
    'this worker sees only its own database, and the other worker only its own',
    async () => {
      await provePgWorkerIsolation('worker-1', 'worker-2')
    },
    PARTNER_TIMEOUT_MS * 2 + 10_000,
  )
})
