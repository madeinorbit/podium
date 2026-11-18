/**
 * The Postgres leg of the store shard: lane `server-store-pg` [POD-6980, POD-6958 design 2.10].
 *
 * The same files as the store shard (`vitest.store.config.ts`), less the ones
 * `test-store-engines.json` lists as SQLite-only or not yet converted, with two
 * additions to the shared setup:
 *
 * - globalSetup `pg-test-host.ts` finds or starts the Postgres test server, builds
 *   the template, and switches the run to `PODIUM_TEST_STORE_ENGINE=pg`;
 * - setupFile `pg-test-worker-setup.ts` drops each worker's databases when its file ends.
 *
 * Everything else (hermetic env, worker cap, timeouts, isolation) is the store
 * shard's. Not a Turbo task and not part of `bun run test`: it needs Postgres.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import { postgresLegFiles } from './src/test-support/test-store-engines'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root: repositoryRoot,
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    name: 'server:store-pg',
    include: postgresLegFiles(repositoryRoot),
    passWithNoTests: false,
    retry: 0,
    // Every statement is a round trip to a server here, where SQLite's is a call into
    // the process: a statement pin's 200-row world takes several times as long to build
    // (POD-6994). The SQLite lanes keep the shared 20 s.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    globalSetup: [
      ...sharedVitestConfig.test.globalSetup,
      fileURLToPath(new URL('./src/test-support/pg-test-host.ts', import.meta.url)),
    ],
    setupFiles: [
      ...sharedVitestConfig.test.setupFiles,
      './apps/server/src/test-support/pg-test-worker-setup.ts',
    ],
  },
})
