/**
 * POD-4578 (Ha1) — typed field access to a pool row, generated from the
 * declared schema: one record class per entity, built on first access and
 * dropped when its row leaves.
 *
 * A RECORD HOLDS NO ROW. Every declared field (`SCHEMA[entity].fields`) is a
 * getter installed on the record's prototype by `installFields`, from the
 * schema itself: no field list is typed here. The key field answers the
 * record's id; every other field reads the row's property of the same name,
 * or its feed spelling (`FEED_SPELLING`), through the pool's tracked tables
 * on every access, so a record cannot go stale and a cell that reads one is
 * recorded under its row. `records.test.ts` iterates the schema and reads
 * every field off a record.
 */

import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'
import type { ReadableTable, TableSet } from './tables'
import type { RepoRow } from './views'

/**
 * Where a feed row spells a schema field differently. Only the repo: its row
 * is a lane (`tables.ts`), which carries the repo's path as `repoPath`.
 */
export const FEED_SPELLING: Readonly<
  Partial<Record<EntityName, Readonly<Record<string, string>>>>
> = { repo: { path: 'repoPath' } }

/** A record's own instance fields: a schema field of the same name would be shadowed. */
const RECORD_FIELDS: readonly string[] = ['entity', 'id', 'tables']

export class EntityRecord {
  constructor(
    readonly entity: EntityName,
    readonly id: string,
    private readonly tables: TableSet<ReadableTable>,
  ) {}

  /** The borrowed row, read through the pool's tracked (and fenced) table. */
  get row(): object | undefined {
    return this.tables[this.entity].get(this.id) as object | undefined
  }
}

/**
 * A record with its schema getters, typed from the slice types the feed rows
 * already carry, so no field list is written here either.
 */
export type RecordOf = {
  issue: EntityRecord & Readonly<Omit<SliceIssue, 'unread'>>
  session: EntityRecord & Readonly<SliceSession>
  worktree: EntityRecord & Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>>
  repo: EntityRecord & Readonly<RepoRow> & { readonly id: string; readonly path?: string }
}

/** One record class per schema entity, each with its fields installed. */
export const RECORD_CLASSES: {
  readonly [E in EntityName]: new (
    entity: E,
    id: string,
    tables: TableSet<ReadableTable>,
  ) => EntityRecord
} = Object.fromEntries(
  (Object.keys(SCHEMA) as EntityName[]).map((entity) => {
    const RecordClass = class extends EntityRecord {}
    Object.defineProperty(RecordClass, 'name', { value: `${entity}Record` })
    installFields(RecordClass.prototype, entity)
    return [entity, RecordClass]
  }),
) as never

function installFields(prototype: EntityRecord, entity: EntityName): void {
  const spec = SCHEMA[entity]
  const spelling = FEED_SPELLING[entity] ?? {}
  for (const field of Object.keys(spec.fields)) {
    const member = field in prototype || (RECORD_FIELDS.includes(field) && field !== spec.key)
    if (member) {
      throw new Error(`[pool] ${entity}.${field} collides with a record member; rename one`)
    }
    const property = spelling[field] ?? field
    Object.defineProperty(prototype, field, {
      configurable: false,
      enumerable: false,
      get(this: EntityRecord): unknown {
        if (field === spec.key) return this.id
        const row = this.row as Readonly<Record<string, unknown>> | undefined
        return row === undefined ? undefined : row[property]
      },
    })
  }
}
