/**
 * Postgres-leg setupFile [POD-6980]: drop every database this worker made when its
 * test file ends.
 *
 * Registered first, so under vitest's default stacked hook order it runs after the
 * file's own `afterAll` (a store closing its pool). `WITH (FORCE)` covers a file that
 * never closed one. A fork that is killed before this runs leaves its databases to
 * the lane's teardown, and a lane that is killed leaves them to the next lane's sweep.
 */

import { afterAll } from 'vitest'
import { dropPgTestDatabases } from './pg-test-database'

afterAll(async () => {
  await dropPgTestDatabases()
})
