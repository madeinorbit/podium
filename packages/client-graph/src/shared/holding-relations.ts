/**
 * POD-7545 — HOLDING RELATIONS, DERIVED FROM THE DECLARATIONS (design
 * POD-7409 "Reading on-demand records through a model", step 1).
 *
 * A relation whose target is not on the device whenever its source is (the
 * target record type's group is on demand) is read through the target's own
 * collection for the source: reading it holds that collection instance while
 * the read is observed, asks the one loader for it when it is not complete,
 * and answers `LOADING` until it is. "Holding follows reading"
 * (`docs/design/POD-7157-device-storage-and-memory-design.md`): the read is
 * the request, and no screen asks for it by hand.
 *
 * Nothing here names a field. The pool's relation getters (`models.ts`
 * `installRelations`) ask {@link holdingInstanceOf} once per declared
 * relation; it reads the schema (the target entity, the inverse `belongsTo`
 * and its foreign key) and the record declaration of the target (its group,
 * `bodyOf`, and the collection keyed by that foreign key). The build check
 * (`relation-reads.ts`, POD-7547) reads the same derivation, so what it calls
 * a holding relation is what the pool holds.
 *
 * Two more holds come from the same declarations (POD-7582). A child relation
 * on the record's parent link, with no collection keyed by it, holds a tree
 * (the `descendantsOf` collection, which the pool's `collections.subtreeHeld`
 * reads): the complete tree of the source or of an ancestor when the device
 * has one, else the source's own subtree. A flight deck that holds its root's
 * tree, or a walk down it, holds one instance, not one per node. An incoming edge list holds the edge record's collection
 * keyed by its target, which comes with each edge's owning record.
 */
import {
  type Collection,
  clausesOf,
  isParam,
  POLICY_PARAMS,
  RECORDS,
  type RecordDeclaration,
  type RecordGroup,
} from '@podium/model'
import type { EdgeSpec, EntityName, ModelSchema } from './schema'
import type { LoaderInstance } from './source'

/**
 * The record groups whose records a relation read holds and loads: the
 * groups whose records are on the device only while something asks for them.
 * `body`: an issue's body parts arrive once the issue is opened. `byRule`
 * (POD-7547): issues, sessions and the history kinds arrive by the policy's
 * rules, so a to-many relation over them holds the target's collection keyed
 * by the relation's foreign key (`issue.sessions` holds `session.ofIssue`).
 * `windowed` is not here: its kinds have one where-less window and no keyed
 * collection to hold.
 */
// side-state: declaration: a fixed table, never written after module initialization
export const HOLDING_GROUPS: ReadonlySet<RecordGroup> = new Set<RecordGroup>(['body', 'byRule'])

/** The record declaration an entity's rows arrive from (its key field's `replica:` collection). */
export function recordOfEntity(
  schema: ModelSchema,
  entity: EntityName,
  records: readonly RecordDeclaration[] = RECORDS,
): RecordDeclaration | undefined {
  const spec = schema[entity]
  const arrives = spec.fields[spec.key]?.source.arrivesOn
  if (arrives === undefined || !arrives.startsWith('replica:')) return undefined
  const replicaKind = arrives.slice('replica:'.length)
  return records.find((record) => record.replicaKind === replicaKind)
}

/** The field a collection is keyed by, when its rule is one `{ field: { eq: param } }` test. */
export function keyedFieldOf(collection: Collection): string | undefined {
  if (collection.where === undefined) return undefined
  const [clause, ...more] = clausesOf(collection.where)
  if (clause === undefined || more.length > 0) return undefined
  const [field, ...others] = Object.keys(clause)
  if (field === undefined || others.length > 0) return undefined
  return keyParam(collection, field) === undefined ? undefined : field
}

/** The one instance argument a collection keyed by `field` names: `{ field: { eq: param } }`. */
export function keyParam(collection: Collection, field: string): string | undefined {
  if (collection.where === undefined) return undefined
  const [clause, ...more] = clausesOf(collection.where)
  if (clause === undefined || more.length > 0) return undefined
  const keys = Object.keys(clause)
  if (keys.length !== 1 || keys[0] !== field) return undefined
  const test = clause[field]
  if (typeof test !== 'object' || test === null || !('eq' in test)) return undefined
  const value = test.eq
  if (!isParam(value) || POLICY_PARAMS.has(value.param)) return undefined
  return value.param
}

/**
 * What reading a to-many relation over an on-demand kind holds, or why it
 * cannot hold anything: one keyed instance per source, or (`tree`) the tree
 * under the source, which `collections.subtreeHeld` holds (POD-7582).
 */
export type HoldingRead =
  | {
      readonly collection: string
      readonly instance: (owner: string) => LoaderInstance
    }
  | { readonly collection: string; readonly tree: true }
  | { readonly problem: string }

/**
 * POD-7595 — where a holding read stands: the device holds what it reads
 * (`held`), it is on its way (`loading`), or the server answered without
 * saying it is complete (`refused`). A refused read SETTLES: it is not held,
 * so no reader takes what happens to be in memory for the whole answer (an
 * empty list, a zero count, an empty description), and nothing is asked
 * again because it is read. A view that shows it says it is unavailable,
 * never loading. It is asked again only on a real trigger: the connection
 * returns, this viewer's access changes, or a view retries it
 * (`PoolCollections.retry`).
 */
export type Holding = 'held' | 'loading' | 'refused'

/** What a holding read asks of the pool's collections (`collections.ts`). */
export interface HoldingCollections {
  holding(spec: LoaderInstance): Holding
  subtreeHolding(id: string): Holding
}

/**
 * Where, for `owner`, all a holding relation reads stands: its instance, or
 * its tree, is held, on its way, or refused by the server (settled,
 * POD-7595). TRACKED like the reads it makes: the reader holds what it reads
 * while it reads it.
 */
export type HoldingCheck = (collections: HoldingCollections, owner: string) => Holding

/** The check a holding read makes, from the derivation. */
export function holdingCheckOf(read: HoldingRead): HoldingCheck | undefined {
  if ('instance' in read) return (collections, owner) => collections.holding(read.instance(owner))
  if ('tree' in read) return (collections, owner) => collections.subtreeHolding(owner)
  return undefined
}

/**
 * The collection of `record` that holds everything under one of its records
 * along `field`: `{ field: { descendantsOf: param } }` on the record's parent
 * link, the tree. A child is under its parent, so the tree its parent is in
 * holds every child.
 */
function treeCollectionOf(record: RecordDeclaration, field: string): Collection | undefined {
  if (record.parentLink !== field) return undefined
  for (const collection of Object.values(record.collections)) {
    if (collection.where === undefined) continue
    const [clause, ...more] = clausesOf(collection.where)
    if (clause === undefined || more.length > 0 || Object.keys(clause).length !== 1) continue
    const test = clause[field]
    if (typeof test === 'object' && test !== null && 'descendantsOf' in test) return collection
  }
  return undefined
}

/**
 * The edges into a source, read through the edge record's own collection:
 * an incoming `edge` relation reads the rows of `spec.to` whose edge list
 * names the source. The list arrives as records of their own (its field's
 * `replica:` source, the property naming the other endpoint), so the read
 * holds that record's one collection keyed by the property, which must come
 * with each edge's owner whole: the owner's row carries the list the
 * relation index reads.
 */
function incomingEdgeRead(
  schema: ModelSchema,
  spec: EdgeSpec,
  target: RecordDeclaration,
  declarations: readonly RecordDeclaration[],
): HoldingRead | undefined {
  if (!HOLDING_GROUPS.has(target.group)) return undefined
  const source = schema[spec.to].fields[spec.edgeField]?.source
  const arrives = source?.arrivesOn
  const property = source?.property
  let edges: RecordDeclaration | undefined
  if (arrives?.startsWith('replica:') === true) {
    const replicaKind = arrives.slice('replica:'.length)
    for (const declaration of declarations)
      if (declaration.replicaKind === replicaKind) edges = declaration
  }
  if (edges === undefined || property === undefined)
    return {
      problem: `${spec.to}.${spec.edgeField} does not arrive as records of their own, so nothing holds the edges into the source`,
    }
  const keyed: { collection: Collection; param: string }[] = []
  for (const collection of Object.values(edges.collections)) {
    const param = keyParam(collection, property)
    if (param !== undefined) keyed.push({ collection, param })
  }
  const [only, ...others] = keyed
  if (only === undefined || others.length > 0)
    return {
      problem: `${edges.kind} needs one collection keyed by ${property}, has ${keyed.length}`,
    }
  const { collection, param } = only
  // The target's collections by id: a fixed declaration table, read once per derivation.
  const targetCollections = new Map<string, Collection>()
  for (const each of Object.values(target.collections)) targetCollections.set(each.id, each)
  let bringsOwners = false
  for (const entry of collection.comesWith ?? []) {
    const along = targetCollections.get(entry.collection)
    if (
      along !== undefined &&
      keyedFieldOf(along) === target.key &&
      entry.key !== undefined &&
      entry.key !== property &&
      edges.links[entry.key]?.to === target.kind &&
      entry.where === undefined
    )
      bringsOwners = true
  }
  if (!bringsOwners)
    return {
      problem: `${collection.id} must come with the ${target.kind} of each edge, whose ${spec.edgeField} list the relation reads`,
    }
  return {
    collection: collection.id,
    instance: (owner) => ({
      collection: collection.id,
      args: { [param]: owner },
      part: collection.part,
    }),
  }
}

/**
 * The collection a read of `from.relation` holds for its source, from the
 * declarations: the target kind's one collection keyed by the inverse
 * `belongsTo`'s foreign key. Undefined when the relation is not to-many or
 * its target kind is not in a holding group. A `problem` when it is, but the
 * declarations give it nothing to hold: such a relation could only read what
 * happens to be in memory.
 */
export function holdingReadOf(
  schema: ModelSchema,
  from: EntityName,
  relation: string,
  records: readonly RecordDeclaration[] = RECORDS,
): HoldingRead | undefined {
  const spec = schema[from].relations[relation]
  if (
    spec === undefined ||
    (spec.kind !== 'hasMany' && !(spec.kind === 'edge' && spec.direction === 'in'))
  )
    return undefined
  const record = recordOfEntity(schema, spec.to, records)
  if (spec.kind === 'edge')
    return record === undefined ? undefined : incomingEdgeRead(schema, spec, record, records)
  if (record === undefined || !HOLDING_GROUPS.has(record.group)) return undefined
  const back = schema[spec.to].relations[spec.inverse]
  if (back?.kind !== 'belongsTo' || back.targetKey !== schema[from].key)
    return {
      problem: `${record.kind} (group ${record.group}) is held only through the inverse of a belongsTo on the source key`,
    }
  const source = recordOfEntity(schema, from, records)
  if (record.group === 'body' && record.bodyOf !== source?.kind)
    return { problem: `${record.kind} is the body of ${record.bodyOf}, not of ${source?.kind}` }
  const keyed: { collection: Collection; param: string }[] = []
  for (const collection of Object.values(record.collections)) {
    const param = keyParam(collection, back.foreignKey)
    if (param !== undefined) keyed.push({ collection, param })
  }
  const [only, ...others] = keyed
  if (only === undefined) {
    const tree = treeCollectionOf(record, back.foreignKey)
    if (tree !== undefined && record.kind === source?.kind)
      return { collection: tree.id, tree: true }
  }
  if (only === undefined || others.length > 0)
    return {
      problem: `${record.kind} (group ${record.group}) needs one collection keyed by ${back.foreignKey}, has ${keyed.length}`,
    }
  const { collection, param } = only
  return {
    collection: collection.id,
    instance: (owner) => ({
      collection: collection.id,
      args: { [param]: owner },
      part: collection.part,
    }),
  }
}

/**
 * The collection instance reading `from.relation` holds for a source id, or
 * undefined when it holds none or holds a tree. Throws on a body relation
 * the declarations give nothing to hold (a body is only ever read this way).
 * A `byRule` relation with nothing to hold reads what is in memory; the
 * build check (`relation-reads.ts`) fails on it unless it is listed there
 * with its reason, or declares that it reads what the policy holds.
 */
export function holdingInstanceOf(
  schema: ModelSchema,
  from: EntityName,
  relation: string,
): ((owner: string) => LoaderInstance) | undefined {
  const read = holdingReadOf(schema, from, relation)
  if (read === undefined) return undefined
  if ('instance' in read) return read.instance
  if ('tree' in read) return undefined
  if (recordOfEntity(schema, schema[from].relations[relation]!.to)?.group === 'body')
    throw new Error(`[pool] ${from}.${relation}: ${read.problem}`)
  return undefined
}

/** What the pool's relation getter asks before it answers a holding relation's members. */
export function holdingCheckFor(
  schema: ModelSchema,
  from: EntityName,
  relation: string,
): HoldingCheck | undefined {
  // Throws on a body relation with nothing to hold, as above.
  holdingInstanceOf(schema, from, relation)
  const read = holdingReadOf(schema, from, relation)
  return read === undefined ? undefined : holdingCheckOf(read)
}
