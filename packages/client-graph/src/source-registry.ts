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
  read(entity: E, id: string): Loaded<PoolSourceRows[E]>
  related?(entity: string, id: string, name: string): readonly string[]
  dispose(): void
}

/** The common read/lifecycle frame. Adapters declare their read and refresh
 * policies; the frame coalesces wakes, cancels queued work at teardown, and
 * releases the owner once. Refresh owns its existing publication action so
 * runtime reads and effects keep their original transaction boundary. */
export function defineSource<Args extends [unknown?, unknown?], Row>(definition: {
  readById: (...args: Args) => Loaded<Row>
  refresh?: () => void
  release: () => void
  disposedValue?: Loaded<Row>
}) {
  let scheduled = false, disposed = false
  // Source readers take at most two keys. Preserve their typed arity without
  // allocating or iterating a rest-argument array on every row read.
  const read = (key: Args[0], id: Args[1]): Loaded<Row> => {
    if (disposed) return Object.hasOwn(definition, 'disposedValue') ? definition.disposedValue : LOADING
    const readById = definition.readById as (key: Args[0], id: Args[1]) => Loaded<Row>
    return readById(key, id)
  }
  return {
    get disposed(): boolean { return disposed },
    read: read as (...args: Args) => Loaded<Row>,
    schedule(): void {
      if (scheduled || disposed || !definition.refresh) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (!disposed) definition.refresh!()
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      definition.release()
    },
  }
}

/** One registry per existing pool; it owns read-side sources, never mutations.
 * Registration is atomic and a source is disposed once even with many kinds. */
export class PoolSources {
  private readonly byEntity = observable.map<SourceEntity, PoolSource<SourceEntity>>(undefined, { deep: false })
  private readonly views = new Map<string, object>()
  private readonly owners = new Map<SourceEntity, string>()
  private readonly ensured = new Map<string, { entities: readonly SourceEntity[]; promise: Promise<PoolSource<SourceEntity>> }>()
  private disposed = false

  register<E extends SourceEntity>(entities: readonly E[], source: PoolSource<E>): void {
    this.install(entities, source)
  }

  /** A source's fixed key owns its entity set, including while its lazy factory
   * is pending. All screens share the same promise and the same source. */
  ensure<E extends SourceEntity>(key: string, entities: readonly E[], create: () => PoolSource<E> | Promise<PoolSource<E>>): Promise<PoolSource<E>> {
    if (this.disposed || new Set(entities).size !== entities.length) throw new Error('Pool source registration conflicts with its owner')
    const existing = this.ensured.get(key)
    if (existing) {
      if (entities.length !== existing.entities.length || entities.some(entity => !existing.entities.includes(entity))) {
        throw new Error('Pool source key has a different entity declaration')
      }
      return existing.promise as Promise<PoolSource<E>>
    }
    if (entities.some(entity => this.byEntity.has(entity) || this.owners.has(entity))) {
      throw new Error('Pool source registration conflicts with its owner')
    }
    for (const entity of entities) this.owners.set(entity, key)
    const promise = Promise.resolve().then(() => {
      if (this.disposed) throw new Error('Pool source registry disposed before creation')
      return create()
    }).then(source => {
      this.install(entities, source, key)
      return source
    }).catch(cause => {
      this.ensured.delete(key)
      for (const entity of entities) if (this.owners.get(entity) === key) this.owners.delete(entity)
      throw cause
    })
    this.ensured.set(key, { entities: [...entities], promise: promise as Promise<PoolSource<SourceEntity>> })
    return promise
  }

  private install<E extends SourceEntity>(entities: readonly E[], source: PoolSource<E>, key?: string): void {
    if (this.disposed || new Set(entities).size !== entities.length ||
      entities.some(entity => this.byEntity.has(entity) || (this.owners.has(entity) && this.owners.get(entity) !== key))) {
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
    return source ? source.read(entity, id) as Loaded<PoolSourceRows[E]> : LOADING
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
    runInAction(() => {
      this.disposed = true
      for (const source of new Set(this.byEntity.values())) source.dispose()
      for (const view of this.views.values()) {
        const dispose = Reflect.get(view, 'dispose')
        if (typeof dispose === 'function') dispose()
      }
      this.views.clear()
      this.ensured.clear()
      this.owners.clear()
    })
    queueMicrotask(() => runInAction(() => this.byEntity.clear()))
  }
}
