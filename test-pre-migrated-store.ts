/**
 * Installs the pre-migrated store fixture for ordinary `apps/server` test files
 * [POD-523]. Wired as a vitest `setupFile` alongside the hermetic ones, so it runs
 * once per test file, in that file's own fork, BEFORE the file is imported — which
 * is what lets a store constructed at module scope get the fast path too.
 *
 * The decision is made from the test file's own path (`usesRealMigrationChain`), not
 * from an env var or an opt-in call, so `apps/server/src/migrations/**` keeps the
 * real 54-step chain structurally rather than by anyone remembering to ask for it.
 * See `apps/server/src/test-support/pre-migrated-store.ts` for the whole design.
 *
 * The server module is imported only for a server test file: every other package's
 * forks must not pay for loading apps/server source, and none of them construct a
 * `SessionStore`.
 */

import { expect } from 'vitest'

const testPath = expect.getState().testPath ?? ''

if (testPath.replaceAll('\\', '/').includes('/apps/server/src/')) {
  const { installPreMigratedStoreFixtureFor } = await import(
    './apps/server/src/test-support/pre-migrated-store'
  )
  installPreMigratedStoreFixtureFor(testPath)
}
