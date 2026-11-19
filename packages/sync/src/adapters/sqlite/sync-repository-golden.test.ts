/**
 * GOLDEN PINS FOR THE SYNC REPOSITORY (POD-3416), on this package's bare SQLite
 * fixture. The pins themselves are `describeSyncRepositoryGolden` in
 * `./sync-repository.suites.ts`, which the server's store shard runs on the store's
 * own engines as well (POD-6989): read the why of each pin there.
 */

import { describeSyncRepositoryGolden } from './sync-repository.suites'
import { openBareSyncFixture } from './test-support'

describeSyncRepositoryGolden(async () => openBareSyncFixture())
