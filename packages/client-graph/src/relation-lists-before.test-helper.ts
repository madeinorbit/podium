// Frozen pre-POD-5864 readers: answer parity, never imported by production.
import { omitGone } from './lookup'
import type { EntityModel, LazyCollection, ModelHost } from './models'
import type { RelationQueries } from './shared/relation-index'
import { SCHEMA, type EntityName } from './shared/schema'
import { machinePathKey } from '@podium/model/browser'
import { LOADING } from './loading'

class TrackedIdsBefore implements Iterable<string> {
  constructor(private readonly read: () => ReadonlySet<string>) {}
  [Symbol.iterator](): Iterator<string> { return this.read()[Symbol.iterator]() }
}

export function manyBefore(index: RelationQueries, from: EntityName, id: string, relation: string): Iterable<string> {
  const spec = SCHEMA[from].relations[relation]!
  return new TrackedIdsBefore(() => spec.kind === 'edge' && spec.direction === 'out'
    ? index.targets(from, machinePathKey(id), relation)
    : index.members(from, machinePathKey(id), relation))
}
export function subsetBefore(index: RelationQueries, from: EntityName, id: string, relation: string, subset: string): Iterable<string> {
  return new TrackedIdsBefore(() => index.subset(from, id, relation, subset))
}

export class ModelCollectionBefore implements LazyCollection<EntityModel> {
  private read: { readonly ready: readonly EntityModel[]; readonly loading: number } | null = null
  constructor(
    readonly host: ModelHost,
    private readonly to: EntityName,
    readonly owner: string,
    private readonly members: () => Iterable<string>,
  ) {}
  get ready(): readonly EntityModel[] { return this.settle().ready }
  get loading(): number { return this.settle().loading }
  private settle(): { readonly ready: readonly EntityModel[]; readonly loading: number } {
    if (this.read !== null) return this.read
    const ready: EntityModel[] = []
    let loading = 0
    for (const id of this.members()) {
      const found = omitGone(this.host.model(this.to, id)) ?? null
      if (found === LOADING) loading += 1
      else if (found !== null) ready.push(found)
    }
    this.read = { ready, loading }
    return this.read
  }
}
