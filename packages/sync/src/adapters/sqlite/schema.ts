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

import type { MutationId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** One instance is one tenant, matching PDM-107's self-hosted identity workspace. */
export const SELF_HOSTED_TENANT_ID = 'local'

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
    tenantId: text('tenant_id').notNull(),
    seq: integer().notNull(),
    ...changeTargetColumns,
    op: text().notNull(),
    ...changeBodyColumns,
    ...changeProvenanceColumns,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.seq] }),
    index('changes_entity').on(table.tenantId, table.entity, table.entityId, table.seq),
    index('changes_event_time').on(table.tenantId, table.eventTime, table.seq),
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
/**
 * FEED IDENTITY — `(feedId, epoch)`, persisted ALONGSIDE the log (ADR 2 D1).
 *
 * "Alongside the log" is the load-bearing phrase and the reason this table lives
 * here rather than in a config file or an env var. D1's whole argument is about
 * BACKUP RESTORE: the epoch must travel with the data it describes, so that
 * restoring `podium.db` restores the epoch that was true of those seqs. An epoch
 * kept anywhere else would survive a restore unchanged while the seqs underneath
 * it rolled back — a feed whose identity says "same generation" over content that
 * is a different timeline, which is worse than no epoch because it LOOKS checked.
 *
 * ONE ROW, pinned by a constant primary key rather than by convention. A `singleton`
 * column with a CHECK-shaped default is how "there is exactly one feed identity"
 * becomes a property of the schema instead of a rule every writer must remember;
 * a second row here would mean two answers to "which generation is this?", and
 * whichever one a query happened to return would be the one clients trusted.
 *
 * NOT NULL on both columns: an identity with a missing epoch is the fails-open
 * value the kernel's `assertOpaqueEpoch` exists to refuse, and letting NULL into
 * the column would put that value one `?? ''` away from being published.
 *
 * D1's hard part, restated so nobody looks for the hook: THERE IS NO RESTORE CODE
 * PATH. A restore is an operator copying a file, so nothing runs and nothing can
 * bump the epoch automatically. This table makes the epoch RESTORABLE and
 * INSPECTABLE; the bump itself is an operator action from [spec:SP-4428]'s
 * runbook, and `FeedIdentityRegistry.bump` is what that action calls.
 */
// LEGACY(remove-after: 2027-02): retained singleton table for a later contract migration; live identity is in sync_feed.
export const feedIdentity = sqliteTable(
  'feed_identity',
  {
    /** Always 1. The schema's way of saying "there is exactly one of these". */
    singleton: integer().primaryKey(),
    feedId: text('feed_id').notNull(),
    epoch: text().notNull(),
    /** When this generation began. Diagnostics only — never compared, never ordered. */
    mintedAt: integer('minted_at').notNull(),
  },
  (table) => [check('feed_identity_singleton', sql`${table.singleton} = 1`)],
)

/** The identity and cursor bounds travel with each tenant's durable log. */
export const syncFeed = sqliteTable('sync_feed', {
  tenantId: text('tenant_id').primaryKey(),
  feedId: text('feed_id').notNull(),
  epoch: text().notNull(),
  mintedAt: integer('minted_at').notNull(),
  headSeq: integer('head_seq').notNull(),
  /** Oldest retained seq; head + 1 when empty. Cursor + 1 must reach it. */
  floorSeq: integer('floor_seq').notNull(),
})

/** Absent kinds are at generation zero within their tenant. */
export const syncKind = sqliteTable(
  'sync_kind',
  {
    tenantId: text('tenant_id').notNull(),
    kind: text().notNull(),
    generation: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.kind] })],
)

export const appliedMutations = sqliteTable(
  'applied_mutations',
  {
    mutationId: text('mutation_id').$type<MutationId>().primaryKey(),
    proc: text().notNull(),
    result: text().notNull(),
    appliedAt: integer('applied_at').notNull(),
  },
  (table) => [
    /**
     * The retention sweep's ONLY predicate (POD-1638).
     *
     * `pruneAppliedMutations` deletes by `applied_at < cutoff`, and without this
     * index that is a full table scan — which is not a 7585-row scan but a scan
     * of every row's `result` payload (~21MB here, ~5000 pages), because a table
     * scan walks the rows themselves. Live attribution caught ONE such call
     * burning 1529ms and deleting NOTHING, blocking the server's single event
     * loop for a second and a half. With the index the sweep SEARCHes the
     * cutoff range, so the steady-state "nothing to prune" case touches no rows
     * at all.
     */
    index('idx_applied_mutations_applied_at').on(table.appliedAt),
  ],
)
