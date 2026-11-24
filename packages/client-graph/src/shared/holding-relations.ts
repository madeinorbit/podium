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
 * `bodyOf`, and the collection keyed by that foreign key).
 */
import {
  type Collection,
  clausesOf,
  isParam,
  POLICY_PARAMS,
  type RecordDeclaration,
  type RecordGroup,
  recordOfReplicaKind,
} from '@podium/model'
import type { EntityName, ModelSchema } from './schema'
import type { LoaderInstance } from './source'

/**
 * The record groups whose records a relation read holds and loads. `body` is
 * on: an issue's body parts are on the device only once the issue is opened.
 * `windowed` and `byRule` are on demand too and take the same path once their
 * relations are checked (POD-7547); adding one here is all it takes.
 */
// side-state: declaration: a fixed table, never written after module initialization
export const HOLDING_GROUPS: ReadonlySet<RecordGroup> = new Set<RecordGroup>(['body'])

/** The record declaration an entity's rows arrive from (its key field's `replica:` collection). */
export function recordOfEntity(
  schema: ModelSchema,
  entity: EntityName,
): RecordDeclaration | undefined {
  const spec = schema[entity]
  const arrives = spec.fields[spec.key]?.source.arrivesOn
  if (arrives === undefined || !arrives.startsWith('replica:')) return undefined
  return recordOfReplicaKind(arrives.slice('replica:'.length))
}

/** The one instance argument a collection keyed by `field` names: `{ field: { eq: param } }`. */
function keyParam(collection: Collection, field: string): string | undefined {
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
 * The collection instance reading `from.relation` holds for a source id, or
 * undefined when the relation's target is on the device whenever its source
 * is. Throws on a declaration that puts the target in a holding group without
 * a collection keyed by the relation's foreign key: such a relation could
 * only read what happens to be in memory.
 */
export function holdingInstanceOf(
  schema: ModelSchema,
  from: EntityName,
  relation: string,
): ((owner: string) => LoaderInstance) | undefined {
  const spec = schema[from].relations[relation]
  if (spec?.kind !== 'hasMany') return undefined
  const record = recordOfEntity(schema, spec.to)
  if (record === undefined || !HOLDING_GROUPS.has(record.group)) return undefined
  const here = `[pool] ${from}.${relation}`
  const back = schema[spec.to].relations[spec.inverse]
  if (back?.kind !== 'belongsTo' || back.targetKey !== schema[from].key)
    throw new Error(`${here}: a holding relation is the inverse of a belongsTo on the source key`)
  const source = recordOfEntity(schema, from)
  if (record.group === 'body' && record.bodyOf !== source?.kind)
    throw new Error(
      `${here}: ${record.kind} is the body of ${record.bodyOf}, not of ${source?.kind}`,
    )
  const keyed: { collection: Collection; param: string }[] = []
  for (const collection of Object.values(record.collections)) {
    const param = keyParam(collection, back.foreignKey)
    if (param !== undefined) keyed.push({ collection, param })
  }
  const [only, ...others] = keyed
  if (only === undefined || others.length > 0)
    throw new Error(
      `${here}: ${record.kind} (group ${record.group}) needs one collection keyed by ${back.foreignKey}, has ${keyed.length}`,
    )
  const { collection, param } = only
  return (owner) => ({ collection: collection.id, args: { [param]: owner }, part: collection.part })
}
