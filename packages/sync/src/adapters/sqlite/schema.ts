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
 *                                  because reading a table is not owning it.
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
 * drizzle-orm (a devDependency). Runtime code never imports drizzle-orm — the
 * applier is `apps/server/src/migrations/drizzle-runner.ts`, and this adapter's
 * repository speaks hand-written SQL over the shared connection.
 */

import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * THE CHANGE LOG — the one global sequence (ADR 2 D2).
 *
 * `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the AUTOINCREMENT keyword is
 * load-bearing rather than stylistic: without it SQLite reuses the rowids of
 * deleted rows, and head-pruning (ADR 2 D5) deletes from the TAIL of the log. A
 * reused seq would hand two different changes the same position in the one
 * global sequence, and every replica that had seen the first would silently skip
 * the second. `sqlite_sequence` is also where `maxChangeSeq()` reads the highest
 * seq EVER assigned, which is how the cursor survives pruning.
 */
/**
 * THE FEED'S IDENTITY (ADR 2 D1) — the `(feedId, epoch)` half of a replica's
 * cursor triple. Ported from main at the POD-1246 catch-up, and it lands HERE
 * rather than in `apps/server`'s schema because POD-305 moved `changes` here:
 * the identity of a feed is a property of the log, so the two belong to one
 * owner. Single row — `CHECK (id = 1)` makes "two identities in one database"
 * unrepresentable. A restore rolls the epoch back with the log, which is exactly
 * what `apps/server/src/migrations/restore.ts` then notices and re-mints.
 * Read/written only through `SyncRepository`.
 */
export const syncFeed = sqliteTable(
  'sync_feed',
  {
    id: integer().primaryKey(),
    feedId: text('feed_id').notNull(),
    epoch: text().notNull(),
  },
  (table) => [check('sync_feed_check_1', sql`id = 1`)],
)

export const changes = sqliteTable(
  'changes',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    entity: text().notNull(),
    entityId: text('entity_id').notNull(),
    op: text().notNull(),
    /** The entity's wire JSON, serialized. NULL for a `remove`. */
    payload: text(),
    /** The AUTHORITY-assigned commit clock (ADR 1 D3's only legal LWW clock). */
    eventTime: integer('event_time').notNull(),
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
    originId: text('origin_id'),
    causationId: text('causation_id'),
    mutationId: text('mutation_id'),
  },
  (table) => [
    index('changes_entity').on(table.entity, table.entityId, table.seq),
    index('changes_event_time').on(table.eventTime),
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
export const feedIdentity = sqliteTable('feed_identity', {
  /** Always 1. The schema's way of saying "there is exactly one of these". */
  singleton: integer().primaryKey(),
  feedId: text('feed_id').notNull(),
  epoch: text().notNull(),
  /** When this generation began. Diagnostics only — never compared, never ordered. */
  mintedAt: integer('minted_at').notNull(),
})

export const appliedMutations = sqliteTable('applied_mutations', {
  mutationId: text('mutation_id').primaryKey(),
  proc: text().notNull(),
  result: text().notNull(),
  appliedAt: integer('applied_at').notNull(),
})
