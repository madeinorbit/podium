/**
 * Postgres-leg setupFile [POD-6980]: drop each database when its scope ends.
 *
 * A database made while a test (or its `beforeEach`) runs is dropped after that
 * test; one made at module scope or in `beforeAll` when the file ends. Registered
 * first, so under vitest's default stacked hook order these run after the file's
 * own `afterEach`/`afterAll` (a store closing its pool), and `WITH (FORCE)` covers a
 * store that was never closed. A fork that is killed before this runs leaves its
 * databases to the lane's teardown, and a killed lane to the next lane's sweep.
 */

import { afterAll, afterEach, expect } from 'vitest'
import {
  dropPgTestDatabases,
  dropPgTestScopedDatabases,
  setPgTestScopeReader,
} from './pg-test-database'

setPgTestScopeReader(() => (expect.getState().currentTestName === undefined ? 'file' : 'test'))

afterEach(async () => {
  await dropPgTestScopedDatabases()
})

afterAll(async () => {
  await dropPgTestDatabases()
})
