/**
 * The record declarations and what is generated from them (POD-7084).
 *
 * `RECORD_KINDS` is the protocol's record list (`MetadataEntityKind`) and
 * `REPLICA_KIND_OF` the client kernel's kind table; both used to be written
 * by hand. {@link recordDeclarationProblems} checks the declarations against each
 * other; `records.test.ts` runs it.
 */

import type { z } from 'zod'
import { RECORDS } from './declarations'
import {
  type Collection,
  fieldForPath,
  isSavedField,
  type LinkSpec,
  type RecordDeclaration,
} from './define-record'
import {
  andWhere,
  assertWhere,
  type Clause,
  clausesOf,
  paramsRead,
  pathsRead,
  type Where,
} from './rule'

export * from './declarations'
export * from './define-record'
export * from './rule'
export * from './rule-corpus'

type Records = typeof RECORDS

/** A synced record type's wire name. */
export type RecordKind = Records[number]['kind']
/** A synced record type's client collection name. */
export type RecordReplicaKind = Records[number]['replicaKind']
/** The declaration of one record type. */
export type RecordOf<K extends RecordKind> = Extract<Records[number], { kind: K }>
/** The wire value of one record type. */
export type RecordValue<K extends RecordKind> = z.infer<RecordOf<K>['schema']>

type KindTuple<T extends readonly { kind: string }[]> = {
  -readonly [I in keyof T]: T[I] extends { readonly kind: infer K } ? K : never
}

/** Every record kind, in wire order: the protocol's record list. */
export const RECORD_KINDS = RECORDS.map((record) => record.kind) as unknown as KindTuple<Records>

/** Record kind → client collection: the client kernel's kind table. */
export const REPLICA_KIND_OF = Object.fromEntries(
  RECORDS.map((record) => [record.kind, record.replicaKind]),
) as { readonly [D in Records[number] as D['kind']]: D['replicaKind'] }

const byKind = new Map<string, RecordDeclaration>(RECORDS.map((record) => [record.kind, record]))
const byReplicaKind = new Map<string, RecordDeclaration>(
  RECORDS.map((record) => [record.replicaKind, record]),
)

export function recordOf<K extends RecordKind>(kind: K): RecordOf<K>
export function recordOf(kind: string): RecordDeclaration | undefined
export function recordOf(kind: string): RecordDeclaration | undefined {
  return byKind.get(kind)
}

export function recordOfReplicaKind(replicaKind: string): RecordDeclaration | undefined {
  return byReplicaKind.get(replicaKind)
}

export const isRecordKind = (kind: string): kind is RecordKind => byKind.has(kind)

/** A field of `K` that holds a declared link. */
export type RecordLinkField<K extends RecordKind> = Extract<keyof RecordOf<K>['links'], string>

/**
 * A declared link as a join: the field holding it, the record type it names
 * and the field of that type it matches. For a link to one record type.
 */
export function linkKeys<K extends RecordKind>(
  kind: K,
  field: RecordLinkField<K>,
): { readonly to: RecordKind; readonly foreignKey: string; readonly targetKey: string } {
  const link = (recordOf(kind).links as unknown as Readonly<Record<string, LinkSpec>>)[field]
  if (link === undefined || typeof link.to !== 'string') {
    throw new Error(`${kind}.${field} is not a declared link to one record type`)
  }
  const target = recordOf(link.to)
  const targetKey = link.targetField ?? target?.key
  if (target === undefined || targetKey === undefined)
    throw new Error(`${kind}.${field} links to ${link.to}, which has no key`)
  return { to: link.to as RecordKind, foreignKey: field, targetKey }
}

/** Every collection of every record type, by id (`'<kind>.<name>'`). */
export const COLLECTIONS: ReadonlyMap<string, Collection> = new Map(
  RECORDS.flatMap((record) =>
    Object.values(record.collections as Readonly<Record<string, Collection>>),
  ).map((collection) => [collection.id, collection]),
)

/** The params the policy fills; every other param is an argument of the instance. */
export const POLICY_PARAMS: ReadonlySet<string> = new Set(['recentDays'])

/** The arguments an instance of the collection names. */
export const instanceParams = (collection: Collection): string[] =>
  collection.where === undefined
    ? []
    : paramsRead(collection.where).filter((name) => !POLICY_PARAMS.has(name))

/**
 * The design's collections (POD-7059 "Collections"), by the name the design
 * gives them. "Always" is every record type that does not grow with history.
 */
export const DESIGN_COLLECTIONS = {
  always: RECORDS.filter((record) => record.group === 'always').map(
    (record) => `${record.kind}.all`,
  ),
  live: ['session.live'],
  asking: ['session.asking'],
  recent: [
    'issueProjection.recent',
    'session.recent',
    'workflowRun.recent',
    'automationRun.recent',
    'conversation.recent',
  ],
  sidebar: ['issueProjection.sidebar'],
  sessionsWithNoIssue: ['session.noIssue'],
  issueStubs: ['issueProjection.stubs'],
  tree: ['issueProjection.tree'],
  page: ['issueProjection.byStage', 'workflowRun.page', 'automationRun.page', 'conversation.page'],
  sessionsOfIssue: ['session.ofIssue'],
  oneRecord: [
    'issueProjection.one',
    'session.one',
    'workflowRun.one',
    'automationRun.one',
    'conversation.one',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** One rule the declarations contain, as both evaluators answer it. */
export interface DeclaredRule {
  /** `<collection id>`, `<holder> > <collection>` for a collection's comes-with,
   *  `<holder> > <collection> if` for the condition on a holder. */
  readonly id: string
  /** The record type the rule selects. */
  readonly of: string
  readonly where: Where
}

/**
 * Every rule in the declarations: each collection's, each comes-with of a
 * collection (the target collection's rule with the comes-with's `where`), and
 * each comes-with condition on its holder. The shared corpus has a case for
 * every one of them.
 */
export function declaredRules(records: readonly RecordDeclaration[] = RECORDS): DeclaredRule[] {
  const collections = new Map<string, Collection>()
  for (const record of records)
    for (const c of Object.values(record.collections)) collections.set(c.id, c)
  const out: DeclaredRule[] = []
  const comesWith = (
    holder: string,
    holderKind: string,
    entry: RecordDeclaration['comesWith'][number],
  ) => {
    const target = collections.get(entry.collection)
    if (target === undefined) return
    if (entry.where !== undefined) {
      const where = andWhere(target.where, entry.where)
      if (where !== undefined)
        out.push({ id: `${holder} > ${entry.collection}`, of: target.of, where })
    }
    if (entry.if !== undefined)
      out.push({ id: `${holder} > ${entry.collection} if`, of: holderKind, where: entry.if })
  }
  for (const record of records) {
    for (const collection of Object.values(record.collections)) {
      if (collection.where !== undefined)
        out.push({ id: collection.id, of: record.kind, where: collection.where })
      for (const entry of collection.comesWith ?? []) comesWith(collection.id, record.kind, entry)
    }
    for (const entry of record.comesWith) comesWith(record.kind, record.kind, entry)
  }
  return out
}

/**
 * Everything wrong with a set of declarations; empty when they agree with each
 * other. Every rule uses only the allowed tests and reads only saved fields of
 * its own type; links name declared types and fields; body records and the
 * fields they carry agree; a "comes with" names a keyed collection of one
 * argument and binds it to a field of the holder.
 */
export function recordDeclarationProblems(
  records: readonly RecordDeclaration[] = RECORDS,
): string[] {
  const problems: string[] = []
  const kinds = new Map(records.map((record) => [record.kind, record]))
  const replicaKinds = new Set<string>()
  const collections = new Map<string, Collection>()
  for (const record of records) {
    if (replicaKinds.has(record.replicaKind))
      problems.push(`${record.kind}: replica kind ${record.replicaKind} is taken`)
    replicaKinds.add(record.replicaKind)
    for (const collection of Object.values(record.collections))
      collections.set(collection.id, collection)
  }
  if (kinds.size !== records.length) problems.push('a record kind is declared twice')

  const checkRule = (where: Where, record: RecordDeclaration, what: string) => {
    try {
      assertWhere(where)
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`)
      return
    }
    for (const path of pathsRead(where)) {
      const field = fieldForPath(record, path)
      if (field === undefined)
        problems.push(`${what} reads ${path}, which ${record.kind} does not declare`)
      else if (!isSavedField(record, field))
        problems.push(`${what} reads ${field}, which is not a saved field of ${record.kind}`)
    }
    for (const clause of clausesOf(where)) {
      for (const [path, test] of Object.entries(clause)) {
        if (
          typeof test === 'object' &&
          test !== null &&
          'descendantsOf' in test &&
          path !== record.parentLink
        ) {
          problems.push(
            `${what}: descendantsOf on ${path}, which is not the parent link of ${record.kind}`,
          )
        }
      }
    }
  }

  const checkComesWith = (
    holder: RecordDeclaration,
    entry: RecordDeclaration['comesWith'][number],
    what: string,
  ) => {
    const target = collections.get(entry.collection)
    if (target === undefined) {
      problems.push(`${what} names collection ${entry.collection}, which no record type declares`)
      return
    }
    const params = instanceParams(target)
    if (params.length !== 1)
      problems.push(
        `${what}: ${entry.collection} takes ${params.length} arguments, a comes-with binds one`,
      )
    const key = entry.key ?? holder.key
    if (key === undefined)
      problems.push(
        `${what}: ${holder.kind} has a composite id, so the comes-with names its key field`,
      )
    else if (holder.partOf(key) === undefined)
      problems.push(`${what} binds ${key}, which ${holder.kind} does not declare`)
    if (entry.if !== undefined) checkRule(entry.if as Clause, holder, `${what} if`)
    const targetRecord = kinds.get(target.of)
    if (entry.where !== undefined && targetRecord !== undefined)
      checkRule(entry.where as Clause, targetRecord, `${what} where`)
  }

  for (const record of records) {
    for (const [field, link] of Object.entries(record.links)) {
      const targets = typeof link.to === 'string' ? [link.to] : link.to
      for (const to of targets) {
        const target = kinds.get(to)
        if (target === undefined) {
          problems.push(`${record.kind}.${field} links to ${to}, which is not declared`)
          continue
        }
        const targetField = link.targetField ?? target.key
        if (targetField === undefined || target.partOf(targetField) === undefined) {
          problems.push(
            `${record.kind}.${field} links to ${to}.${targetField}, which is not a field`,
          )
        }
      }
      if (typeof link.to !== 'string') {
        if (link.by === undefined)
          problems.push(`${record.kind}.${field} links to several types without saying which`)
        else {
          if (record.partOf(link.by.field) === undefined)
            problems.push(`${record.kind}.${field}: ${link.by.field} is not a field`)
          for (const to of Object.values(link.by.kinds)) {
            if (!link.to.includes(to))
              problems.push(`${record.kind}.${field}: ${to} is not one of its targets`)
          }
        }
      }
    }
    for (const [bodyKind, fields] of Object.entries(record.body)) {
      const body = kinds.get(bodyKind)
      if (body === undefined)
        problems.push(
          `${record.kind} body ${fields.join(', ')} is carried by ${bodyKind}, which is not declared`,
        )
      else if (body.bodyOf !== record.kind)
        problems.push(`${bodyKind} carries body of ${record.kind} but says bodyOf ${body.bodyOf}`)
    }
    if (record.bodyOf !== undefined) {
      const owner = kinds.get(record.bodyOf)
      if (owner === undefined || !(record.kind in owner.body))
        problems.push(`${record.kind} says it is body of ${record.bodyOf}, which does not list it`)
      if (record.group !== 'body')
        problems.push(`${record.kind} is a body record outside the body group`)
    }
    if (
      (record.group === 'always' || record.group === 'windowed') &&
      Object.keys(record.collections).length === 0
    ) {
      problems.push(`${record.kind}: an ${record.group} type needs its collection`)
    }
    if (record.group === 'byRule' && !('recent' in record.collections))
      problems.push(`${record.kind}: a type held by rule needs a recent collection`)
    if (
      record.group === 'byRule' &&
      record.kind !== 'issueProjection' &&
      record.kind !== 'session' &&
      !('page' in record.collections)
    ) {
      problems.push(`${record.kind}: a type that grows with history needs paging`)
    }
    for (const collection of Object.values(record.collections)) {
      if (collection.where !== undefined) checkRule(collection.where, record, collection.id)
      for (const sort of collection.page?.sort ?? []) {
        const field = fieldForPath(record, sort.field)
        if (field === undefined || !isSavedField(record, field))
          problems.push(`${collection.id} sorts by ${sort.field}, which is not a saved field`)
      }
      for (const entry of collection.comesWith ?? []) {
        const target = collections.get(entry.collection)
        if (target !== undefined && entry.key === undefined && target.of === record.kind) {
          problems.push(`${collection.id}: a comes-with of its own type must name its key`)
        }
        checkComesWith(record, entry, `${collection.id} comes with`)
      }
    }
    for (const entry of record.comesWith) checkComesWith(record, entry, `${record.kind} comes with`)
  }
  return problems
}
