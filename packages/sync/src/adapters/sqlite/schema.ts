/**
 * THE GENERIC SYNC TABLES, as drizzle schema-as-code — owned by the ADAPTER.
 *
 * ---------------------------------------------------------------------------
 * PERSISTENCE OWNERSHIP IS LAYERED, NOT MONOLITHIC (POD-279 review, finding 5)
 * ---------------------------------------------------------------------------
 *
 *   KERNEL   `../../authority`     ports + state machines. Zero SQLite, zero Bun,
 *                                  zero DOM — `check-boundaries` rule 11.
 *   ADAPTER  this directory        the GENERIC sync tables: the change log and
 *                                  the receipt table. Both are sync
 *                                  infrastructure, filed by ADR 1 §10 under
 *                                  "sync infrastructure (not product entities)".
 *   FEATURE  its own store         feature-owned tables stay with their feature.
 *                                  `queued_messages` is the session inbox and
 *                                  `upstream_outbox` is the node→hub forwarder's;
 *                                  both remain in `apps/server`'s schema even
 *                                  though this adapter's repository reads them,
 *                                  because reading a table is not owning it. A
 *                                  package cannot import `apps/server`, so the
 *                                  composition root hands those two objects to
 *                                  `SyncRepository` instead (POD-3249; see
 *                                  `./server-tables.ts`).
 *
 * ---------------------------------------------------------------------------
 * HOW TWO SCHEMA FILES FEED ONE JOURNAL — the fork the ADR asked to be resolved
 * ---------------------------------------------------------------------------
 *
 * `drizzle.config.ts` now names an ARRAY of schema files pointing at ONE `out`
 * directory. drizzle-kit unions the schemas and emits into a single journal, so:
 *
 *   - GLOBAL MIGRATION ORDERING IS THE DRIZZLE JOURNAL — folder-timestamp order
 *     plus the snapshot `prevId` DAG — exactly as it was with one schema file.
 *     There is no second ordering authority to keep in step, which is what the
 *     retired hand-rolled chain and its "app migration orchestrator" were.
 *   - `bun run migration:check` guards it in CI, and it validates the journal as
 *     a whole rather than per schema file.
 *
 * The alternative — a second `out` directory for the kernel's tables — was
 * rejected because it recreates the exact problem drizzle adoption removed: two
 * journals have no defined order between them, so a migration in one that
 * depends on a table created in the other is correct on the machine where it was
 * authored and a boot failure everywhere else.
 *
 * MOVING A TABLE'S DECLARATION BETWEEN SCHEMA FILES IS NOT A MIGRATION. The DDL
 * drizzle-kit derives is identical, so `generate` emits nothing for the move
 * itself and existing rows are untouched. That is what makes the ownership
 * change safe to ship separately from the column addition below.
 *
 * Like `apps/server/src/migrations/schema.ts`, this is an AUTHORING import of
 * drizzle-orm: the applier is `apps/server/src/migrations/drizzle-runner.ts`,
 * and this adapter's repository still speaks hand-written SQL over the shared
 * connection until POD-3221 Stage A converts it. It does import drizzle-orm for
 * one thing already — resolving the names of the two injected server-owned
 * tables (POD-3249) — which is why `drizzle-orm` is a dependency of this package
 * rather than a devDependency.
 */

import type { MutationId, WorkspaceId } from '@podium/model'
import { foreignKey, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * THE WORKSPACE COLUMN (POD-6959 design 2.2 and 2.6, tasks POD-7012 and POD-7024).
 *
 * Every table the workspace manifest (`apps/server/src/store/workspace-manifest.ts`)
 * classes `workspace` spreads this into its columns, here and in the server's
 * schema, so the column is declared once. Every key, unique constraint and index
 * of such a table leads with it, and a foreign key between two of them is
 * composite (`migrations/branded-ref.ts`, `workspaceRef`).
 *
 * NO DEFAULT. The column migration (POD-7012) added it with `DEFAULT 'local'` so
 * the queries could be scoped repository group by repository group; the keys
 * migration (POD-7024) rebuilt every workspace table without the default. An
 * insert that does not name its workspace now fails instead of landing in the
 * self-hosted one. It is spread LAST, so the declared column order stays the
 * physical one the column migration's ADD COLUMN produced.
 */
export const workspaceColumn = () => ({
  workspaceId: text('workspace_id').notNull().$type<WorkspaceId>(),
})

/** The feed row assigns seqs transactionally; pruning never resets its head. */
/**
 * Column groups for the change log, split so no single object literal restates
 * the change-row field list (POD-1251 / `change-row-typings`). The table below
 * spreads them; the detector counts key position, and a spread is not a key.
 * The physical columns are unchanged — this is composition of the declaration,
 * not a migration.
 */
const changeTargetColumns = {
  entity: text().notNull(),
  entityId: text('entity_id').notNull(),
} as const

const changeBodyColumns = {
  /** The entity's wire JSON, serialized. NULL for a `remove`. */
  payload: text(),
  /** The AUTHORITY-assigned commit clock (ADR 1 D3's only legal LWW clock). */
  eventTime: integer('event_time').notNull(),
} as const

/**
 * ADR 2 D8's provenance triple — origin, causation and mutation identity on
 * the ENVELOPE, never in the payload.
 *
 * NULLABLE, and that is the correctness requirement rather than a
 * convenience: every row written before this migration has no provenance to
 * backfill, and inventing one would be worse than absent — a fabricated
 * `causationId` would let a replica retire an outbox entry that this change
 * did not confirm. A change the Authority makes on its own behalf (a boot
 * reconcile, a steward sweep) legitimately has no causing command either, so
 * NULL is a real value here and not just a migration artefact.
 */
const changeProvenanceColumns = {
  originId: text('origin_id'),
  causationId: text('causation_id'),
  mutationId: text('mutation_id').$type<MutationId>(),
} as const

export const changes = sqliteTable(
  'changes',
  {
    workspaceId: text('workspace_id').$type<WorkspaceId>().notNull(),
    seq: integer().notNull(),
    ...changeTargetColumns,
    op: text().notNull(),
    ...changeBodyColumns,
    ...changeProvenanceColumns,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index('changes_entity').on(table.workspaceId, table.entity, table.entityId, table.seq),
    index('changes_event_time').on(table.workspaceId, table.eventTime, table.seq),
  ],
)

/**
 * THE RECEIPT TABLE — framework idempotency's durable half (ADR 2 D11).
 *
 * Retention here is the DEDUPE HORIZON of the feed's write path, and ADR 2 D11
 * owns the rule that binds it: `outbox max age + skew margin < receipt
 * retention`. An outbox entry that outlives the receipt that would dedupe it
 * replays as a fresh command — and the covered procedures include `sendText`,
 * where a replay types into a live agent's terminal twice.
 */
// FEED IDENTITY. The legacy `feed_identity` singleton (ADR 2 D1) was dropped by the keys
// migration (POD-7024, design 2.1): a workspace's feed id and epoch live in its `sync_feed`
// row, which travels with the log exactly as D1 requires.

/**
 * The identity and cursor bounds travel with each workspace's durable log; the
 * row is also the workspace's provisioning record (POD-6959 contract C4).
 * `tenant_id` was renamed `workspace_id` in place (POD-7012): ADR 13's tenant
 * is the workspace, and one name means one thing.
 */
export const syncFeed = sqliteTable(
  'sync_feed',
  {
    workspaceId: text('workspace_id').$type<WorkspaceId>().notNull(),
    feedId: text('feed_id').notNull(),
    epoch: text().notNull(),
    mintedAt: integer('minted_at').notNull(),
    headSeq: integer('head_seq').notNull(),
    /** Oldest retained seq; head + 1 when empty. Cursor + 1 must reach it. */
    floorSeq: integer('floor_seq').notNull(),
  },
  // NOT NULL since the keys migration (POD-7024, POD-7012's finding): a text primary key alone
  // lets SQLite store NULL, and a feed row with no workspace would be no workspace's
  // provisioning record. Declared at table level because drizzle-kit drops NOT NULL from a
  // column-level primary key.
  (table) => [primaryKey({ columns: [table.workspaceId], name: 'sync_feed_pk' })],
)

/**
 * THE LAST ACCESS MOVE OF EACH HUMAN (POD-7552): the highest feed number at
 * which a visibility edge named them in its audience, granted or taken. The
 * Authority writes it when it evaluates a batch (`Authority.broadcast`), whether
 * or not the human has a device connected, so it outlives the change-log rows
 * that show the move. A resume or a reload the log cannot bridge reads it: a
 * cursor below it is answered as a rescope, so a device drops what it showed at
 * once instead of keeping it, stale, through the load.
 *
 * The row with the empty `human_id` ({@link ACCESS_MOVES_SINCE}) is the feed
 * number this table started recording at, written by its migration: a cursor
 * below it predates the table, and the server cannot tell what moved.
 */
export const syncAccessMoves = sqliteTable(
  'sync_access_moves',
  {
    workspaceId: text('workspace_id').$type<WorkspaceId>().notNull(),
    humanId: text('human_id').notNull(),
    seq: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.humanId] })],
)

/** {@link syncAccessMoves}' row naming where recording started, not a human. */
export const ACCESS_MOVES_SINCE = ''

/**
 * POD-7585 — {@link syncAccessMoves}' row holding the RECORDED-THROUGH mark, not a
 * human: every change at or below it has had its access moves recorded. A
 * process that starts, or takes over the workspace's writes, replays the log
 * after it (`Authority.catchUpAccessMoves`). No member id starts with `#`.
 */
export const ACCESS_MOVES_THROUGH = '#through'

/** Absent kinds are at generation zero within their workspace. */
export const syncKind = sqliteTable(
  'sync_kind',
  {
    workspaceId: text('workspace_id').$type<WorkspaceId>().notNull(),
    kind: text().notNull(),
    generation: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.kind] })],
)

/**
 * DERIVED CHANGE CAPTURE (POD-6253 design §3, POD-6920).
 *
 * Which model rows the current write transaction changed. Triggers generated
 * from the record kinds' declarations (`apps/server/src/sync/record-sources.ts`)
 * add one row per changed row a kind reads: the kind, which of its sources,
 * the operation, and the old and new values of the source's key columns as
 * JSON arrays. The Authority drains the table inside the same transaction
 * (`SyncRepository.drainCapture`), so outside a write it is empty, and a
 * transaction only ever sees its own rows (Postgres included).
 *
 * FAIL CLOSED: every row references {@link syncCaptureGuard}, which is always
 * empty, through a DEFERRED foreign key (written by hand in the migration, as
 * drizzle has no spelling for it). A transaction may hold undrained rows while
 * it runs; its COMMIT is refused while any remain, and a write outside a
 * transaction is refused at once. So a model write that was not drained into
 * the log cannot commit.
 */
export const syncCaptureGuard = sqliteTable('sync_capture_guard', {
  id: integer().primaryKey(),
})

export const syncCapture = sqliteTable(
  'sync_capture',
  {
    id: integer().primaryKey(),
    kind: text().notNull(),
    source: integer().notNull(),
    /** `i`, `u` or `d`. */
    op: text().notNull(),
    oldKey: text('old_key'),
    newKey: text('new_key'),
    undrained: integer().notNull().default(0),
  },
  // Declared at table level (this package cannot take the server's
  // `brandedRef`, and the key carries no brand); the migration adds the
  // DEFERRABLE INITIALLY DEFERRED the guard needs.
  (table) => [
    foreignKey({
      name: 'fk_sync_capture_undrained_sync_capture_guard_id_fk',
      columns: [table.undrained],
      foreignColumns: [syncCaptureGuard.id],
    }),
  ],
)

export const appliedMutations = sqliteTable(
  'applied_mutations',
  {
    mutationId: text('mutation_id').$type<MutationId>().notNull(),
    proc: text().notNull(),
    result: text().notNull(),
    appliedAt: integer('applied_at').notNull(),
    ...workspaceColumn(),
  },
  (table) => [
    // Mutation ids come from clients, so the dedupe is per workspace (design 2.7): a global key
    // would let one workspace make another's mutation look applied (POD-7021).
    primaryKey({ columns: [table.workspaceId, table.mutationId], name: 'applied_mutations_pk' }),
    /**
     * The retention sweep's ONLY predicate (POD-1638), within its workspace.
     *
     * `pruneAppliedMutationsBatch` (the janitor's prune, POD-7035) deletes the
     * oldest batch by `applied_at < cutoff`, and without this
     * index that is a full table scan — which is not a 7585-row scan but a scan
     * of every row's `result` payload (~21MB here, ~5000 pages), because a table
     * scan walks the rows themselves. Live attribution caught ONE such call
     * burning 1529ms and deleting NOTHING, blocking the server's single event
     * loop for a second and a half. With the index the sweep SEARCHes the
     * cutoff range, so the steady-state "nothing to prune" case touches no rows
     * at all.
     */
    index('idx_applied_mutations_applied_at').on(table.workspaceId, table.appliedAt),
  ],
)
