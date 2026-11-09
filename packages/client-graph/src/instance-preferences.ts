/**
 * THE INSTANCE SETTINGS IN THE POOL (POD-6677): the reads screens share.
 *
 * The instance tier of the settings is one synced `instancePreferences` record,
 * every member's, kept offline by the replica. Each read below is tracked: an
 * admin's change on any device moves it without a request. Feature flags are
 * the record's `features`, which joins the connected server's facts (the
 * LiveStore's `welcome` reading) with the record's experimental toggles.
 */

import type { InstancePreferences } from '@podium/model'
import { INSTANCE_PREFERENCES_ROW_ID } from '@podium/model/browser'
import type { FeatureId, FeatureStates } from '@podium/protocol'
import { here } from './lookup'
import type { InstancePreferencesModel } from './models'
import type { MobxPool } from './pool'

/** The host lifecycle policy: hibernation and worktree clean-up. */
export type HostLifecycle = Pick<InstancePreferences, 'hibernation' | 'worktreeGc'>

/** The instance settings, resolved with defaults; undefined until the pool
 *  holds the record (its first publication, or the saved copy offline). */
export function instancePreferences(
  pool: Pick<MobxPool, 'model'>,
): InstancePreferencesModel | undefined {
  return here(pool.model('instancePreferences', INSTANCE_PREFERENCES_ROW_ID))
}

/** Every feature flag resolved; undefined until the instance settings are in the pool. */
export function featureStates(pool: Pick<MobxPool, 'model'>): FeatureStates | undefined {
  return instancePreferences(pool)?.features
}

/** Whether one feature is on for this install: off until the settings are known. */
export function featureEnabled(pool: Pick<MobxPool, 'model'>, id: FeatureId): boolean {
  return instancePreferences(pool)?.featureEnabled(id) ?? false
}
