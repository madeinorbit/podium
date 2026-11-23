/**
 * TESTS AND HARNESSES ONLY: the instance settings record in a pool (POD-6677).
 * Production records come from the feed through the row source; a fixture
 * applies the resolved row directly, as the row source would publish it.
 */
import {
  INSTANCE_PREFERENCES_ROW_ID,
  InstancePreferences,
  instancePreferencesRecordOf,
  resolveInstancePreferences,
} from '@podium/model'
import type { MobxPool } from './pool'

type Groups = { readonly [K in keyof InstancePreferences]?: Partial<InstancePreferences[K]> }

/** Put the instance settings in the pool: these groups over the defaults. */
export function seedInstancePreferences(pool: Pick<MobxPool, 'apply'>, groups: Groups = {}): void {
  const resolved = resolveInstancePreferences(
    instancePreferencesRecordOf(InstancePreferences.parse(groups)),
  )
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'instancePreferences',
        id: INSTANCE_PREFERENCES_ROW_ID,
        value: { ...resolved, id: INSTANCE_PREFERENCES_ROW_ID },
      },
    ],
  })
}
