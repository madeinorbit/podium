/**
 * POD-4565 (Ma1) — the pool's entity tables, one per entity declared in
 * `shared/src/schema.ts`, and the per-row ingest that feeds them.
 *
 * TABLES. `createObservableTables()` makes one shallow `ObservableMap` per
 * schema entity (`Object.keys(SCHEMA)`: issue, session, worktree, repo); no
 * entity is named here. A table maps the entity key to the BORROWED row
 * object the feed handed out: values are never converted, copied or edited
 * (`deep: false` is `observable.ref` per entry), so a derivation reading
 * `table.get(id)` subscribes to exactly that row's slot. Models are not built
 * here: `pool.ts` wraps a row in a model on first access (Linear's
 * "observable on first access"; audit §7).
 *
 * THE SAME INGEST FOR THE LIVE POOL AND THE REBUILD. `ingestRecord` reads
 * through one table set and writes another (`IngestTarget`: in the live pool
 * it reads the fenced view, so the reads fence counts ingest's reads, and
 * writes the raw MobX maps), so `rebuildFromScratch` replays the feed's
 * `snapshot(kind)` through exactly this routing into plain maps and never
 * touches the live pool.
 *
 * HOW FEED ROWS BECOME ENTITIES.
 * - `issue` records: the feed has already composed the issue composite by the
 *   schema's precedence (wire row, else projection row; `row-source.ts`
 *   `resolve`), so the issue table holds one row per id.
 * - `session` records: one component, one row.
 * - `worktree` records are the feed's lanes (`SliceWorktree`): the scan row
 *   joined with the replicated repo row. A lane is a `worktree` row keyed by
 *   `path`. Every lane with a `repoId` also carries its repo's joined facts
 *   (the schema's `repo` component, RepoProjection: id and prefix; and its
 *   `repoScan` component, GitRepositoryWire: the path), so the latest such
 *   lane is the `repo` entity's row, keyed by `repoId`. The one field spelled
 *   differently on a lane is in `FEED_SPELLING` (`models.ts`). When the lane
 *   holding a repo leaves (or moves to another repo), another of the repo's
 *   lanes takes over, found through the maintained `repo.worktrees`
 *   collection (every lane of a repo carries the same repo facts); the repo
 *   is dropped only with its last lane.
 * - A `worktree` record whose value has no `path` is the replicated repo row
 *   itself, which the feed sends for a repo the scan has not reported
 *   (`row-source.ts` `resolveReposFanout`); it is held as the repo's row until
 *   a lane arrives, and never replaces a lane.
 *
 * REMOVAL. A record with `value: undefined` deletes the row (evict and remove
 * look the same, spec §2); every removal is reported in `IngestOut.removed`
 * so the pool drops the row's model.
 *
 * RESIDENCY (POD-4567). In the live pool a row of an entity that can be cold
 * (`schema[entity].cold`) is routed through `IngestTarget.residency`
 * (`residency.ts`): a cold row is registered by id and linked, never stored.
 *
 * RELATIONS (POD-4566). Every table write — `put` and `drop` — hands the
 * previous and the new row to `IngestTarget.relations` (`relations.ts`),
 * which maintains every declared relation the write touches. The rebuild and
 * the replace staging ingest with no relations: they resolve from scratch.
 */

import { type ObservableMap, observable } from 'mobx'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import type { RelationMaintenance } from './relations'
import type { Residency } from './residency'

/** A stored row: the borrowed object the feed handed out, untouched. */
export type StoredRow = object

/** The write surface ingest needs; a MobX map and a plain `Map` both have it. */
export interface WritableTable {
  get(id: string): StoredRow | undefined
  has(id: string): boolean
  set(id: string, row: StoredRow): unknown
  delete(id: string): boolean
  keys(): IterableIterator<string>
  readonly size: number
}

/** One table per schema entity. */
export type TableSet<T extends WritableTable = WritableTable> = { readonly [E in EntityName]: T }

export type PoolTables = TableSet<ObservableMap<string, StoredRow>>

/** The schema's entities, in declaration order. */
export const ENTITIES: readonly EntityName[] = Object.freeze(Object.keys(SCHEMA) as EntityName[])

function tablesOf<T extends WritableTable>(make: (entity: EntityName) => T): TableSet<T> {
  return Object.fromEntries(ENTITIES.map((entity) => [entity, make(entity)])) as TableSet<T>
}

/** The live pool's tables: shallow observable maps, one per schema entity. */
export function createObservableTables(): PoolTables {
  return tablesOf((entity) =>
    observable.map<string, StoredRow>(undefined, { deep: false, name: `pool.${entity}` }),
  )
}

/** Plain maps with the same routing, for the rebuild and the replace diff. */
export function createPlainTables(): TableSet<Map<string, StoredRow>> {
  return tablesOf(() => new Map<string, StoredRow>())
}

/** What one ingest did: writes that changed a slot, and the rows it removed. */
export interface IngestOut {
  writes: number
  removed: [EntityName, string][]
  /** Cold rows registered, relinked or forgotten (POD-4567): no slot written. */
  cold: number
}

/** Reads go through `read` (the fenced view in the live pool, so the reads
 *  fence counts them); writes go to `write` (the raw tables). */
export interface IngestTarget {
  readonly read: { readonly [E in EntityName]: { get(id: string): unknown } }
  readonly write: TableSet
  /** Told of every write, in order (the live pool's relations). */
  readonly relations?: RelationMaintenance
  /**
   * The live pool's residency (POD-4567, `residency.ts`): a row of an entity
   * that can be cold is routed through it, and a cold row never reaches
   * `write`. The rebuild and the replace staging hold every row.
   */
  readonly residency?: Pick<Residency, 'capable' | 'ingest' | 'place' | 'forget' | 'ids' | 'reindex'>
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
  if (previous === row) return // unchanged: keep the borrowed object, notify nothing
  target.write[entity].set(id, row)
  out.writes += 1
  target.relations?.changed(entity, id, previous, row)
}

/** Delete `id`, reporting the removal so its model is dropped. */
export function drop(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
  const previous = target.relations === undefined ? undefined : target.read[entity].get(id)
  if (!target.write[entity].delete(id)) return
  out.writes += 1
  out.removed.push([entity, id])
  target.relations?.changed(entity, id, previous as StoredRow | undefined, undefined)
}

type LaneLike = { readonly path?: unknown; readonly repoId?: unknown }

function isLane(row: StoredRow): boolean {
  return typeof (row as LaneLike).path === 'string'
}

/** The repo whose facts a lane carries, or null. */
function laneRepoId(row: StoredRow): string | null {
  const repoId = (row as LaneLike).repoId
  return typeof repoId === 'string' && repoId.length > 0 ? repoId : null
}

/**
 * The repo stops being held by `lane` (it moved or left): another of its
 * lanes takes over, or, with none left (or no relations to ask), it leaves.
 */
function releaseRepo(target: IngestTarget, lane: StoredRow, out: IngestOut): void {
  const repoId = laneRepoId(lane)
  if (repoId === null || target.read.repo.get(repoId) !== lane) return
  for (const path of target.relations?.members('repo', repoId, 'worktrees') ?? []) {
    const other = target.read.worktree.get(path) as StoredRow | undefined
    if (other !== undefined && other !== lane) {
      put(target, 'repo', repoId, other, out)
      return
    }
  }
  drop(target, 'repo', repoId, out)
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
  if (target.residency?.capable(record.kind)) {
    target.residency.ingest(target, record.kind, record.id, value, out)
    return
  }
  if (value === undefined) drop(target, record.kind, record.id, out)
  else put(target, record.kind, record.id, value, out)
}

/** A fresh `IngestOut`. */
export function ingestOut(): IngestOut {
  return { writes: 0, removed: [], cold: 0 }
}
