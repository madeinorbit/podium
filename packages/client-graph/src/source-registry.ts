import type { SettingsRows } from './settings-schema'
import { observable, runInAction } from 'mobx'
import type { EntityName } from './shared/schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** Screen modules extend this interface with their declared row types. The
 * pool reader and lifecycle stay fixed as new sources are registered. */
export interface PoolSourceRows extends SettingsRows {}
export type SourceEntity = keyof PoolSourceRows
export type PoolSummaryFields = Partial<Record<EntityName, readonly string[]>>
/** Declarations compose before the first ingest. Only named fields enter the
 * cold summary; a declaration never stores or indexes the full source row. */
export function mergePoolSummaries(...declarations: readonly PoolSummaryFields[]): PoolSummaryFields {
  const fields: PoolSummaryFields = {}
  for (const declaration of declarations) for (const entity of Object.keys(declaration) as EntityName[]) {
    fields[entity] = [...new Set([...(fields[entity] ?? []), ...(declaration[entity] ?? [])])]
  }
  return fields
}
export interface PoolSource<E extends SourceEntity> {
  read<K extends E>(entity: K, id: string): Loaded<PoolSourceRows[K]>
  related?(entity: string, id: string, name: string): readonly string[]
  dispose(): void
}

/** One registry per existing pool; it owns read-side sources, never mutations.
 * Registration is atomic and a source is disposed once even with many kinds. */
export class PoolSources {
  private readonly byEntity = observable.map<SourceEntity, PoolSource<SourceEntity>>(undefined, { deep: false })
  private readonly views = new Map<string, object>()
  private disposed = false

  register<E extends SourceEntity>(entities: readonly E[], source: PoolSource<E>): void {
    if (this.disposed || new Set(entities).size !== entities.length ||
      entities.some(entity => this.byEntity.has(entity))) {
      source.dispose()
      throw new Error('Pool source registration conflicts with its owner')
    }
    runInAction(() => {
      for (const entity of entities) this.byEntity.set(entity, source as PoolSource<SourceEntity>)
    })
  }

  read<E extends SourceEntity>(entity: E, id: string): Loaded<PoolSourceRows[E]> {
    if (this.disposed) return LOADING
    const source = this.byEntity.get(entity)
    return source ? source.read(entity, id) : LOADING
  }

  related(entity: SourceEntity, id: string, name: string): readonly string[] {
    return this.byEntity.get(entity)?.related?.(entity, id, name) ?? []
  }

  view<T extends object>(key: string, create: () => T): T {
    if (this.disposed) return create()
    let value = this.views.get(key)
    if (!value) { value = create(); this.views.set(key, value) }
    return value as T
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const source of new Set(this.byEntity.values())) source.dispose()
    for (const view of this.views.values()) {
      const dispose = Reflect.get(view, 'dispose')
      if (typeof dispose === 'function') dispose()
    }
    this.views.clear()
    queueMicrotask(() => runInAction(() => this.byEntity.clear()))
  }
}
