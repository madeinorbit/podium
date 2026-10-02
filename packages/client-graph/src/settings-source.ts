import { compareStructural, observable, runInAction } from 'mobx'
import type { Store } from '@podium/client-core/engine'
import { settingsRepositoryId, type SettingsEntity, type SettingsRows } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export interface SettingsOwner {
  getSnapshot(): Pick<Store, 'machines' | 'repos' | 'settingsTab'>
  subscribe(wake: () => void): () => void
}

/** A read-only source on the existing engine. The first demand batches the
 * catalog and window together. Publications borrow engine rows only when that
 * engine array moved; session history is supplied by the pool, not this port. */
export class SettingsSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private scheduled = false
  private demanded = false
  private disposed = false
  private readonly unsubscribe: () => void
  private machines: Store['machines'] | undefined
  private repos: Store['repos'] | undefined
  private readonly loaded = observable.box(false)

  constructor(private readonly owner: SettingsOwner) {
    this.unsubscribe = owner.subscribe(() => { if (this.demanded) this.schedule() })
  }

  read(entity: SettingsEntity, id: string): Loaded<SettingsRows[SettingsEntity]> {
    if (this.disposed) return LOADING
    this.demanded = true
    if (!this.loaded.get()) { this.schedule(); return LOADING }
    return this.rows.get(`${entity}:${id}`) as SettingsRows[SettingsEntity] | undefined
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const state = this.owner.getSnapshot()
      runInAction(() => {
        if (this.machines !== state.machines || this.repos !== state.repos) {
          this.machines = state.machines
          this.repos = state.repos
          const next = new Map<string, object>()
          for (const machine of state.machines) next.set(`settingsMachine:${machine.id}`, machine)
          for (const repo of state.repos) next.set(`settingsRepository:${settingsRepositoryId(repo)}`, repo)
          next.set('settingsCatalog:catalog', {
            machines: state.machines.map((machine) => machine.id),
            repositories: state.repos.map(settingsRepositoryId),
          })
          for (const key of this.rows.keys()) if (key !== 'settingsWindow:window' && !next.has(key)) this.rows.delete(key)
          for (const [key, value] of next) if (!compareStructural(this.rows.get(key), value)) this.rows.set(key, value)
        }
        const window = { settingsTab: state.settingsTab }
        if (!compareStructural(this.rows.get('settingsWindow:window'), window)) this.rows.set('settingsWindow:window', window)
        this.loaded.set(true)
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.machines = undefined
    this.repos = undefined
    // Detach during provider render; release observable rows after render.
    queueMicrotask(() => runInAction(() => { this.rows.clear(); this.loaded.set(false) }))
  }
}
