/**
 * MY PERSONAL SETTINGS ON THE PHONE (POD-6673): read from my synced
 * `userPreferences` record in the pool, never from `settings.get` (the instance
 * tier only). A setting changed on my other device moves these with no request.
 */

import { myPreferences } from '@podium/client-graph/per-user-records'
import type { MobxPool } from '@podium/client-graph/pool'
import { useMobilePoolProjection } from './mobile-pool'

const codingHarnessOf = (pool: MobxPool): string | undefined => myPreferences(pool)?.codingHarness

/** The harness a coding session starts with when a task leaves its agent on
 *  Auto; undefined until my settings are in the pool. */
export function useMyCodingHarness(): string | undefined {
  return useMobilePoolProjection(codingHarnessOf, undefined)
}
