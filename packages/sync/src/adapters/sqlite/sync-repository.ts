/**
 * Sync aggregate — owns the durable read/write sync machinery:
 * the feed's identity (`feed_identity`, ADR 2 D1), the metadata oplog (`changes`,
 * docs/spec/oplog-read-path.md), the outbox write path (`applied_mutations` +
 * `queued_messages`, docs/spec/outbox-write-path.md) and the node⇄hub
 * issue-write outbox (`upstream_outbox` — ARCHIVED at POD-309: read-only, see
 * `listParkedUpstreamMutations`).
 *
 * `queued_messages` and `upstream_outbox` are the two tables this repository
 * READS BUT DOES NOT OWN: they are declared in `apps/server`'s schema, and a
 * package may not import from `apps/server`. So they are INJECTED — see
 * `./server-tables.ts` for why, and the constructor for what that buys.
 *
 * The QUERY CAPABILITY arrives the same way and for the same reason: the store's
 * drizzle instance and its transaction, narrowed to the two members this adapter
 * uses, through `./store-queries.ts` (POD-3338 for the port, spec §6 rule 20).
 * Before that port this was the only repository in the set still handed a raw
 * `SqlDatabase`, because the seam lives in `apps/server` and a package may not
 * import an app.
 *
 * CONVERTED TO DRIZZLE AT POD-3416 (spec §6 rules 27a, 27b, 34a). The 22
 * hand-written statements that used to run on `.prepare()` are builder queries
 * now; this file names no connection and imports no raw handle. Two of them keep
 * a `sql` fragment for a construct the builder has no form for, and each says so
 * at its site.
 */

import type { MutationId, SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, max, min, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ChangeLogReadRow, ChangeLogWriteRow } from '../../authority/change-lifecycle'
import type { ChangePrunePlan } from '../../change-log'
import { appliedMutations, changeLatest, changes, feedIdentity } from './schema'
import type { QueuedMessagesTable, SyncServerTables, UpstreamOutboxTable } from './server-tables'
import { param, prepared, preparedFamily } from './prepared'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './store-queries'

/**
 * SQLite's OWN autoincrement bookkeeping table, declared so that
 * {@link SyncRepository.maxChangeSeq} can read it through the builder rather
 * than as a whole raw statement.
 *
 * DELIBERATELY NOT IN `./schema.ts`. That file is named in `drizzle.config.ts`,
 * so a table declared there is a table drizzle-kit will try to CREATE — and
 * `sqlite_sequence` is the engine's, created and dropped by SQLite itself the
 * first time an AUTOINCREMENT table is written. Declaring it here keeps it out of
 * the journal while still giving the read the schema's names and types.
 *
 * It is not `sqlite_master` and it is not a `PRAGMA`: this is ordinary table data
 * on SQLite and on Turso alike (measured for the append spike,
 * `store/spike/turso-append/`), which is why the boundary lint's driver-only list
 * does not name it and why the read survives the remote backend.
 */
const sqliteSequence = sqliteTable('sqlite_sequence', {
  name: text().notNull(),
  seq: integer().notNull(),
})

// Every query this repository runs, prepared once per store [POD-6147]. A
// prepared query closes over the store's ONE drizzle instance, whose ambient
// router resolves the enclosing span on every execution; the two
// `change_latest` statements have relied on that since POD-3494.

const upsertLatestChangeState = prepared((db: StoreDrizzle) =>
  db
    .insert(changeLatest)
    .values({
      entity: sql.placeholder('entity'),
      entityId: sql.placeholder('entityId'),
      seq: sql.placeholder('seq'),
      payload: sql.placeholder('payload'),
    })
    .onConflictDoUpdate({
      target: [changeLatest.entity, changeLatest.entityId],
      set: { seq: sql`excluded.seq`, payload: sql`excluded.payload` },
    })
    .prepare(),
)

const deleteLatestChangeState = prepared((db: StoreDrizzle) =>
  db
    .delete(changeLatest)
    .where(
      and(
        eq(changeLatest.entity, sql.placeholder('entity')),
        eq(changeLatest.entityId, sql.placeholder('entityId')),
      ),
    )
    .prepare(),
)

/**
 * One append chunk, keyed by its ROW COUNT (1 to the 100-row chunk of
 * {@link SyncRepository.appendChanges}): a VALUES list cannot be padded the way
 * an IN list can. Row `i` fills `entity${i}`, `entityId${i}`, `op${i}` and
 * `payload${i}`; every row shares `eventTime`.
 */
const insertChangeRows = preparedFamily((db: StoreDrizzle, rows: number) =>
  db
    .insert(changes)
    .values(
      Array.from({ length: rows }, (_, i) => ({
        entity: sql.placeholder(`entity${i}`),
        entityId: sql.placeholder(`entityId${i}`),
        op: sql.placeholder(`op${i}`),
        payload: sql.placeholder(`payload${i}`),
        eventTime: sql.placeholder('eventTime'),
      })),
    )
    .prepare(),
)

const highestAssignedSeq = prepared((db: StoreDrizzle) =>
  db
    .select({ seq: sqliteSequence.seq })
    .from(sqliteSequence)
    .where(eq(sqliteSequence.name, 'changes'))
    .prepare(),
)

const lowestRetainedSeq = prepared((db: StoreDrizzle) =>
  db
    .select({ seq: min(changes.seq) })
    .from(changes)
    .prepare(),
)

// FIVE COLUMNS OF NINE, named rather than spread [spec rule 39]: the original
// statement projected a subset, and a spread would read the four provenance
// and clock columns nobody here asks for.
const changesAfter = prepared((db: StoreDrizzle) =>
  db
    .select({
      seq: changes.seq,
      entity: changes.entity,
      entityId: changes.entityId,
      op: changes.op,
      payload: changes.payload,
    })
    .from(changes)
    .where(gt(changes.seq, param(changes.seq, 'cursor')))
    .orderBy(asc(changes.seq))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const changesBetween = prepared((db: StoreDrizzle) =>
  db
    .select({
      seq: changes.seq,
      entity: changes.entity,
      entityId: changes.entityId,
      op: changes.op,
      payload: changes.payload,
    })
    .from(changes)
    .where(and(gt(changes.seq, param(changes.seq, 'from')), lte(changes.seq, param(changes.seq, 'through'))))
    .orderBy(asc(changes.seq))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

// `INDEXED BY` HAS NO BUILDER FORM, so the FROM clause is an `sql` fragment —
// see {@link SyncRepository.planChangePrune}.
const newestAgedSeq = prepared((db: StoreDrizzle) =>
  db
    .select({ seq: max(changes.seq) })
    .from(sql`${changes} indexed by ${sql.identifier('changes_event_time')}`)
    .where(lt(changes.eventTime, param(changes.eventTime, 'before')))
    .prepare(),
)

const deleteChangeHead = prepared((db: StoreDrizzle) =>
  db
    .delete(changes)
    .where(
      inArray(
        changes.seq,
        db
          .select({ seq: changes.seq })
          .from(changes)
          .where(lte(changes.seq, param(changes.seq, 'thresholdSeq')))
          .orderBy(asc(changes.seq))
          .limit(sql.placeholder('batchSize')),
      ),
    )
    .prepare(),
)

// FOUR COLUMNS OF FOUR — the whole table, named rather than spread so the
// projection stays a statement about what this read wants [spec rule 39].
const installedWorld = prepared((db: StoreDrizzle) =>
  db
    .select({
      seq: changeLatest.seq,
      entity: changeLatest.entity,
      entityId: changeLatest.entityId,
      payload: changeLatest.payload,
    })
    .from(changeLatest)
    .prepare(),
)

const appliedMutationResult = prepared((db: StoreDrizzle) =>
  db
    .select({ result: appliedMutations.result })
    .from(appliedMutations)
    .where(eq(appliedMutations.mutationId, param(appliedMutations.mutationId, 'mutationId')))
    .prepare(),
)

const insertAppliedMutation = prepared((db: StoreDrizzle) =>
  db
    .insert(appliedMutations)
    .values({
      mutationId: sql.placeholder('mutationId'),
      proc: sql.placeholder('proc'),
      result: sql.placeholder('result'),
      appliedAt: sql.placeholder('appliedAt'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteAppliedMutationsBefore = prepared((db: StoreDrizzle) =>
  db
    .delete(appliedMutations)
    .where(lt(appliedMutations.appliedAt, param(appliedMutations.appliedAt, 'before')))
    .prepare(),
)

const currentFeedIdentity = prepared((db: StoreDrizzle) =>
  db
    .select({ feedId: feedIdentity.feedId, epoch: feedIdentity.epoch })
    .from(feedIdentity)
    .where(eq(feedIdentity.singleton, 1))
    .prepare(),
)

const upsertFeedIdentity = prepared((db: StoreDrizzle) =>
  db
    .insert(feedIdentity)
    .values({
      singleton: 1,
      feedId: sql.placeholder('feedId'),
      epoch: sql.placeholder('epoch'),
      mintedAt: sql.placeholder('mintedAt'),
    })
    .onConflictDoUpdate({
      target: feedIdentity.singleton,
      set: {
        feedId: sql`excluded.feed_id`,
        epoch: sql`excluded.epoch`,
        mintedAt: sql`excluded.minted_at`,
      },
    })
    .prepare(),
)

/**
 * The statements over the two INJECTED tables, prepared once per store like
 * the rest. They are built from the table objects the composition root hands
 * in, so they are defined per repository rather than at module level; each
 * definition still prepares once per drizzle instance.
 */
function serverTableQueries(queued: QueuedMessagesTable, upstream: UpstreamOutboxTable) {
  return {
    insertQueued: prepared((db: StoreDrizzle) =>
      db
        .insert(queued)
        .values({
          id: sql.placeholder('id'),
          sessionId: sql.placeholder('sessionId'),
          text: sql.placeholder('text'),
          queuedAt: sql.placeholder('queuedAt'),
          inputOrigin: sql.placeholder('inputOrigin'),
          principalKind: sql.placeholder('principalKind'),
          principalRef: sql.placeholder('principalRef'),
          delegationRef: sql.placeholder('delegationRef'),
          actorKind: sql.placeholder('actorKind'),
          actorId: sql.placeholder('actorId'),
          onBehalfOf: sql.placeholder('onBehalfOf'),
          sourceMessageId: sql.placeholder('sourceMessageId'),
          delivery: sql.placeholder('delivery'),
          attachmentsJson: sql.placeholder('attachmentsJson'),
        })
        .onConflictDoNothing()
        .prepare(),
    ),

    // SIXTEEN COLUMNS OF SEVENTEEN, named [spec rule 39]: `session_id` is the
    // predicate, not part of the answer. `queued_at` is the ordering AND an
    // answer since POD-4360: the inbox compares it against the transcript to
    // recognise a row a previous server process already delivered.
    queuedOfSession: prepared((db: StoreDrizzle) =>
      db
        .select({
          id: queued.id,
          text: queued.text,
          queuedAt: queued.queuedAt,
          attempts: queued.attempts,
          deliveryOwner: queued.deliveryOwner,
          inputOrigin: queued.inputOrigin,
          principalKind: queued.principalKind,
          principalRef: queued.principalRef,
          delegationRef: queued.delegationRef,
          actorKind: queued.actorKind,
          actorId: queued.actorId,
          onBehalfOf: queued.onBehalfOf,
          sourceMessageId: queued.sourceMessageId,
          delivery: queued.delivery,
          attachmentsJson: queued.attachmentsJson,
          retractRequestedAt: queued.retractRequestedAt,
        })
        .from(queued)
        .where(eq(queued.sessionId, param(queued.sessionId, 'sessionId')))
        .orderBy(asc(queued.queuedAt), asc(sql`rowid`))
        .prepare(),
    ),

    /** Keyed by the restriction: none, one session, or a set of sessions. */
    queuedCounts: preparedFamily((db: StoreDrizzle, scope: 'all' | 'one' | 'set') =>
      db
        .select({ sessionId: queued.sessionId, n: count() })
        .from(queued)
        .where(scope === 'all' ? undefined : scope === 'one'
          ? eq(queued.sessionId, param(queued.sessionId, 'sessionId'))
          // One bound JSON value keeps a fleet-sized set below SQLite's parameter limit.
          : inArray(queued.sessionId, sql`(select value from json_each(${sql.placeholder('sessionIds')}))`))
        .groupBy(queued.sessionId)
        .prepare(),
    ),

    deleteQueued: prepared((db: StoreDrizzle) =>
      db.delete(queued).where(eq(queued.id, param(queued.id, 'id'))).prepare(),
    ),

    deleteUnreservedQueued: prepared((db: StoreDrizzle) =>
      db
        .delete(queued)
        .where(and(eq(queued.id, param(queued.id, 'id')), isNull(queued.deliveryOwner)))
        .prepare(),
    ),

    requestQueuedRetract: prepared((db: StoreDrizzle) =>
      db
        .update(queued)
        .set({ retractRequestedAt: sql`coalesce(${queued.retractRequestedAt}, ${sql.placeholder('at')})` })
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),

    clearQueuedRetract: prepared((db: StoreDrizzle) =>
      db
        .update(queued)
        .set({ retractRequestedAt: null })
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),

    reserveQueuedDelivery: prepared((db: StoreDrizzle) =>
      db.update(queued)
        .set({ deliveryOwner: 'daemon', attempts: sql`max(${queued.attempts}, 1)` })
        .where(eq(queued.id, param(queued.id, 'id'))).prepare(),
    ),

    releaseQueuedDelivery: prepared((db: StoreDrizzle) =>
      db.update(queued)
        .set({ deliveryOwner: null, attempts: sql.placeholder('attempts') })
        .where(and(eq(queued.id, param(queued.id, 'id')), eq(queued.deliveryOwner, 'daemon'))).prepare(),
    ),

    bumpQueuedAttempts: prepared((db: StoreDrizzle) =>
      db
        .update(queued)
        .set({ attempts: sql`${queued.attempts} + 1` })
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),

    resetQueuedAttempts: prepared((db: StoreDrizzle) =>
      db
        .update(queued)
        .set({ attempts: 0 })
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),

    deleteQueuedOfSession: prepared((db: StoreDrizzle) =>
      db.delete(queued).where(eq(queued.sessionId, param(queued.sessionId, 'sessionId'))).prepare(),
    ),

    // THREE COLUMNS OF FIVE, named [spec rule 39]: `input` is the parked payload
    // this report deliberately does not read, and `attempts` belongs to the
    // retired forwarder.
    parkedUpstream: prepared((db: StoreDrizzle) =>
      db
        .select({
          mutationId: upstream.mutationId,
          proc: upstream.proc,
          queuedAt: upstream.queuedAt,
        })
        .from(upstream)
        .orderBy(asc(upstream.queuedAt), asc(sql`rowid`))
        .prepare(),
    ),
  }
}

/**
 * Map a selected `changes` row onto the composed lifecycle read shape.
 *
 * THE CASTS ARE THE UNION, NOT THE DRIVER. `entity` and `op` are `text()`
 * columns, so drizzle hands back `string`; {@link ChangeLogReadRow} narrows both
 * to the model's unions. That is a decision the column cannot carry and it stays
 * (rule 6). Every other field arrives already typed, which is what the conversion
 * bought: the `Record<string, unknown>` this mapper used to take is gone.
 */
function mapChangeLogReadRow(r: {
  seq: number
  entity: string
  entityId: string
  op: string
  payload: string | null
}): ChangeLogReadRow {
  return {
    seq: r.seq,
    entity: r.entity as ChangeLogReadRow['entity'],
    entityId: r.entityId,
    op: r.op as ChangeLogReadRow['op'],
    payload: r.payload,
  }
}

export class SyncRepository {
  /**
   * The latest-state fold is a snapshot of the retained change log. Visibility
   * callbacks can ask for several rows during one synchronous delivery, so
   * retaining the materialized rows avoids folding the same table once per
   * subject. The generation is also exposed to the composition root: a
   * re-entrant append must make its next authorization read build a new view.
   */
  private latestChangeStatesCache: ChangeLogReadRow[] | undefined
  private latestChangeStatesGenerationValue = 0

  /**
   * The two server-owned tables, as the drizzle objects the composition root
   * hands in rather than spelled out in the SQL below. That is the whole point of
   * the injection: this file no longer names a table `apps/server` owns, so the
   * declaration stays single and the queries below are built from the real table
   * objects.
   *
   * WHAT THE STRUCTURAL PORT COSTS, stated so nobody reads it as an oversight:
   * `./server-tables.ts` types their columns as bare `SQLiteColumn`, because
   * naming `typeof queuedMessages` is the import the port exists to avoid. So a
   * read of one of these two tables comes back with `unknown` values and its
   * mapper still casts, exactly as it did before the conversion — the four tables
   * this adapter OWNS get rule 3's names and types through `./schema.ts`.
   */
  private readonly serverTables: ReturnType<typeof serverTableQueries>
  /** The store's one drizzle instance; the executor routes each statement to the current transaction. */
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  private get db() {
    return this.rootDb
  }

  constructor(queries: StoreQueries, tables: SyncServerTables) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.serverTables = serverTableQueries(tables.queuedMessages, tables.upstreamOutbox)
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — the whole batch commits inside BEGIN IMMEDIATE, so no interleaving).
   * The caller (Ledger) has already deduped; rows arrive only for real changes.
   *
   * Row type is {@link ChangeLogWriteRow} — composed from the lifecycle shape,
   * not restated here (POD-1251).
   */
  async appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): Promise<number[]> {
    if (rows.length === 0) return []
    const seqs: number[] = []
    // Stay below SQLite's conservative 999-parameter builds (100 × 5 = 500)
    // while collapsing a live-scale reconcile from hundreds of statements to a
    // handful. One outer transaction preserves the contiguous, non-interleaved
    // sequence contract across every chunk.
    //
    // STILL FIVE PARAMETERS PER ROW after the conversion, verified by printing
    // the statement: drizzle names all nine columns but emits a literal `null`
    // for `seq` and for the three provenance columns rather than binding them,
    // so the chunk size still buys the same headroom it was chosen for.
    const chunkSize = 100
    await this.createOrJoinTransaction(async () => {
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize)
        // AN EXPLICIT NULL WHERE THE ORIGINAL OMITTED [spec rule 43], and it is
        // safe on this table for both shapes it takes. `seq` is INTEGER PRIMARY
        // KEY AUTOINCREMENT, where an explicit null auto-assigns exactly as an
        // omission does; the three provenance columns are nullable with no
        // DEFAULT clause, so null IS what the omission stored. No column of
        // `changes` carries a default for an explicit null to defeat.
        const values: Record<string, unknown> = { eventTime }
        chunk.forEach((row, i) => {
          values[`entity${i}`] = row.entity
          values[`entityId${i}`] = row.entityId
          values[`op${i}`] = row.op
          values[`payload${i}`] = row.payload
        })
        const result = await insertChangeRows(this.db, chunk.length).run(values)
        const last = Number(result.lastInsertRowid)
        const first = last - chunk.length + 1
        for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
        await this.applyLatestChangeStates(chunk, first)
      }
    })
    await this.invalidateLatestChangeStatesCache()
    return seqs
  }

  /**
   * Advance the installed world (`change_latest`) for one appended chunk, INSIDE
   * the append's transaction — so the world can never describe a change the log
   * does not hold, or miss one it does.
   *
   * ROW BY ROW, IN ORDER, and that is not a missed batching opportunity: a batch
   * may legitimately carry `upsert` then `remove` for one entity (a first-sight
   * row that is gone by the end of the same reconcile), and grouping the two ops
   * into bulk statements would apply them in op order rather than log order —
   * leaving the removed entity installed. Sequenced statements inside one
   * transaction are what make "last write in the batch wins" true here for the
   * same reason it is true in the log.
   */
  private async applyLatestChangeStates(rows: readonly ChangeLogWriteRow[], firstSeq: number): Promise<void> {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ChangeLogWriteRow
      // A payload-less upsert is the corrupt row every reader of the fold already
      // skips, so the world it describes is "this entity is not installed" — which
      // is what the delete arm writes. Storing it instead would put a NULL where
      // the column says NOT NULL; keeping the PREVIOUS state would be worse still,
      // since the folded log never showed it once a corrupt row landed on top.
      if (row.op === 'upsert' && row.payload !== null) {
        // TARGETED ON THE PRIMARY KEY, which is `change_latest`'s ONLY uniqueness
        // constraint — checked with `pragma index_list` on the migrated table, so
        // no conflict can arrive on a constraint this target does not cover
        // [spec rule 31a].
        await upsertLatestChangeState(this.db).run({
          entity: row.entity,
          entityId: row.entityId,
          seq: firstSeq + i,
          payload: row.payload,
        })
      } else {
        await deleteLatestChangeState(this.db).run({ entity: row.entity, entityId: row.entityId })
      }
    }
  }

  /**
   * Monotonic generation for the installed-world view. It changes after every
   * append; callers use it to bound a larger per-pass index without caching
   * authorization data across a durable change.
   *
   * A PRUNE NO LONGER BUMPS IT (POD-678), because a prune no longer alters what
   * `latestChangeStates` returns — retention deletes from `changes`, and the world
   * lives in `change_latest`. Invalidating on prune would only throw away a valid
   * read cache on a timer.
   */
  async latestChangeStatesGeneration(): Promise<number> {
    return this.latestChangeStatesGenerationValue
  }

  /** Highest assigned seq ever (survives head-pruning via sqlite_sequence). 0 = none. */
  async maxChangeSeq(): Promise<number> {
    // ABSENT ROW, NOT ZERO, is the empty case: SQLite creates the
    // `sqlite_sequence` entry on the first insert, so a log that has never been
    // written has no row here at all.
    const row = await highestAssignedSeq(this.db).get()
    return row?.seq ?? 0
  }

  /** Lowest RETAINED seq, or null when the log is empty. */
  async minChangeSeq(): Promise<number | null> {
    // An aggregate over an empty table is still ONE row carrying NULL, which is
    // the `null` this returns; the `?? null` is for `.get()`'s optional type, not
    // for a case SQLite produces.
    const row = await lowestRetainedSeq(this.db).get()
    return row?.seq ?? null
  }

  /**
   * Change rows with seq > cursor, in seq order. The CALLER decides whether the
   * cursor is still within the retained range (see Ledger.changesSince) —
   * this is a plain range read.
   */
  async changesSince(cursor: number, limit = 10_000): Promise<ChangeLogReadRow[]> {
    const rows = await changesAfter(this.db).all({ cursor, limit })
    return rows.map((r) => mapChangeLogReadRow(r))
  }

  /** Read exactly (from, through], with a bounded page size. */
  async changesInRange(from: number, through: number, limit: number): Promise<ChangeLogReadRow[]> {
    const rows = await changesBetween(this.db).all({ from, through, limit })
    return rows.map((r) => mapChangeLogReadRow(r))
  }

  /**
   * Head-only retention: drop rows beyond the row budget (keep the newest
   * `keepRows`) OR older than the age budget — whichever deletes MORE. The old
   * AND-policy never pruned under sustained write rates (rows aged past the age
   * budget only after the table had grown unboundedly). Deletion is still
   * head-only: we compute the highest seq that satisfies either budget and delete
   * snapshot it once per job, so even the indexed age-threshold scan does not
   * recur inside every bounded delete unit. Rows appended after the snapshot are
   * intentionally handled by the next job.
   */
  async planChangePrune(opts: { keepRows: number; maxAgeMs: number; now: number }): Promise<ChangePrunePlan> {
    const rowCapSeq = await this.maxChangeSeq() - opts.keepRows
    // `INDEXED BY` HAS NO BUILDER FORM, so the FROM clause is an `sql` fragment —
    // which rule 1 allows inside a builder query, and which keeps the WHERE, the
    // aggregate and the row decoding on the builder where the rest of this file
    // is. The hint is load-bearing rather than decoration: measured on the
    // fixture, `EXPLAIN QUERY PLAN` reports `SEARCH changes` without it against
    // `SEARCH changes USING COVERING INDEX changes_event_time` with it, and this
    // read runs once per prune job.
    const aged = await newestAgedSeq(this.db).get({ before: opts.now - opts.maxAgeMs })
    return { thresholdSeq: Math.max(rowCapSeq, aged?.seq ?? 0) }
  }

  /**
   * [spec:SP-c29e] One bounded DELETE using the indexed seq primary key.
   *
   * Touches `changes` ONLY. The installed world is not retained data — see
   * {@link latestChangeStates} — so a prune that also swept it would be deleting
   * the answer to "what is there?" in order to bound the answer to "what changed?".
   */
  async pruneChangeBatch(plan: ChangePrunePlan, batchSize = 500): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    if (plan.thresholdSeq <= 0) return 0
    const result = await deleteChangeHead(this.db).run({ thresholdSeq: plan.thresholdSeq, batchSize })
    return Number(result.changes)
  }

  /**
   * THE INSTALLED WORLD — the latest state per (entity, id): the boot seed for the
   * Ledger's dedup baseline (so a restart emits deltas for anything that changed
   * while the server was down instead of silently rebasing) and the bootstrap read
   * a client's whole world is built from.
   *
   * Read from `change_latest`, NOT folded from `changes` (POD-678). The fold over
   * the log was only ever as complete as retention left it, and retention is a
   * WINDOW: on the live install the 20k row budget bit after ~27 hours, so this
   * returned 66 of 631 issues and every client that attached afterwards resolved
   * the other 565 as unknown references. The projection is maintained by the one
   * writer that appends the log and is never pruned, so "what is there?" stops
   * depending on how recently it was written.
   *
   * ONLY LIVE UPSERTS come back, where the fold used to also return `remove`
   * tombstones. No consumer read them: the bootstrap, the baseline seed and the
   * visibility read cache all skip non-upsert rows before doing anything.
   */
  async latestChangeStates(): Promise<ChangeLogReadRow[]> {
    if (this.latestChangeStatesCache !== undefined) return this.latestChangeStatesCache
    const rows = await installedWorld(this.db).all()
    // Read payload pages in table order. ORDER BY seq chooses change_latest_seq
    // and scatters a full-world read across the DB (14.9s on the 1GB incident
    // copy). Preserve the public sequence order with an in-memory numeric sort.
    rows.sort((a, b) => a.seq - b.seq)
    this.latestChangeStatesCache = rows.map((r) => mapChangeLogReadRow({ ...r, op: 'upsert' }))
    return this.latestChangeStatesCache
  }

  private async invalidateLatestChangeStatesCache(): Promise<void> {
    this.latestChangeStatesCache = undefined
    this.latestChangeStatesGenerationValue++
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  async getAppliedMutation(mutationId: MutationId): Promise<string | undefined> {
    const row = await appliedMutationResult(this.db).get({ mutationId })
    return row?.result
  }

  async recordAppliedMutation(
    mutationId: MutationId,
    proc: string,
    result: string,
    appliedAt: number,
  ): Promise<void> {
    // `INSERT OR IGNORE` -> `onConflictDoNothing()` [spec rules 31, 31a]. The two
    // forms differ only where a NOT NULL or a CHECK violation is reachable, and
    // on the shipped `applied_mutations` neither is: the table declares no CHECK
    // constraint, and all four of its NOT NULL columns are supplied here from
    // non-nullable parameters. The conflict target is left off deliberately —
    // a bare `on conflict do nothing` covers every uniqueness constraint, which
    // is what `OR IGNORE` did.
    await insertAppliedMutation(this.db).run({ mutationId, proc, result, appliedAt })
  }

  async pruneAppliedMutations(opts: { maxAgeMs: number; now: number }): Promise<void> {
    await deleteAppliedMutationsBefore(this.db).run({ before: opts.now - opts.maxAgeMs })
  }

  /** Enqueue a message; the id IS the mutationId, so a replayed enqueue is a no-op.
   *  Returns false when the id already existed (replay). */
  async enqueueMessage(row: {
    id: string
    sessionId: SessionId
    text: string
    queuedAt: number
    inputOrigin?: ObservationInputOrigin
    principalKind?: 'user' | 'agent' | 'system'
    principalRef?: string
    delegationRef?: string | null
    actorKind?: 'user' | 'agent' | 'system'
    actorId?: string
    onBehalfOf?: string | null
    sourceMessageId?: string | null
    delivery?: 'when-ready' | 'interrupt' | 'steer'
    attachmentsJson?: string | null
  }): Promise<boolean> {
    // `INSERT OR IGNORE` -> `onConflictDoNothing()` [spec rules 31, 31a], and this
    // table is the one that needs the enumeration spelled out because it DOES
    // carry CHECK constraints. `queued_messages_principal_kind` and
    // `queued_messages_actor_kind` admit only 'user' | 'agent' | 'system', which
    // is exactly the union this parameter declares for both fields, so neither
    // CHECK is reachable from a caller the compiler accepts. Every NOT NULL
    // column is supplied from a non-nullable source: the four required
    // parameters, and a `??` fallback for each optional one.
    //
    // `attempts` IS THE RULE 43 SITE. The original omitted it and let the column
    // DEFAULT 0 apply; drizzle names every column it knows, so the conversion
    // binds a value — and the value it binds is 0, the default DECLARED on the
    // injected table object, not a null. That holds because the declaration
    // agrees with the shipped DDL, which is what `schema.test.ts` pins. Printed
    // to confirm, rather than reasoned from the builder.
    const r = await this.serverTables.insertQueued(this.db).run({
      id: row.id,
      sessionId: row.sessionId,
      text: row.text,
      queuedAt: row.queuedAt,
      inputOrigin: row.inputOrigin ?? 'unknown',
      principalKind: row.principalKind ?? 'system',
      principalRef: row.principalRef ?? 'legacy-session-inbox',
      delegationRef: row.delegationRef ?? null,
      actorKind: row.actorKind ?? 'system',
      actorId: row.actorId ?? 'legacy-session-inbox',
      onBehalfOf: row.onBehalfOf ?? null,
      sourceMessageId: row.sourceMessageId ?? null,
      delivery: row.delivery ?? 'when-ready',
      attachmentsJson: row.attachmentsJson ?? null,
    })
    return Number(r.changes) > 0
  }

  /** FIFO head-first queue for one session. */
  async listQueuedMessages(sessionId: SessionId): Promise<
    {
      id: string
      text: string
      queuedAt: number
      attempts: number
      deliveryOwner: string | null
      inputOrigin: ObservationInputOrigin
      principalKind: 'user' | 'agent' | 'system'
      principalRef: string
      delegationRef: string | null
      actorKind: 'user' | 'agent' | 'system'
      actorId: string
      onBehalfOf: string | null
      sourceMessageId: string | null
      delivery: 'when-ready' | 'interrupt' | 'steer'
      attachmentsJson: string | null
      retractRequestedAt: number | null
    }[]
  > {
    const rows = await this.serverTables.queuedOfSession(this.db).all({ sessionId })
    // Non-identity values stay unknown at the narrow structural port and are
    // decoded here. Branded identity columns name their data types in the port.
    return rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      queuedAt: Number(r.queuedAt),
      attempts: r.attempts as number,
      deliveryOwner: (r.deliveryOwner as string | null) ?? null,
      inputOrigin: (r.inputOrigin as ObservationInputOrigin | null) ?? 'unknown',
      principalKind: r.principalKind as 'user' | 'agent' | 'system',
      principalRef: r.principalRef as string,
      delegationRef: (r.delegationRef as string | null) ?? null,
      actorKind: r.actorKind as 'user' | 'agent' | 'system',
      actorId: r.actorId as string,
      onBehalfOf: (r.onBehalfOf as string | null) ?? null,
      sourceMessageId: (r.sourceMessageId as string | null) ?? null,
      // An unknown mode reads as the one every row had before modes existed.
      delivery: r.delivery === 'interrupt' || r.delivery === 'steer' ? r.delivery : 'when-ready',
      attachmentsJson: (r.attachmentsJson as string | null) ?? null,
      retractRequestedAt: r.retractRequestedAt == null ? null : Number(r.retractRequestedAt),
    }))
  }

  /** Read current queue sizes, optionally restricted to one session or one set. */
  async queuedMessageCounts(sessionId?: SessionId | readonly SessionId[]): Promise<Map<SessionId, number>> {
    const rows = sessionId === undefined
      ? await this.serverTables.queuedCounts(this.db, 'all').all()
      : typeof sessionId === 'string'
        ? await this.serverTables.queuedCounts(this.db, 'one').all({ sessionId })
        : await this.serverTables.queuedCounts(this.db, 'set').all({ sessionIds: JSON.stringify(sessionId) })
    return new Map(rows.map((r) => [r.sessionId, r.n]))
  }

  async deleteQueuedMessage(id: string): Promise<void> {
    await this.serverTables.deleteQueued(this.db).run({ id })
  }

  /** Delete a row only while no daemon has custody of it (POD-4776): the one
   *  statement a retract and {@link reserveQueuedDelivery} race through, so
   *  exactly one of them wins. Answers whether THIS call deleted it. */
  async deleteUnreservedQueuedMessage(id: string): Promise<boolean> {
    const r = await this.serverTables.deleteUnreservedQueued(this.db).run({ id })
    return Number(r.changes) > 0
  }

  /** A retract of a daemon-held row is on its way (POD-4776): until the daemon
   *  answers it, every forward sends the retract instead of the row. The first
   *  request's time is kept. */
  async requestQueuedRetract(id: string, at: number): Promise<void> {
    await this.serverTables.requestQueuedRetract(this.db).run({ id, at })
  }

  /** The daemon answered the retract "too late": the row goes on as it was. */
  async clearQueuedRetract(id: string): Promise<void> {
    await this.serverTables.clearQueuedRetract(this.db).run({ id })
  }

  /** Reserve custody before the RPC. A crash after this commit is ambiguous,
   * never permission to type the row again on a replacement daemon. */
  async reserveQueuedDelivery(id: string): Promise<void> {
    await this.serverTables.reserveQueuedDelivery(this.db).run({ id })
  }

  /** Undo {@link reserveQueuedDelivery} after a refusal that proves nothing
   * was written (POD-4622). It writes only a row that is still reserved, so it
   * cannot mark a row the inbox never reserved as fresh. */
  async releaseQueuedDelivery(id: string, attempts: number): Promise<void> {
    await this.serverTables.releaseQueuedDelivery(this.db).run({ id, attempts })
  }

  async bumpQueuedAttempts(id: string): Promise<void> {
    await this.serverTables.bumpQueuedAttempts(this.db).run({ id })
  }

  /** The count bounds how many copies ONE CLI process may be typed; a fresh PTY
   *  has received none of them, so a bind clears it (POD-1242). */
  async resetQueuedAttempts(id: string): Promise<void> {
    await this.serverTables.resetQueuedAttempts(this.db).run({ id })
  }

  /** Drop a dead session's queue (kill without resume ref, permanent delete). */
  async deleteQueuedMessagesForSession(sessionId: SessionId): Promise<void> {
    await this.serverTables.deleteQueuedOfSession(this.db).run({ sessionId })
  }

  // ---- ARCHIVED: the retired node→hub issue-write outbox (POD-309) ----

  /**
   * Rows still sitting in `upstream_outbox` — issue mutations a NODE queued for a hub
   * it could not reach, at the moment federation was deferred ([spec:SP-0371]).
   *
   * The enqueue / delete / attempt-bump half of this table is GONE with
   * `UpstreamForwarder`; this read survives alone, and deliberately. ADR 5 D8 permits
   * archiving the schema but forbids "silent discard of poison/pending work", so the
   * rows are parked exactly where they are and `reportParkedUpstreamMutations` (server
   * boot) tells the operator they exist. A read with no writer cannot resurrect the
   * forwarding path; a table quietly dropped would have taken the evidence with it.
   */
  async listParkedUpstreamMutations(): Promise<{ mutationId: MutationId; proc: string; queuedAt: number }[]> {
    const rows = await this.serverTables.parkedUpstream(this.db).all()
    return rows.map((r) => ({
      mutationId: r.mutationId,
      proc: r.proc as string,
      queuedAt: Number(r.queuedAt),
    }))
  }

  // ---- feed identity (ADR 2 D1) ----

  /**
   * The durable half of `FeedIdentityStore`, so the kernel port has a real
   * implementation rather than only a shape.
   *
   * The kernel owns the SEMANTICS — minting, the never-a-counter rule, and the
   * refusal to bump to the epoch it is replacing — and this owns only the row.
   * That split is why `assertOpaqueEpoch` is not repeated here: a second copy of
   * the rule in SQL would be a second definition able to disagree with the first,
   * and the one that runs would depend on which door the write came through.
   */
  async readFeedIdentity(): Promise<{ feedId: string; epoch: string } | null> {
    const row = await currentFeedIdentity(this.db).get()
    return row === undefined ? null : { feedId: row.feedId, epoch: row.epoch }
  }

  /**
   * Persist the identity. UPSERT on the singleton key, so a bump REPLACES rather
   * than appends: there is exactly one current generation, and a table that could
   * hold two would leave "which epoch is this feed on?" answered by whichever row
   * a query happened to return first.
   */
  async writeFeedIdentity(identity: { feedId: string; epoch: string }, mintedAt: number): Promise<void> {
    // TARGETED ON THE PRIMARY KEY, which is `feed_identity`'s ONLY uniqueness
    // constraint — checked with `pragma index_list` on the migrated table
    // [spec rule 31a].
    await upsertFeedIdentity(this.db).run({ feedId: identity.feedId, epoch: identity.epoch, mintedAt })
  }
}
