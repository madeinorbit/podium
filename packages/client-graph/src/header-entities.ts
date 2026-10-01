import { compareStructural, observable, runInAction } from 'mobx'
import { HEADER_RELATIONS, HEADER_SCHEMA, type HeaderEntity, type HeaderRecord } from './header-schema'

/** Storage and metadata-driven edges owned by MobxPool, never a second runtime
 * or feed. Product reads call pool.row; get is the pool reader's storage seam. */
export function createHeaderEntities() {
  const tables = Object.fromEntries(Object.keys(HEADER_SCHEMA).map((entity) => [
    entity, observable.map<string, object>(undefined, { deep: false, name: `pool.${entity}` }),
  ])) as Record<HeaderEntity, ReturnType<typeof observable.map<string, object>>>
  const members = observable.map<string, readonly string[]>(undefined, { deep: false })
  const refs = new Map<string, string>()
  const sessionIds = observable.map<string, true>(undefined, { deep: false })

  function change(entity: string, id: string, next: object | undefined): void {
    if (entity === 'session') {
      if (next) sessionIds.set(id, true)
      else sessionIds.delete(id)
    }
    for (const relation of HEADER_RELATIONS) {
      if (relation.from !== entity) continue
      const address = `${entity}:${id}:${relation.name}`
      const previous = refs.get(address)
      const target = next && (next as Record<string, unknown>)[relation.key]
      const current = typeof target === 'string' && target ? target : undefined
      if (previous === current) continue
      if (previous) {
        const key = `${relation.to}:${previous}:${relation.inverse}`
        members.set(key, (members.get(key) ?? []).filter((member) => member !== id))
      }
      if (current) {
        const key = `${relation.to}:${current}:${relation.inverse}`
        members.set(key, [...(members.get(key) ?? []), id])
        refs.set(address, current)
      } else refs.delete(address)
    }
  }

  return {
    tables,
    sessionIds,
    get: (entity: HeaderEntity, id: string) => tables[entity].get(id),
    members: (entity: HeaderEntity, id: string, relation: string) => members.get(`${entity}:${id}:${relation}`) ?? [],
    change,
    apply(records: readonly HeaderRecord[]): void {
      runInAction(() => {
        for (const record of records) {
          const table = tables[record.kind]
          if (compareStructural(table.get(record.id), record.value)) continue
          if (record.value === undefined) table.delete(record.id)
          else table.set(record.id, record.value)
          change(record.kind, record.id, record.value)
        }
      })
    },
    clear(): void {
      for (const table of Object.values(tables)) table.clear()
      members.clear()
      refs.clear()
      sessionIds.clear()
    },
  }
}
