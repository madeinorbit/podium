/**
 * Client-side experimental feature gate [spec:SP-f4b9].
 *
 * A flag's state is the instance settings record's `features` (POD-6677): the
 * connected server's facts (its build and config, from `welcome`, held by the
 * LiveStore) joined with the operator's experimental toggles, which sync. No
 * request: an admin's toggle on any device moves every gate at once, and an
 * app started offline gates on its saved toggles. Components gate unfinished
 * UI with `if (!useFeature('x')) return null`.
 *
 * Lives in `lib/` (not `features/`) because it is a cross-cutting gate every
 * feature may call, not a feature surface of its own — the Experimental settings
 * *page* is `features/settings/sections/experimental.tsx`. Keeping it here is what
 * stops `settings -> experimental` (and the next caller) from being a feature-to-
 * feature edge; see features/README.md + test/features.structure.test.ts.
 */
import { featureEnabled, featureStates } from '@podium/client-graph/instance-preferences'
import type { MobxPool } from '@podium/client-graph/pool'
import type { FeatureId, FeatureStates } from '@podium/protocol'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

export type { FeatureStates } from '@podium/protocol'

const statesOf = (pool: MobxPool): FeatureStates | null => featureStates(pool) ?? null

/** Every flag resolved (for the Experimental page); null until the instance
 *  settings are in the pool. */
export function useFeaturesState(): FeatureStates | null {
  return useWorklistPoolProjection(statesOf, null)
}

/** Whether feature `id` is currently enabled for this install. */
export function useFeature(id: FeatureId): boolean {
  return useWorklistPoolProjection((pool: MobxPool) => featureEnabled(pool, id), false)
}
