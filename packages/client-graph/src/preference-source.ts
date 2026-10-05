import type { RoutedUiState } from '@podium/client-core/ui-state'
import { createAtom, type IAtom, runInAction } from 'mobx'
import { declarePreference, type PreferenceRow } from './preference-schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** Read-only pool storage. Only MobxPool.row calls read; the runtime's routed UI
 * port retains hydration, optimism, rollback, rescope and write ownership. */
export class PreferenceSource {
  private readonly rows = new Map<string, PreferenceRow>()
  private readonly atoms = new Map<string, IAtom>()
  private readonly pending = new Set<string>()
  private readonly refreshing = new Set<string>()
  private readonly homes = new Map<string, PreferenceRow['home']>()
  private scheduled = false
  private disposed = false
  private readonly unsubscribe: () => void
  readonly counts = { batches: 0, loaded: 0, notifications: 0 }

  constructor(private readonly ui: RoutedUiState) {
    this.unsubscribe = ui.subscribe((keys) => {
      if (this.disposed) return
      this.counts.notifications++
      for (const key of keys) {
        if (!this.homes.has(key) || this.refreshing.has(key)) continue
        this.pending.add(key)
      }
      this.schedule()
    })
  }

  read(key: string): Loaded<PreferenceRow> {
    if (this.disposed) return LOADING
    // Validate the routing home before either observing or reading the owner.
    if (!this.homes.has(key)) this.homes.set(key, declarePreference(key))
    let atom = this.atoms.get(key)
    if (!atom) {
      atom = createAtom(`preference:${key}`, undefined, () => {
        this.atoms.delete(key)
        this.rows.delete(key)
        this.homes.delete(key)
        this.pending.delete(key)
      })
    }
    if (atom.reportObserved()) this.atoms.set(key, atom)
    const row = this.rows.get(key)
    if (row !== undefined) return row
    this.pending.add(key)
    this.schedule()
    return LOADING
  }

  keys(): readonly string[] {
    return [...this.homes.keys()]
  }

  private load(key: string): PreferenceRow | undefined {
    const home = this.homes.get(key)
    if (home === undefined || this.disposed) return undefined
    this.refreshing.add(key)
    let value: string | null
    try {
      value = this.ui.get(key)
    } finally {
      this.refreshing.delete(key)
    }
    this.counts.loaded++
    return { key, home, value }
  }

  private publish(loaded: readonly PreferenceRow[]): void {
    runInAction(() => {
      for (const row of loaded) {
        const previous = this.rows.get(row.key)
        if (previous && previous.value === row.value) continue
        this.rows.set(row.key, row)
        this.atoms.get(row.key)?.reportChanged()
      }
    })
  }

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
      this.publish(keys.flatMap((key) => this.load(key) ?? []))
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.pending.clear()
    this.homes.clear()
    this.rows.clear()
    // Principal teardown can run inside StoreProvider's render. Detach and
    // refuse reads immediately, then notify obsolete projections after render.
    queueMicrotask(() =>
      runInAction(() => {
        for (const atom of this.atoms.values()) atom.reportChanged()
        this.atoms.clear()
      }),
    )
  }
}
