/**
 * POD-4578 (Ha1) — the hand-rolled pool's entity tables, one plain `Map` per
 * entity declared in `shared/src/schema.ts`, and the per-row ingest that
 * feeds them. POD-4579 (Ha2): every write also goes to the relation engine
 * (`relations.ts`), in the same call, so relations are current the moment a
 * slot is.
 *
 * TABLES. `createTables()` makes one `Map` per schema entity
 * (`Object.keys(SCHEMA)`: issue, session, worktree, repo); no entity is
 * named here. A table maps the entity key to the BORROWED row object the feed
 * handed out, never a copy and never edited.
 *
 * THE SAME INGEST FOR THE LIVE POOL AND THE REBUILD. `ingestRecord` reads
 * through one table set and writes another (`IngestTarget`): the live pool
 * reads the fenced view (so the reads fence counts ingest's reads) and writes
 * the raw maps; `rebuildFromScratch` replays the feed's `snapshot(kind)`
 * through the same routing into fresh maps and never touches the live pool.
 *
 * EVERY WRITE IS A DELTA. `put` and `drop` report what they changed in
 * `IngestOut.deltas` (entity, id, and whether membership moved); the pool
 * turns each into invalidations after the whole event is ingested. A `put`
 * of the object the slot already holds is no write and no delta.
 *
 * HOW FEED ROWS BECOME ENTITIES.
 * - `issue` records: the feed has composed the issue composite by the
 *   schema's precedence (wire row, else projection row; `row-source.ts`
 *   `resolve`), so the issue table holds one row per id.
 * - `session` records: one component, one row.
 * - `worktree` records are the feed's lanes (`SliceWorktree`): the scan row
 *   joined with the replicated repo row, keyed by `path`. A lane with a
 *   `repoId` also carries its repo's joined facts (the schema's `repo`
 *   component, RepoProjection: id and prefix; its `repoScan` component,
 *   GitRepositoryWire: the path, as `repoPath`), so the latest such lane is
 *   the `repo` entity's row, keyed by `repoId`. When that lane leaves or
 *   moves to another repo, another lane of the repo takes over (a member of
 *   the maintained `repo.worktrees` collection, which the lane has already
 *   left by then); the repo leaves with its last lane.
 * - A `worktree` record whose value has no `path` is the replicated repo row
 *   itself, which the feed sends for a repo the scan has not reported
 *   (`row-source.ts` `resolveReposFanout`); it is held as the repo's row until
 *   a lane arrives, and never replaces a lane.
 *
 * REMOVAL. `value: undefined` deletes the row (evict and remove look the same,
 * spec §2); the delta says membership moved, and the pool disposes the row's
 * cells and accessor.
 *
 * RESIDENCY (POD-4580, Ha3). In the live pool a row of an entity that can be
 * cold (`schema[entity].cold`) is routed through `IngestTarget.residency`
 * (`residency.ts`): a cold row is registered by id and linked, never stored.
 * The rebuild and a `replace`'s staging tables have no residency and store
 * every row.
 */

import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'

/** A stored row: the borrowed object the feed handed out, untouched. */
export type StoredRow = object

/** One table per schema entity. */
export type TableSet<T> = { readonly [E in EntityName]: T }

export type Tables = TableSet<Map<string, StoredRow>>

/** The read surface ingest and the rules need; a fenced table and a `Map` both have it. */
export interface ReadableTable {
  get(id: string): unknown
  has(id: string): boolean
}

/** The schema's entities, in declaration order. */
export const ENTITIES: readonly EntityName[] = Object.freeze(Object.keys(SCHEMA) as EntityName[])

export function tablesOf<T>(make: (entity: EntityName) => T): TableSet<T> {
  return Object.fromEntries(ENTITIES.map((entity) => [entity, make(entity)])) as TableSet<T>
}

/** Fresh tables: one `Map` per schema entity. */
export function createTables(): Tables {
  return tablesOf(() => new Map<string, StoredRow>())
}

/** One table write: a slot set to a different object, or deleted. */
export interface RowDelta {
  readonly entity: EntityName
  readonly id: string
  /** The row entered or left the table (not a replacement in place). */
  readonly membership: boolean
}

/** What one ingest did. */
export interface IngestOut {
  readonly deltas: RowDelta[]
}

export function ingestOut(): IngestOut {
  return { deltas: [] }
}

/** What ingest needs from the relation engine (`relations.ts` `PoolRelations`). */
export interface RelationMaintenance {
  /** One slot written: maintain every relation it touches. */
  changed(entity: EntityName, id: string, prev: object | undefined, next: object | undefined): void
  /** A collection's current members, untracked. */
  members(from: EntityName, id: string, relation: string): ReadonlySet<string>
}

/** What ingest needs from residency (`residency.ts` `Residency`). */
export interface ResidencyRouting {
  /** Whether rows of `entity` can be cold. */
  capable(entity: EntityName): boolean
  /** One record of a cold-capable entity: stored, registered cold, or forgotten. */
  ingest(
    target: IngestTarget,
    entity: EntityName,
    id: string,
    value: StoredRow | undefined,
    out: IngestOut,
  ): void
}

/**
 * Reads go through `read` (the fenced view in the live pool); writes go to
 * `write`, and each write to `relations`. Without `relations` (the staging
 * tables of a `replace`, `enumerate.ts` `reseed`) no relation is kept, and a
 * lane may not hand its repo over. Without `residency` every row is stored.
 */
export interface IngestTarget {
  readonly read: TableSet<ReadableTable & { keys(): IterableIterator<string> }>
  readonly write: Tables
  readonly relations?: RelationMaintenance
  readonly residency?: ResidencyRouting
}

/** Store `row` under `id` unless the slot already holds that very object. */
export function put(
  target: IngestTarget,
  entity: EntityName,
  id: string,
  row: StoredRow,
  out: IngestOut,
): void {
  const previous = target.read[entity].get(id) as StoredRow | undefined
  if (previous === row) return // unchanged: keep the borrowed object, no delta
  target.write[entity].set(id, row)
  target.relations?.changed(entity, id, previous, row)
  out.deltas.push({ entity, id, membership: previous === undefined })
}

/** Delete `id`; the delta tells the pool to dispose what the row held. */
export function drop(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
  const previous = target.read[entity].get(id) as StoredRow | undefined
  if (previous === undefined) return
  target.write[entity].delete(id)
  target.relations?.changed(entity, id, previous, undefined)
  out.deltas.push({ entity, id, membership: true })
}

type LaneLike = { readonly path?: unknown; readonly repoId?: unknown }

export function isLane(row: StoredRow): boolean {
  return typeof (row as LaneLike).path === 'string'
}

/** The repo whose facts a lane carries, or null. */
export function laneRepoId(row: StoredRow): string | null {
  const repoId = (row as LaneLike).repoId
  return typeof repoId === 'string' && repoId.length > 0 ? repoId : null
}

/** `lane` stops holding its repo (it moved or left): another lane takes over, or the repo leaves. */
function releaseRepo(target: IngestTarget, lane: StoredRow, out: IngestOut): void {
  const repoId = laneRepoId(lane)
  if (repoId === null || target.read.repo.get(repoId) !== lane) return
  if (target.relations === undefined) {
    throw new Error(`[pool] repo ${repoId} changes lanes on a target that keeps no relations`)
  }
  let other: StoredRow | undefined
  for (const path of target.relations.members('repo', repoId, 'worktrees')) {
    other = target.read.worktree.get(path) as StoredRow | undefined
    if (other !== undefined && other !== lane) break
    other = undefined
  }
  if (other !== undefined) put(target, 'repo', repoId, other, out)
  else drop(target, 'repo', repoId, out)
}

function ingestWorktree(
  target: IngestTarget,
  id: string,
  value: StoredRow | undefined,
  out: IngestOut,
): void {
  const previous = target.read.worktree.get(id) as StoredRow | undefined
  if (value === undefined) {
    if (previous !== undefined) {
      drop(target, 'worktree', id, out)
      releaseRepo(target, previous, out)
      return
    }
    // The raw repo row went away (the feed keys it by repoId).
    const held = target.read.repo.get(id) as StoredRow | undefined
    if (held !== undefined && !isLane(held)) drop(target, 'repo', id, out)
    return
  }
  if (!isLane(value)) {
    const held = target.read.repo.get(id) as StoredRow | undefined
    if (held === undefined || !isLane(held)) put(target, 'repo', id, value, out)
    return
  }
  put(target, 'worktree', id, value, out)
  const repoId = laneRepoId(value)
  if (repoId !== null) put(target, 'repo', repoId, value, out)
  if (previous !== undefined && previous !== value) releaseRepo(target, previous, out)
}

/** Apply one feed record. */
export function ingestRecord(target: IngestTarget, record: RowRecord, out: IngestOut): void {
  const value = record.value as StoredRow | undefined
  if (record.kind === 'worktree') {
    ingestWorktree(target, record.id, value, out)
    return
  }
  if (target.residency?.capable(record.kind) === true) {
    target.residency.ingest(target, record.kind, record.id, value, out)
    return
  }
  if (value === undefined) drop(target, record.kind, record.id, out)
  else put(target, record.kind, record.id, value, out)
}
