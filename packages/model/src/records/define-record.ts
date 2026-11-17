/**
 * `defineRecord`: ONE DECLARATION PER SYNCED RECORD TYPE (POD-7084, design
 * POD-7059 "One shared declaration", "Parts", "Collections").
 *
 * A thin helper on the zod wire schema that already exists; no schema
 * framework. A declaration holds:
 *
 *  - the record's wire `kind` (the feed's entity name) and the client
 *    collection it lands in (`replicaKind`), from which the protocol's record
 *    list and the client kernel's kind list are generated;
 *  - its fields, read off the schema, and the PART each belongs to: `stub`
 *    (issues only: reference, state, parent), `main` (every other field the
 *    record carries), `body` (fields that travel as records of their own, such
 *    as an issue's brief) and `live` (values that change every second, pushed
 *    while watched and never stored);
 *  - the fields the server derives rather than saves, which no rule may read;
 *  - its links to other record types;
 *  - what a held record comes with, in the same form a collection uses;
 *  - the collections over it, as data (`./rule.ts`).
 *
 * Holding a record never stores anything new: a record comes with ordinary
 * records or ordinary instances of keyed collections.
 */

import type { z } from 'zod'
import type { Clause, Where } from './rule'

export type Part = 'stub' | 'main' | 'body' | 'live'

/**
 * Where a record type sits on the device (design table "Which record types go
 * where"):
 *  - `always`: does not grow with history; every client holds all of it;
 *  - `comesWithIssue` / `comesWithSession`: held because an issue or a session
 *    is held;
 *  - `byRule`: held by its collections (recent by policy, older by page);
 *  - `windowed`: the server already sends only a bounded window;
 *  - `body`: a body part of another record type, held when that record is opened.
 */
export type RecordGroup =
  | 'always'
  | 'comesWithIssue'
  | 'comesWithSession'
  | 'byRule'
  | 'windowed'
  | 'body'

/** A link from one field to the record of another type that it names. */
export interface LinkSpec {
  /** The record type the field names; a list when another field says which. */
  readonly to: string | readonly string[]
  /** For a list: the field of this record that says which type, and the value per type. */
  readonly by?: { readonly field: string; readonly kinds: Readonly<Record<string, string>> }
  /** The target's field the value matches; the target's key when absent. */
  readonly targetField?: string
  readonly why?: string
}

/**
 * What holding a record also holds, written the same way on a record type
 * (for every collection) and on a collection (for its members):
 * `{ collection, where }`. `collection` names a keyed collection
 * (`'<kind>.<name>'`); its one argument is the holder's `key` field (the
 * holder's own key when absent). `if` limits it to holders that match; `where`
 * narrows the collection.
 */
export interface ComesWith {
  readonly collection: string
  readonly key?: string
  readonly if?: Clause
  readonly where?: Clause
  readonly why: string
}

/** A sorted, paged collection keeps a range marker: complete from the top down to a position. */
export interface PageSpec {
  readonly sort: readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[]
  readonly size: number
}

/** A collection over one record type. `of` is the declaring record type. */
export interface CollectionSpec {
  readonly part: 'stub' | 'main'
  /** Absent: every record of the type. */
  readonly where?: Where
  readonly page?: PageSpec
  readonly comesWith?: readonly ComesWith[]
  readonly why: string
}

export interface Collection extends CollectionSpec {
  /** `'<kind>.<name>'`. */
  readonly id: string
  readonly of: string
  readonly name: string
}

type FieldName<S extends z.ZodTypeAny> = Extract<keyof z.infer<S>, string>

export interface RecordSpec<K extends string, R extends string, S extends z.ZodTypeAny> {
  /** The feed's entity name, singular. */
  readonly kind: K
  /** The client collection the record lands in, plural; spelled out, never guessed. */
  readonly replicaKind: R
  readonly schema: S
  /** The field that holds the record's own id; absent for a composite id ({@link rowKey}). */
  readonly key?: FieldName<S>
  /** The client's row key, when it is not the `key` field (composite per-user keys). */
  readonly rowKey?: (row: z.infer<S>) => string
  readonly group: RecordGroup
  /** The stub part (issues only). Every other carried field is the main part. */
  readonly stub?: readonly FieldName<S>[]
  /** Body fields, by the record type that carries them. */
  readonly body?: Readonly<Record<string, readonly string[]>>
  /** Set on a body record: the record type whose body part it carries. */
  readonly bodyOf?: string
  /** Live fields the wire schema still names; never sent on the record, never stored. */
  readonly live?: readonly FieldName<S>[]
  /**
   * Live readings of the record that its wire schema does not carry, each with
   * the topic that pushes it while watched (`session.condition`). Never stored.
   */
  readonly liveReadings?: Readonly<Record<string, string>>
  /** Fields the server computes from code or other records, not saved with the record. */
  readonly derived?: readonly FieldName<S>[]
  readonly links?: Partial<Readonly<Record<FieldName<S>, LinkSpec>>>
  /** The parent link `descendantsOf` walks, when the type has one. */
  readonly parentLink?: FieldName<S>
  readonly comesWith?: readonly ComesWith[]
  readonly collections?: Readonly<Record<string, CollectionSpec>>
  readonly why: string
}

export interface RecordDeclaration<
  K extends string = string,
  R extends string = string,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: K
  readonly replicaKind: R
  readonly schema: S
  /** The field holding the record's own id; `undefined` for a composite id. */
  readonly key: string | undefined
  readonly rowKey: (row: z.infer<S>) => string
  readonly group: RecordGroup
  /** Every field the record carries on the wire (stub, main and live), in schema order. */
  readonly fields: readonly string[]
  readonly stub: readonly string[]
  readonly body: Readonly<Record<string, readonly string[]>>
  readonly bodyOf?: string
  readonly live: readonly string[]
  readonly liveReadings: Readonly<Record<string, string>>
  readonly derived: readonly string[]
  readonly links: Readonly<Record<string, LinkSpec>>
  readonly parentLink?: string
  readonly comesWith: readonly ComesWith[]
  readonly collections: Readonly<Record<string, Collection>>
  readonly why: string
  /** The part a field belongs to; `undefined` for a field the type does not declare. */
  partOf(field: string): Part | undefined
}

type Def = { typeName?: string; [key: string]: unknown }
const defOf = (schema: unknown): Def => ((schema as { _def?: Def })._def ?? {}) as Def

/** The fields a wire schema carries, in schema order. */
export function schemaFields(schema: z.ZodTypeAny): string[] {
  const def = defOf(schema)
  switch (def.typeName) {
    case 'ZodObject':
      return Object.keys((schema as unknown as z.AnyZodObject).shape)
    case 'ZodEffects':
      return schemaFields(def['schema'] as z.ZodTypeAny)
    case 'ZodBranded':
      return schemaFields(def['type'] as z.ZodTypeAny)
    case 'ZodPipeline':
      return schemaFields(def['in'] as z.ZodTypeAny)
    case 'ZodLazy':
      return schemaFields((def['getter'] as () => z.ZodTypeAny)())
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return schemaFields(def['innerType'] as z.ZodTypeAny)
    case 'ZodIntersection':
      return [
        ...new Set([
          ...schemaFields(def['left'] as z.ZodTypeAny),
          ...schemaFields(def['right'] as z.ZodTypeAny),
        ]),
      ]
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def['options'] as readonly z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>
      const list = Array.isArray(options)
        ? options
        : [...(options as Map<unknown, z.ZodTypeAny>).values()]
      return [...new Set(list.flatMap((option) => schemaFields(option)))]
    }
    default:
      throw new Error(
        `a record schema must be an object or a union of objects, got ${def.typeName}`,
      )
  }
}

export class RecordDeclarationError extends Error {}

/** The links of a record type, keyed by the field holding each. */
export type LinksOf<S extends z.ZodTypeAny> = Partial<Readonly<Record<FieldName<S>, LinkSpec>>>

/**
 * Declare one record type. Checks what can be checked without the others
 * (`recordDeclarationProblems` checks the rest). The declared links keep their field
 * names as types, so a reader can name a link and have it checked.
 */
export function defineRecord<
  const K extends string,
  const R extends string,
  S extends z.ZodTypeAny,
  const L extends LinksOf<S> = Record<never, never>,
>(
  spec: RecordSpec<K, R, S> & { readonly links?: L },
): Omit<RecordDeclaration<K, R, S>, 'links'> & { readonly links: L } {
  const fields = schemaFields(spec.schema)
  const declared = new Set(fields)
  const fail = (message: string): never => {
    throw new RecordDeclarationError(`${spec.kind}: ${message}`)
  }
  const known = (field: string, what: string) => {
    if (!declared.has(field)) fail(`${what} names ${field}, which the wire schema does not carry`)
  }
  if (spec.key === undefined && spec.rowKey === undefined) fail('needs a key field or a rowKey')
  if (spec.key !== undefined) known(spec.key, 'key')
  const stub = [...(spec.stub ?? [])] as string[]
  const live = [...(spec.live ?? [])] as string[]
  const derived = [...(spec.derived ?? [])] as string[]
  for (const field of stub) known(field, 'stub')
  for (const field of live) known(field, 'live')
  for (const field of derived) known(field, 'derived')
  for (const field of stub) if (live.includes(field)) fail(`${field} is in two parts`)
  for (const field of derived) if (live.includes(field)) fail(`${field} is live and derived`)
  const bodyFields = Object.values(spec.body ?? {}).flat()
  for (const field of bodyFields)
    if (declared.has(field)) fail(`body field ${field} is also carried on the record`)
  if (new Set(bodyFields).size !== bodyFields.length) fail('a body field is carried by two records')
  for (const name of Object.keys(spec.liveReadings ?? {})) {
    if (declared.has(name) || bodyFields.includes(name))
      fail(`live reading ${name} is also a field`)
  }
  const links = (spec.links ?? {}) as L & Readonly<Record<string, LinkSpec>>
  for (const field of Object.keys(links)) known(field, 'a link')
  if (spec.parentLink !== undefined) {
    if (!(spec.parentLink in links)) fail(`parentLink ${spec.parentLink} is not a declared link`)
    if (links[spec.parentLink]!.to !== spec.kind) fail('parentLink must link to its own type')
  }
  const collections: Record<string, Collection> = {}
  for (const [name, collection] of Object.entries(spec.collections ?? {})) {
    if (collection.part === 'stub' && stub.length === 0)
      fail(`collection ${name} asks for a stub part the type does not have`)
    collections[name] = { ...collection, id: `${spec.kind}.${name}`, of: spec.kind, name }
  }
  const key = spec.key as string | undefined
  const rowKey = spec.rowKey ?? ((row: z.infer<S>) => (row as Record<string, string>)[key!]!)
  const stubSet = new Set(stub)
  const liveSet = new Set(live)
  const bodySet = new Set(bodyFields)
  return {
    kind: spec.kind,
    replicaKind: spec.replicaKind,
    schema: spec.schema,
    key,
    rowKey,
    group: spec.group,
    fields,
    stub,
    body: spec.body ?? {},
    ...(spec.bodyOf === undefined ? {} : { bodyOf: spec.bodyOf }),
    live,
    liveReadings: spec.liveReadings ?? {},
    derived,
    links,
    ...(spec.parentLink === undefined ? {} : { parentLink: spec.parentLink as string }),
    comesWith: spec.comesWith ?? [],
    collections,
    why: spec.why,
    partOf(field: string): Part | undefined {
      if (stubSet.has(field)) return 'stub'
      if (liveSet.has(field) || field in (spec.liveReadings ?? {})) return 'live'
      if (bodySet.has(field)) return 'body'
      return declared.has(field) ? 'main' : undefined
    },
  }
}

/**
 * The saved field a rule's clause key reads on this type: the field itself, or
 * the declared field a dotted path starts with (`agentState.phase` reads
 * `agentState`). `undefined` when the type declares no such field.
 */
export function fieldForPath(declaration: RecordDeclaration, path: string): string | undefined {
  if (declaration.partOf(path) !== undefined) return path
  const parts = path.split('.')
  for (let at = parts.length - 1; at > 0; at--) {
    const prefix = parts.slice(0, at).join('.')
    if (declaration.partOf(prefix) !== undefined) return prefix
  }
  return undefined
}

/** Whether a rule may read this field: carried on the record, saved, not live. */
export function isSavedField(declaration: RecordDeclaration, field: string): boolean {
  const part = declaration.partOf(field)
  return (part === 'stub' || part === 'main') && !declaration.derived.includes(field)
}
