import type { MobxPool } from './pool'
import { defineSource } from './source-registry'
import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import { createDemandAtoms } from '@podium/mobx-helpers'
import { compareStructural, runInAction } from 'mobx'
import { isSettingsEntity, SETTINGS_SCHEMA, type SettingsEntity, type SettingsRows } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export type SettingsOwner = Pick<
  ClientRuntime,
  'readLocal' | 'onLocals' | 'onList' | 'listIds' | 'listRow'
>

type Discovery = 'machines' | 'repos'
const ENTITY = { machines: 'settingsMachine', repos: 'settingsRepository' } as const
type Reading = Loaded<SettingsRows[SettingsEntity]>
type Entry = {
  entity: SettingsEntity
  id: string
  value: Reading
  release: () => void
}

/** Declared source rows load independently. Catalog demand names ids only;
 * named row and window demand never installs the other discovery payloads.
 * Observed rows follow their keys, and release their channel on unmount. */
export class SettingsSource {
  private stopMachines: (() => void) | undefined
  private readonly rows = new Map<string, Entry>()
  private readonly atoms = createDemandAtoms<string>((key) => `settingsSource.${key}`, {
    onObserved: (key) => {
      const at = key.indexOf(':')
      const entry: Entry = { entity: key.slice(0, at) as SettingsEntity, id: key.slice(at + 1), value: LOADING, release: () => {} }
      this.rows.set(key, entry)
      entry.release = this.follow(entry)
      this.pending.add(key)
      this.schedule()
    },
    onUnobserved: (key) => {
      this.rows.get(key)?.release()
      this.rows.delete(key)
      this.pending.delete(key)
    },
  })
  private readonly pending = new Set<string>()
  private readonly lists = new Map<Discovery, { readers: number; stop: () => void }>()
  private window: { readers: number; stop: () => void } | undefined
  private readonly source = defineSource({
    readById: this.readById.bind(this),
    refresh: this.refresh.bind(this),
    release: this.release.bind(this),
  })
  private get disposed(): boolean { return this.source.disposed }

  constructor(private readonly owner: SettingsOwner, private readonly followMachines = true) {}

  /** A settings-only host has no header attachment to supply live machine
   * detail. Feed it through the same applying path and generic table. */
  attach(pool: MobxPool): void {
    if (!this.followMachines || this.stopMachines) return
    const install = (change?: KeyedListChange) => {
      const ids = change === undefined ? this.owner.listIds('machines') : [...change.ids]
      pool.ingestLiveMachines(ids.map(id => ({ id, value: this.owner.listRow('machines', id) })))
    }
    install()
    this.stopMachines = this.owner.onList('machines', install)
  }

  read(entity: SettingsEntity, id: string): Reading {
    return this.source.read(entity, id) as Reading
  }

  private readById(entity: SettingsEntity, id: string): Reading {
    // Imperative questions read the runtime's existing keyed inputs directly;
    // only an observed question needs a stored source row and subscription.
    const key = `${entity}:${id}`
    if (!this.atoms.observe(key)) return this.lookup(entity, id)
    return this.rows.get(key)!.value
  }

  private follow(entry: Entry): () => void {
    switch (entry.entity) {
      case 'settingsMachine':
        return this.followList('machines')
      case 'settingsRepository':
        return this.followList('repos')
      case 'settingsCatalog': {
        if (entry.id !== 'catalog') return () => {}
        const machine = this.followList('machines'),
          repo = this.followList('repos')
        return () => {
          machine()
          repo()
        }
      }
      case 'settingsWindow': {
        if (entry.id !== 'window') return () => {}
        this.window ??= {
          readers: 0,
          stop: this.owner.onLocals(['settingsTab'], () => {
            this.pending.add('settingsWindow:window')
            this.schedule()
          }),
        }
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
      list = { readers: 0, stop: this.owner.onList(name, (change) => this.changed(name, change)) }
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
      if (this.rows.has(key)) this.pending.add(key)
    }
    if (change.order && this.rows.has('settingsCatalog:catalog'))
      this.pending.add('settingsCatalog:catalog')
    if (this.pending.size) this.schedule()
  }

  private lookup(entity: SettingsEntity, id: string): Reading {
    switch (entity) {
      case 'settingsMachine':
        return this.owner.listRow('machines', id)
      case 'settingsRepository':
        return this.owner.listRow('repos', id)
      case 'settingsCatalog':
        return id === 'catalog'
          ? { machines: this.owner.listIds('machines'), repositories: this.owner.listIds('repos') }
          : undefined
      case 'settingsWindow':
        return id === 'window' ? { settingsTab: this.owner.readLocal('settingsTab') } : undefined
    }
  }

  private load(entry: Entry): void {
    const next = this.lookup(entry.entity, entry.id)
    if (compareStructural(entry.value, next)) return
    entry.value = next
    this.atoms.get(`${entry.entity}:${entry.id}`)?.reportChanged()
  }

  private schedule(): void {
    this.source.schedule()
  }

  private refresh(): void {
    runInAction(() => {
      const keys = [...this.pending]
      this.pending.clear()
      for (const key of keys) {
        const entry = this.rows.get(key)
        if (entry) this.load(entry)
      }
    })
  }

  dispose(): void {
    this.source.dispose()
  }

  private release(): void {
    this.stopMachines?.()
    this.stopMachines = undefined
    const entries = [...this.rows.values()]
    const atoms = [...this.atoms.values()]
    for (const entry of entries) {
      entry.release()
      entry.release = () => {}
    }
    this.window = undefined
    this.atoms.clear()
    this.rows.clear()
    this.pending.clear()
    queueMicrotask(() =>
      runInAction(() => {
        for (const atom of atoms) atom.reportChanged()
      }),
    )
  }
}

/** Settings owns its source declaration and factory; the pool only registers it. */
export function attachSettingsSource(pool: MobxPool, owner: SettingsOwner, followMachines = true): void {
  pool.sources.register(Object.keys(SETTINGS_SCHEMA).filter(isSettingsEntity), new SettingsSource(owner, followMachines))
}
