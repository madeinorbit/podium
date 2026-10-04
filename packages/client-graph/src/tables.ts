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
 * it reads the tables and writes the raw MobX maps), so the harness-owned
 * rebuild (`harness/src/adapters/mobx-rebuild.ts`) replays the feed's
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
 *   `path`. Routing a lane onto the `repo` table (latest lane wins, takeover
 *   through the maintained `repo.worktrees`, raw-row hold) is the shared
 *   feed-layer composition (`shared/src/repo-from-lane.ts`
 *   `ingestWorktreeRecord`, POD-4695): `ingestRecord` below only adapts this
 *   pool's slot writes to that composer's ops. The one field spelled
 *   differently on a lane is in that module's `FEED_SPELLING`.
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
 * RELATIONS (POD-4566, POD-5407). The relations are maintained by the
 * relation index the cold index holds (`shared/relation-index.ts`), from the
 * same publication, before the pool's tables see it; a table write tells
 * nothing to the relations. Ingest only reads them (`repo.worktrees`, for a
 * repo handed between lanes). The rebuild and the replace staging ingest
 * with no relations: they resolve from scratch.
 */

import { type ObservableMap, observable } from 'mobx'
import { debugName } from './debug-name'
import { ingestWorktreeRecord } from './shared/repo-from-lane'
import { type EntityName, SCHEMA } from './shared/schema'
import type { RowRecord } from './shared/source'
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
    observable.map<string, StoredRow>(undefined, { deep: false, name: debugName(() => `pool.${entity}`) }),
  )
}

/** Plain maps with the same routing, for the rebuild and the replace diff. */
export function createPlainTables(): TableSet<Map<string, StoredRow>> {
  return tablesOf(() => new Map<string, StoredRow>())
}

/** What one ingest did: the rows it removed, so the pool drops their models. */
export interface IngestOut {
  removed: [EntityName, string][]
}

/** Reads go through `read` (the live pool's tables); writes go to `write` (the raw tables). */
export interface IngestTarget {
  readonly read: { readonly [E in EntityName]: { get(id: string): unknown } }
  readonly write: TableSet
  /** The live pool's relations, read by the repo composition. */
  readonly relations?: RelationMaintenance
  /**
   * The live pool's volatile lane (POD-4686): an issue's read cursor, kept
   * beside its row so a mark-read skips the slot write. Absent in the
   * rebuild, which stores every row whole.
   */
  readonly volatile?: VolatileLane
  /**
   * The live pool's residency (POD-4567, `residency.ts`): a row of an entity
   * that can be cold is routed through it, and a cold row never reaches
   * `write`. The rebuild and the replace staging hold every row.
   */
  readonly residency?: Pick<Residency, 'capable' | 'ingest' | 'attach'>
}

/**
 * POD-4686 — an issue's read cursor (`readAt`) beside its row. A mark-read
 * rewrites only the cursor: the row's slot (and every derivation reading the
 * row for anything else — standing, rank, placement, views) stays quiet,
 * while the cursor's own readers (`unread`, a decay row's `flat`) re-run
 * through the lane. Skipping the slot write skips nothing else: no declared
 * relation reads the cursor, and residency routes only new rows by rule.
 */
export interface VolatileLane {
  /**
   * The hot issue update `previous` → `next`: when they differ only in the
   * cursor, record it and return true (no slot write, no relink). Otherwise
   * return false (the caller writes the slot and records the cursor itself).
   */
  absorbIssueRead(id: string, previous: StoredRow, next: StoredRow): boolean
  /** Record the cursor of an incoming or cold-registered issue row. */
  setIssueRead(id: string, row: StoredRow): void
  /** Forget the cursor of a removed issue row. */
  removeIssueRead(id: string): void
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
  if (previous === row) {
    // A cursor-only overlay leaves this borrowed body in place. A receipt can
    // rewind to the same body, while its separate read-state lane has moved.
    if (entity === 'issue') target.volatile?.setIssueRead(id, row)
    return
  }
  if (
    entity === 'issue' &&
    previous !== undefined &&
    target.volatile?.absorbIssueRead(id, previous, row) === true
  ) {
    // Cursor-only: the read-state lane moved, no slot write, no relink.
    return
  }
  target.write[entity].set(id, row)
  if (entity === 'issue') target.volatile?.setIssueRead(id, row)
}

/** Delete `id`, reporting the removal so its model is dropped. */
export function drop(target: IngestTarget, entity: EntityName, id: string, out: IngestOut): void {
  if (!target.write[entity].delete(id)) return
  out.removed.push([entity, id])
  if (entity === 'issue') target.volatile?.removeIssueRead(id)
}

/** Apply one feed record. */
export function ingestRecord(target: IngestTarget, record: RowRecord, out: IngestOut): void {
  const value = record.value as StoredRow | undefined
  if (record.kind === 'worktree') {
    // Repo-from-lane is the shared feed-layer composition (POD-4695): the
    // pool only adapts its slot writes. The takeover reads the maintained
    // `repo.worktrees` collection; with no relations (rebuild, replace
    // staging) the repo leaves with its lane.
    ingestWorktreeRecord(
      {
        getWorktree: (id) => target.read.worktree.get(id) as StoredRow | undefined,
        getRepo: (id) => target.read.repo.get(id) as StoredRow | undefined,
        putWorktree: (id, row) => put(target, 'worktree', id, row, out),
        putRepo: (id, row) => put(target, 'repo', id, row, out),
        dropWorktree: (id) => drop(target, 'worktree', id, out),
        dropRepo: (id) => drop(target, 'repo', id, out),
        repoWorktreeMembers: (repoId) => target.relations?.members('repo', repoId, 'worktrees'),
      },
      record.id,
      value,
    )
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
  return { removed: [] }
}
