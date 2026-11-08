/**
 * MY PERSONAL SETTINGS ON THE WEB (POD-6673): read from my synced
 * `userPreferences` record in the pool, never from `settings.get`, which
 * answers the instance tier only. A setting changed on my other device moves
 * these without a request.
 */

import type { MobxPool } from '@podium/client-graph'
import { myPreferences } from '@podium/client-graph/per-user-records'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

const codingHarnessOf = (pool: MobxPool): string | undefined => myPreferences(pool)?.codingHarness

/** The harness a coding session starts with when a task leaves its agent on
 *  Auto; undefined until my settings are in the pool. */
export function useMyCodingHarness(): string | undefined {
  return useWorklistPoolProjection(codingHarnessOf, undefined)
}

const startScreenOf = (pool: MobxPool) => myPreferences(pool)?.startScreen

/** Which panel a new session of mine opens on. */
export function useMyStartScreen(): 'native' | 'chat' | 'auto' | undefined {
  return useWorklistPoolProjection(startScreenOf, undefined)
}
