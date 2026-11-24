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
import type { EntityName, ModelSchema } from './schema'
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

/** What reading a to-many relation over an on-demand kind holds, or why it cannot hold anything. */
export type HoldingRead =
  | {
      readonly collection: string
      readonly instance: (owner: string) => LoaderInstance
    }
  | { readonly problem: string }

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
  if (spec?.kind !== 'hasMany') return undefined
  const record = recordOfEntity(schema, spec.to, records)
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
 * undefined when it holds none. Throws on a body relation the declarations
 * give nothing to hold (a body is only ever read this way). A `byRule`
 * relation with nothing to hold reads what is in memory; the build check
 * (`relation-reads.ts`) fails on it unless it is listed there with its reason.
 */
export function holdingInstanceOf(
  schema: ModelSchema,
  from: EntityName,
  relation: string,
): ((owner: string) => LoaderInstance) | undefined {
  const read = holdingReadOf(schema, from, relation)
  if (read === undefined) return undefined
  if ('instance' in read) return read.instance
  if (recordOfEntity(schema, schema[from].relations[relation]!.to)?.group === 'body')
    throw new Error(`[pool] ${from}.${relation}: ${read.problem}`)
  return undefined
}
