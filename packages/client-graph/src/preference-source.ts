import type { RoutedUiState } from '@podium/client-core/ui-state'
import { observable, runInAction } from 'mobx'
import { declarePreference, type PreferenceRow } from './preference-schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** Read-only pool storage. Only MobxPool.row calls read; the runtime's routed UI
 * port retains hydration, optimism, rollback, rescope and write ownership. */
export class PreferenceSource {
  private readonly rows = observable.map<string, PreferenceRow>(undefined, { deep: false })
  private readonly pending = new Set<string>()
  private readonly homes = new Map<string, PreferenceRow['home']>()
  private scheduled = false
  private disposed = false
  private readonly unsubscribe: () => void
  readonly counts = { batches: 0, loaded: 0, notifications: 0 }

  constructor(private readonly ui: RoutedUiState) {
    this.unsubscribe = ui.subscribe(() => {
      if (this.disposed) return
      this.counts.notifications++
      // The source has no per-key change signal. Refresh only demanded resident
      // keys; no enumeration of the replica or persisted preference namespace.
      for (const key of this.homes.keys()) this.pending.add(key)
      this.schedule()
    })
  }

  read(key: string): Loaded<PreferenceRow> {
    if (this.disposed) return LOADING
    const row = this.rows.get(key)
    if (row !== undefined) return row
    // Validate the declared routing home BEFORE touching the source.
    this.homes.set(key, declarePreference(key))
    this.pending.add(key)
    this.schedule()
    return LOADING
  }

  keys(): readonly string[] { return [...this.homes.keys()] }

  private schedule(): void {
    if (this.scheduled || this.disposed || !this.pending.size) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const keys = [...this.pending]
      this.pending.clear()
      this.counts.batches++
      // ui.get may finish the owner's one-shot legacy key migration and notify.
      // Keep that write in the existing owner, outside the MobX publish action.
      const loaded = keys.map((key): PreferenceRow => ({
        key, home: this.homes.get(key)!, value: this.ui.get(key),
      }))
      this.counts.loaded += loaded.length
      runInAction(() => {
        for (const row of loaded) {
          if (this.rows.get(row.key)?.value !== row.value) this.rows.set(row.key, row)
        }
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.pending.clear()
    this.homes.clear()
    runInAction(() => this.rows.clear())
  }
}
