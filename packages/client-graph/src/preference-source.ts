import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { MobxPool } from './pool'
import { declarePreference, type PreferenceRow } from './preference-schema'
import { defineSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

declare module './source-registry' {
  interface PoolSourceRows {
    preference: PreferenceRow
  }
}

/** A read port, never a second row of preference values. Synced values are
 * read from the pool's userLayout model; local values from device storage. */
export class PreferenceSource {
  private readonly source = defineSource({ readById: this.readById.bind(this) })
  private readonly requested = new Set<string>()
  readonly counts = { batches: 0, loaded: 0, notifications: 0 }
  constructor(private readonly ui: RoutedUiState) {}
  read(key: string): Loaded<PreferenceRow>
  read(entity: 'preference', key: string): Loaded<PreferenceRow>
  read(keyOrEntity: string, key?: string): Loaded<PreferenceRow> {
    return this.source.read(key ?? keyOrEntity) as Loaded<PreferenceRow>
  }
  private readById(key: string): PreferenceRow {
    const home = declarePreference(key),
      ui = this.ui
    this.requested.add(key)
    return {
      key,
      home,
      get value() {
        return ui.get(key)
      },
    }
  }
  keys(): readonly string[] {
    return [...this.requested]
  }
  refreshKey(_key: string): void {} // Values are live at their owner, including controlled inputs.
  dispose(): void {
    this.source.dispose()
    this.requested.clear()
  }
}
export function attachPreferenceSource(pool: MobxPool, ui: RoutedUiState): void {
  if (preferenceSource(pool)) throw new Error('Preferences already attached to this pool')
  const source = new PreferenceSource(ui)
  pool.sources.register(['preference'], source)
  pool.sources.view('preferences', () => source)
}
export function preferenceSource(pool: MobxPool): PreferenceSource | undefined {
  return pool.sources.peekView<PreferenceSource>('preferences')
}
