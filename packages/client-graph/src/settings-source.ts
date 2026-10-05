import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import {
  compareStructural, observable, onBecomeObserved, onBecomeUnobserved,
  runInAction, type IObservableValue,
} from 'mobx'
import type { SettingsEntity, SettingsRows } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export type SettingsOwner = Pick<ClientRuntime, 'readLocal' | 'onLocals' | 'onList' | 'listIds' | 'listRow'>

type Discovery = 'machines' | 'repos'
const ENTITY = { machines: 'settingsMachine', repos: 'settingsRepository' } as const
type Reading = Loaded<SettingsRows[SettingsEntity]>
type Entry = {
  entity: SettingsEntity
  id: string
  value: IObservableValue<Reading>
  loaded: boolean
  observed: boolean
  release: () => void
}

/** Declared source rows load independently. Catalog demand names ids only;
 * named row and window demand never installs the other discovery payloads.
 * Observed rows follow their keys, and release their channel on unmount. */
export class SettingsSource {
  private readonly rows = new Map<string, Entry>()
  private readonly pending = new Set<string>()
  private readonly lists = new Map<Discovery, { readers: number; stop: () => void }>()
  private window: { readers: number; stop: () => void } | undefined
  private scheduled = false
  private disposed = false

  constructor(private readonly owner: SettingsOwner) {}

  read(entity: SettingsEntity, id: string): Reading {
    if (this.disposed) return LOADING
    const key = `${entity}:${id}`
    let entry = this.rows.get(key)
    if (!entry) {
      const value = observable.box<Reading>(LOADING, { deep: false, name: `settingsSource.${key}` })
      entry = { entity, id, value, loaded: false, observed: false, release: () => {} }
      const current = entry
      onBecomeObserved(value, () => {
        current.observed = true
        current.release = this.follow(current)
      })
      onBecomeUnobserved(value, () => {
        current.observed = false
        current.release()
        current.release = () => {}
        if (this.rows.get(key) === current) this.rows.delete(key)
        this.pending.delete(key)
      })
      this.rows.set(key, entry)
      this.pending.add(key)
      this.schedule()
    } else if (entry.loaded && !entry.observed) {
      // An imperative question has no subscriber to keep its value current.
      // Read that address again, rather than subscribing an invisible row.
      const current = entry
      runInAction(() => this.load(current))
    }
    return entry.value.get()
  }

  private follow(entry: Entry): () => void {
    switch (entry.entity) {
      case 'settingsMachine': return this.followList('machines')
      case 'settingsRepository': return this.followList('repos')
      case 'settingsCatalog': {
        if (entry.id !== 'catalog') return () => {}
        const machine = this.followList('machines'), repo = this.followList('repos')
        return () => { machine(); repo() }
      }
      case 'settingsWindow': {
        if (entry.id !== 'window') return () => {}
        this.window ??= { readers: 0, stop: this.owner.onLocals(['settingsTab'], () => {
          this.pending.add('settingsWindow:window')
          this.schedule()
        }) }
        this.window.readers++
        return () => {
          if (this.window && --this.window.readers === 0) {
            this.window.stop()
            this.window = undefined
          }
        }
      }
    }
  }

  private followList(name: Discovery): () => void {
    let list = this.lists.get(name)
    if (!list) {
      list = { readers: 0, stop: this.owner.onList(name, change => this.changed(name, change)) }
      this.lists.set(name, list)
    }
    list.readers++
    const current = list
    return () => {
      if (--current.readers === 0) {
        current.stop()
        this.lists.delete(name)
      }
    }
  }

  private changed(name: Discovery, change: KeyedListChange): void {
    for (const id of change.ids) {
      const key = `${ENTITY[name]}:${id}`
      if (this.rows.get(key)?.observed) this.pending.add(key)
    }
    if (change.order && this.rows.get('settingsCatalog:catalog')?.observed)
      this.pending.add('settingsCatalog:catalog')
    if (this.pending.size) this.schedule()
  }

  private load(entry: Entry): void {
    let next: Reading
    switch (entry.entity) {
      case 'settingsMachine': next = this.owner.listRow('machines', entry.id); break
      case 'settingsRepository': next = this.owner.listRow('repos', entry.id); break
      case 'settingsCatalog': next = entry.id === 'catalog'
        ? { machines: this.owner.listIds('machines'), repositories: this.owner.listIds('repos') }
        : undefined; break
      case 'settingsWindow': next = entry.id === 'window'
        ? { settingsTab: this.owner.readLocal('settingsTab') }
        : undefined; break
    }
    if (!compareStructural(entry.value.get(), next)) entry.value.set(next)
    entry.loaded = true
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      runInAction(() => {
        const keys = [...this.pending]
        this.pending.clear()
        for (const key of keys) {
          const entry = this.rows.get(key)
          if (entry) this.load(entry)
        }
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const entries = [...this.rows.values()]
    for (const entry of entries) {
      entry.release()
      entry.release = () => {}
    }
    this.window = undefined
    this.rows.clear()
    this.pending.clear()
    queueMicrotask(() => runInAction(() => {
      for (const entry of entries) entry.value.set(LOADING)
    }))
  }
}
