import { compareStructural, observable, runInAction } from 'mobx'
import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import type { SettingsEntity, SettingsRows } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export type SettingsOwner = Pick<ClientRuntime, 'readLocal' | 'onLocals' | 'onList' | 'listIds' | 'listRow'>

type Discovery = 'machines' | 'repos'
const ENTITY = { machines: 'settingsMachine', repos: 'settingsRepository' } as const

/** A read-only source on the existing engine. The first demand batches the
 * catalog and window together. Keyed (POD-5433): machines and repos arrive by
 * id, so a publication rewrites only the rows that changed; the window wakes
 * on `settingsTab` alone. Session history is supplied by the pool, not here. */
export class SettingsSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private scheduled = false
  private demanded = false
  private disposed = false
  private readonly stops: (() => void)[]
  /** Ids per list to rewrite at the next drain; null = the whole list. */
  private readonly dirty: Record<Discovery, Set<string> | null> = { machines: null, repos: null }
  private orderDirty = true
  private windowDirty = true
  private readonly loaded = observable.box(false)

  constructor(private readonly owner: SettingsOwner) {
    const list = (name: Discovery) => (change: KeyedListChange) => {
      const ids = this.dirty[name]
      if (ids !== null) for (const id of change.ids) ids.add(id)
      if (change.order) this.orderDirty = true
      if (this.demanded) this.schedule()
    }
    this.stops = [
      owner.onList('machines', list('machines')),
      owner.onList('repos', list('repos')),
      owner.onLocals(['settingsTab'], () => {
        this.windowDirty = true
        if (this.demanded) this.schedule()
      }),
    ]
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
      runInAction(() => {
        for (const name of ['machines', 'repos'] as const) {
          const pending = this.dirty[name]
          this.dirty[name] = new Set()
          if (pending === null) this.orderDirty = true
          const ids = pending ?? this.owner.listIds(name)
          const known = new Set(this.owner.listIds(name))
          for (const id of ids) {
            const key = `${ENTITY[name]}:${id}`, value = known.has(id) ? this.owner.listRow(name, id) : undefined
            if (value === undefined) this.rows.delete(key)
            else if (!compareStructural(this.rows.get(key), value)) this.rows.set(key, value)
          }
        }
        if (this.orderDirty) {
          this.orderDirty = false
          const catalog = { machines: [...this.owner.listIds('machines')], repositories: [...this.owner.listIds('repos')] }
          if (!compareStructural(this.rows.get('settingsCatalog:catalog'), catalog)) this.rows.set('settingsCatalog:catalog', catalog)
        }
        if (this.windowDirty) {
          this.windowDirty = false
          const window = { settingsTab: this.owner.readLocal('settingsTab') }
          if (!compareStructural(this.rows.get('settingsWindow:window'), window)) this.rows.set('settingsWindow:window', window)
        }
        this.loaded.set(true)
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    // Detach during provider render; release observable rows after render.
    queueMicrotask(() => runInAction(() => { this.rows.clear(); this.loaded.set(false) }))
  }
}
