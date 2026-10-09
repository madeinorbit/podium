import type { MobxPool } from './pool'
import { declarePreference } from './preference-schema'
import { preferenceSource } from './preference-source'

/** A fully loaded, default device-preference owner for row-only fixtures.
 * Runtime fixtures keep their real preference source and its loading boundary. */
export function attachMissionTestPreferences(pool: MobxPool): void {
  if (preferenceSource(pool)) return
  pool.sources.view('mission-test-preferences', () => {
    const source = {
      read: (_entity: 'preference', key: string) => ({ key, home: declarePreference(key), value: null }),
      dispose: () => {},
    }
    pool.sources.register(['preference'], source)
    return source
  })
}
