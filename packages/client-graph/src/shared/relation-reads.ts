/**
 * POD-7547 — NO RELATION READS AN ON-DEMAND RECORD WITHOUT HOLDING AND
 * LOADING IT (design POD-7409 "Reading on-demand records through a model",
 * step 2: a build check replaces the lint).
 *
 * Every relation of the client schema is classified from the declarations
 * alone (the schema here, the record declarations in `@podium/model`):
 *
 * - `present`: the target is on the device whenever the source is. Its kind
 *   is in group `always`, or the source's record declaration lists the
 *   collection that brings it in its `comesWith` (for the whole kind, or in
 *   every collection of the kind), bound to the relation's key and unfiltered.
 * - `holding`: a to-many relation over a kind in a holding group, read
 *   through the target's collection keyed by the relation's foreign key
 *   (`holding-relations.ts`): reading it holds that collection and answers
 *   `LOADING` until it is complete.
 * - `lookup`: a single relation (or an outgoing edge list) to a kind the pool
 *   looks up by id (`loadable`): an absent target answers `LOADING` and loads
 *   the one record (`models.ts`, `reference`).
 * - `unprotected`: anything else. It reads only what happens to be in memory.
 *
 * {@link relationReadProblems} fails on every unprotected relation that is
 * not in {@link IN_MEMORY_RELATIONS}, each entry of which says why it may
 * still read memory and which issue removes it. `scripts/check-relation-reads.ts`
 * runs it in the lean gate (`bun run test`).
 */
import { type Collection, RECORDS, type RecordDeclaration } from '@podium/model'
import { HOLDING_GROUPS, holdingReadOf, keyedFieldOf, recordOfEntity } from './holding-relations'
import {
  allRelations,
  type EntityName,
  type ModelSchema,
  type RelationSpec,
  SCHEMA,
} from './schema'

/** How reading a relation reaches its target. */
export type RelationRead =
  | { readonly kind: 'present'; readonly why: string }
  | { readonly kind: 'holding'; readonly collection: string }
  | { readonly kind: 'lookup' }
  | { readonly kind: 'unprotected'; readonly fix: string }

export interface RelationReadRow {
  /** `<entity>.<relation>`. */
  readonly relation: string
  readonly from: EntityName
  readonly to: EntityName
  readonly spec: RelationSpec
  /** The record kind the target's rows arrive as, when it is a synced record. */
  readonly target: string | undefined
  readonly group: string | undefined
  readonly read: RelationRead
}

/** A single-valued relation: one target id, read from the source row. */
const isSingle = (spec: RelationSpec): boolean =>
  spec.kind === 'belongsTo' ||
  spec.kind === 'prefix' ||
  (spec.kind === 'edge' && spec.direction === 'out' && spec.many !== true)

/** Every collection by id, and the field each one keyed by a single argument is keyed by. */
interface DeclaredCollections {
  readonly byId: ReadonlyMap<string, Collection>
  readonly keyedBy: ReadonlyMap<string, string>
}

function declaredCollections(declarations: readonly RecordDeclaration[]): DeclaredCollections {
  const byId = new Map<string, Collection>()
  const keyedBy = new Map<string, string>()
  for (const record of declarations)
    for (const collection of Object.values(
      record.collections as Readonly<Record<string, Collection>>,
    )) {
      byId.set(collection.id, collection)
      const field = keyedFieldOf(collection)
      if (field !== undefined) keyedBy.set(collection.id, field)
    }
  return { byId, keyedBy }
}

/** A comes-with entry that brings every record a relation reads, as the declarations say. */
type ComesWith = RecordDeclaration['comesWith'][number]

/**
 * Whether `entry` brings, for each source record, the whole of what the
 * relation reads: a collection of the target kind keyed by `targetField`,
 * bound to the source's `sourceField`, unfiltered, and conditional at most on
 * that field being set (when it is empty the relation reads nothing).
 */
function bringsAll(
  entry: ComesWith,
  source: RecordDeclaration,
  declared: DeclaredCollections,
  target: RecordDeclaration,
  targetField: string,
  sourceField: string,
): boolean {
  const collection = declared.byId.get(entry.collection)
  if (collection === undefined || collection.of !== target.kind) return false
  if (declared.keyedBy.get(entry.collection) !== targetField) return false
  if ((entry.key ?? source.key) !== sourceField) return false
  if (entry.where !== undefined) return false
  if (entry.if === undefined) return true
  return JSON.stringify(entry.if) === JSON.stringify({ [sourceField]: { not: { empty: true } } })
}

/**
 * Why `from.relation`'s target is on the device whenever its source is, or
 * undefined. A key join only: a prefix or an edge relation reads ids that no
 * comes-with binds.
 */
function presentWhy(
  schema: ModelSchema,
  from: EntityName,
  spec: RelationSpec,
  source: RecordDeclaration | undefined,
  target: RecordDeclaration,
  declared: DeclaredCollections,
): string | undefined {
  if (target.group === 'always') return 'group always: every device holds all of it'
  if (source === undefined) return undefined
  let fields: { targetField: string; sourceField: string } | undefined
  if (spec.kind === 'belongsTo')
    fields = { targetField: spec.targetKey, sourceField: spec.foreignKey }
  else if (spec.kind === 'hasMany') {
    const back = schema[spec.to].relations[spec.inverse]
    if (back?.kind === 'belongsTo')
      fields = { targetField: back.foreignKey, sourceField: back.targetKey }
  }
  if (fields === undefined) return undefined
  const { targetField, sourceField } = fields
  // Plain loops over the fixed declarations, read once per check run.
  for (const entry of source.comesWith)
    if (bringsAll(entry, source, declared, target, targetField, sourceField))
      return `${source.kind} comes with ${entry.collection}`
  let holders = 0
  for (const collection of Object.values(
    source.collections as Readonly<Record<string, Collection>>,
  )) {
    let brought = false
    for (const entry of collection.comesWith ?? [])
      if (bringsAll(entry, source, declared, target, targetField, sourceField)) brought = true
    if (!brought) return undefined
    holders += 1
  }
  return holders > 0
    ? `every collection of ${source.kind} comes with its ${target.kind} records`
    : undefined
}

/** What to change so the relation holds and loads what it reads. */
function fixFor(
  schema: ModelSchema,
  spec: RelationSpec,
  target: RecordDeclaration | undefined,
  problem: string | undefined,
): string {
  if (problem !== undefined) return problem
  if (isSingle(spec) || (spec.kind === 'edge' && spec.direction === 'out'))
    return `look it up by id: make ${spec.to} loadable (a lookup that loads) or bring it in the source's comesWith`
  const back = schema[spec.to].relations[spec.inverse]
  const kind = target?.kind ?? spec.to
  if (back?.kind === 'edge')
    return `the ${kind} records whose ${back.edgeField} list names the source: no collection holds them; declare one, or bring them in the source's comesWith`
  if (back?.kind === 'prefix')
    return `the ${kind} records placed under the source by ${back.sourceField}: no collection holds them; declare one, or bring them in the source's comesWith`
  const key = back?.kind === 'belongsTo' ? back.foreignKey : 'its inverse key'
  if (target !== undefined && !HOLDING_GROUPS.has(target.group))
    return `${kind} is in group ${target.group}, which no relation read holds; declare it present or give it a holding group and a collection keyed by ${key}`
  return `declare one collection of ${kind} keyed by ${key}, so the relation read holds it, or bring it in the source's comesWith`
}

/** Every relation of the schema, classified from the declarations. */
export function relationReads(
  schema: ModelSchema = SCHEMA,
  records: readonly RecordDeclaration[] = RECORDS,
): RelationReadRow[] {
  const declared = declaredCollections(records)
  return allRelations(schema).map(({ from, name, relation: spec }) => {
    const source = recordOfEntity(schema, from, records)
    const target = recordOfEntity(schema, spec.to, records)
    const row = {
      relation: `${from}.${name}`,
      from,
      to: spec.to,
      spec,
      target: target?.kind,
      group: target?.group,
    }
    const loadable = schema[spec.to].loadable !== undefined
    if (target === undefined)
      return {
        ...row,
        read: loadable
          ? { kind: 'unprotected', fix: `${spec.to} is loadable but arrives as no record kind` }
          : {
              kind: 'present',
              why: `${spec.to} is not a synced record: the device holds all of it`,
            },
      } as RelationReadRow
    const present = presentWhy(schema, from, spec, source, target, declared)
    if (present !== undefined) return { ...row, read: { kind: 'present', why: present } }
    const holding = holdingReadOf(schema, from, name, records)
    if (holding !== undefined && 'instance' in holding)
      return { ...row, read: { kind: 'holding', collection: holding.collection } }
    const byId =
      spec.kind === 'belongsTo'
        ? spec.targetKey === schema[spec.to].key
        : spec.kind === 'edge' && spec.direction === 'out'
    if (byId && loadable && spec.lazy) return { ...row, read: { kind: 'lookup' } }
    const back = schema[spec.to].relations[spec.inverse]
    const problem =
      holding !== undefined && 'problem' in holding && back?.kind === 'belongsTo'
        ? holding.problem
        : undefined
    return { ...row, read: { kind: 'unprotected', fix: fixFor(schema, spec, target, problem) } }
  })
}

/**
 * The relations that still read only what is in memory, each with why that
 * is allowed for now and which issue ends it. Nothing else may: a relation
 * added later fails the check until it holds or looks up what it reads.
 */
export const IN_MEMORY_RELATIONS: Readonly<Record<string, string>> = {
  // Sub-issues: only the tree (descendantsOf a root) holds them. The flight
  // deck reads them behind `collections.treeHeld`; the sidebar and the board
  // read what the policy holds. POD-7582 decides the hold, POD-7580 and
  // POD-7581 the readers.
  'issue.children':
    'No collection is keyed by parentId; readers hold the tree (treeHeld) or read the policy. POD-7582.',
  'issue.treeChildren':
    'No collection is keyed by parentId; readers hold the tree (treeHeld) or read the policy. POD-7582.',
  'issue.bornSessions':
    'No collection is keyed by refIssueId; read only as a count for the mission bucket. POD-7582.',
  'issue.supersededIssues': 'No collection is keyed by supersededBy; no screen reads it. POD-7582.',
  'issue.duplicateIssues': 'No collection is keyed by duplicateOf; no screen reads it. POD-7582.',
  'issue.spinOffs':
    'Incoming discovered-from edges: no collection holds the issues whose deps name this one. POD-7582.',
  'issue.pageDependents':
    'Incoming dependency edges: no collection holds the issues whose deps name this one. POD-7582.',
  'session.startedIssues':
    'No collection is keyed by startedBySession; no screen reads it. POD-7582.',
  'session.missionStartedIssues':
    'No collection is keyed by startedBySession; the mission closure (mission.ts) reads it inside the deck. POD-7582.',
  'worktree.sessions':
    'Sessions placed under a checkout by their cwd: no collection holds them; the sidebar lanes read what the policy holds. POD-7582.',
  'worktree.issues':
    'No collection is keyed by worktreePath; the session pane reads what is in memory. POD-7582.',
  'repo.issues': 'No collection is keyed by repoId; no screen reads it. POD-7582.',
  // Effects are a server window, downloaded whole at start, but it holds only
  // recent effects, so an old issue's list can look complete when it is not.
  'issue.effects':
    'Group windowed: read only for what runs now (effects.ready). Whether the window counts as present is POD-7583.',
  'session.effects':
    'Group windowed: read only for what runs now (effects.ready). Whether the window counts as present is POD-7583.',
}

/**
 * Everything wrong with the relation reads: an unprotected relation that is
 * not listed, a listed one that is protected or gone, a listing without a
 * reason. Empty when every relation holds, looks up or finds present what it
 * reads.
 */
export function relationReadProblems(
  schema: ModelSchema = SCHEMA,
  records: readonly RecordDeclaration[] = RECORDS,
  allowed: Readonly<Record<string, string>> = IN_MEMORY_RELATIONS,
): string[] {
  const problems: string[] = []
  const rows = new Map(relationReads(schema, records).map((row) => [row.relation, row]))
  for (const row of rows.values()) {
    if (row.read.kind !== 'unprotected' || row.relation in allowed) continue
    problems.push(
      `${row.relation} reads ${row.target ?? row.to} (group ${row.group ?? 'none'}) without holding or loading it. Fix: ${row.read.fix}.`,
    )
  }
  for (const [relation, why] of Object.entries(allowed)) {
    const row = rows.get(relation)
    if (row === undefined)
      problems.push(`${relation} is listed as reading memory but is not declared`)
    else if (row.read.kind !== 'unprotected')
      problems.push(
        `${relation} is listed as reading memory but is ${row.read.kind}: remove it from the list`,
      )
    if (why.trim() === '') problems.push(`${relation} is listed as reading memory without a reason`)
  }
  return problems
}
