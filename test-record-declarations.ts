/**
 * Loads the generic record declarations before a client test file runs
 * (POD-6423). The app loads them while it opens its outbox
 * (`openKernelEngineOutbox`), before anything can queue, send or paint a record
 * write. A test that builds a runtime, a reducer or a records API directly has
 * skipped that open, so it gets the same loaded state here; a reader that runs
 * without it throws, which is the production rule.
 *
 * Server and daemon files never read the client's record table, so they skip it.
 */

import { expect } from 'vitest'

const testPath = (expect.getState().testPath ?? '').replaceAll('\\', '/')

if (!testPath.includes('/apps/server/') && !testPath.includes('/apps/daemon/')) {
  const { loadRecordDeclarations } = await import('./packages/client-core/src/records')
  await loadRecordDeclarations()
}
