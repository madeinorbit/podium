/**
 * ONE FEED PER WORKSPACE (ADR 13, POD-6959 design 2.7, POD-7021), on this package's
 * bare SQLite fixture. The tests are `describeTenantFeed` in
 * `./sync-repository.suites.ts`, which the server's store shard runs on the store's
 * own engines as well (POD-6989).
 */

import { describe } from 'vitest'
import { describeTenantFeed } from './sync-repository.suites'
import { openBareSyncFixture } from './test-support'

describe('tenant feed isolation', () => {
  describeTenantFeed(async () => openBareSyncFixture())
})
