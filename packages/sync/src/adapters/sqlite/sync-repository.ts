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

import { asMutationId, type MutationId, type SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import { and, asc, count, eq, gt, inArray, lt, lte, max, min, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ChangeLogReadRow, ChangeLogWriteRow } from '../../authority/change-lifecycle'
import type { ChangePrunePlan } from '../../change-log'
import { appliedMutations, changeLatest, changes, feedIdentity } from './schema'
import type { QueuedMessagesTable, SyncServerTables, UpstreamOutboxTable } from './server-tables'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './store-queries'

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
  private readonly queuedMessages: QueuedMessagesTable
  private readonly upstreamOutbox: UpstreamOutboxTable
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  /**
   * A GETTER, NOT AN ASSIGNED FIELD [spec rule 34a]. Ambient transaction routing
   * resolves the enclosing span on every access, and a field frozen at
   * construction can never do that; B1 changes this one line, in this one place.
   *
   * Every `this.db` below chains a query IMMEDIATELY and none binds it to a local
   * [rule 34b] — a captured instance survives the span it was read in and serves
   * the wrong connection silently.
   */
  private get db() {
    return this.rootDb
  }

  constructor(queries: StoreQueries, tables: SyncServerTables) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.queuedMessages = tables.queuedMessages
    this.upstreamOutbox = tables.upstreamOutbox
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
  appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): number[] {
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
    this.createOrJoinTransaction(() => {
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize)
        // AN EXPLICIT NULL WHERE THE ORIGINAL OMITTED [spec rule 43], and it is
        // safe on this table for both shapes it takes. `seq` is INTEGER PRIMARY
        // KEY AUTOINCREMENT, where an explicit null auto-assigns exactly as an
        // omission does; the three provenance columns are nullable with no
        // DEFAULT clause, so null IS what the omission stored. No column of
        // `changes` carries a default for an explicit null to defeat.
        const result = this.db
          .insert(changes)
          .values(
            chunk.map((row) => ({
              entity: row.entity,
              entityId: row.entityId,
              op: row.op,
              payload: row.payload,
              eventTime,
            })),
          )
          .run()
        const last = Number(result.lastInsertRowid)
        const first = last - chunk.length + 1
        for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
        this.applyLatestChangeStates(chunk, first)
      }
    })
    this.invalidateLatestChangeStatesCache()
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
  private applyLatestChangeStates(rows: readonly ChangeLogWriteRow[], firstSeq: number): void {
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
        this.db
          .insert(changeLatest)
          .values({
            entity: row.entity,
            entityId: row.entityId,
            seq: firstSeq + i,
            payload: row.payload,
          })
          .onConflictDoUpdate({
            target: [changeLatest.entity, changeLatest.entityId],
            set: { seq: sql`excluded.seq`, payload: sql`excluded.payload` },
          })
          .run()
      } else {
        this.db
          .delete(changeLatest)
          .where(and(eq(changeLatest.entity, row.entity), eq(changeLatest.entityId, row.entityId)))
          .run()
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
  latestChangeStatesGeneration(): number {
    return this.latestChangeStatesGenerationValue
  }

  /** Highest assigned seq ever (survives head-pruning via sqlite_sequence). 0 = none. */
  maxChangeSeq(): number {
    // ABSENT ROW, NOT ZERO, is the empty case: SQLite creates the
    // `sqlite_sequence` entry on the first insert, so a log that has never been
    // written has no row here at all.
    const row = this.db
      .select({ seq: sqliteSequence.seq })
      .from(sqliteSequence)
      .where(eq(sqliteSequence.name, 'changes'))
      .get()
    return row?.seq ?? 0
  }

  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): number | null {
    // An aggregate over an empty table is still ONE row carrying NULL, which is
    // the `null` this returns; the `?? null` is for `.get()`'s optional type, not
    // for a case SQLite produces.
    const row = this.db
      .select({ seq: min(changes.seq) })
      .from(changes)
      .get()
    return row?.seq ?? null
  }

  /**
   * Change rows with seq > cursor, in seq order. The CALLER decides whether the
   * cursor is still within the retained range (see Ledger.changesSince) —
   * this is a plain range read.
   */
  changesSince(cursor: number, limit = 10_000): ChangeLogReadRow[] {
    // FIVE COLUMNS OF NINE, named rather than spread [spec rule 39]: the original
    // statement projected a subset, and a spread would read the four provenance
    // and clock columns nobody here asks for.
    const rows = this.db
      .select({
        seq: changes.seq,
        entity: changes.entity,
        entityId: changes.entityId,
        op: changes.op,
        payload: changes.payload,
      })
      .from(changes)
      .where(gt(changes.seq, cursor))
      .orderBy(asc(changes.seq))
      .limit(limit)
      .all()
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
  planChangePrune(opts: { keepRows: number; maxAgeMs: number; now: number }): ChangePrunePlan {
    const rowCapSeq = this.maxChangeSeq() - opts.keepRows
    // `INDEXED BY` HAS NO BUILDER FORM, so the FROM clause is an `sql` fragment —
    // which rule 1 allows inside a builder query, and which keeps the WHERE, the
    // aggregate and the row decoding on the builder where the rest of this file
    // is. The hint is load-bearing rather than decoration: measured on the
    // fixture, `EXPLAIN QUERY PLAN` reports `SEARCH changes` without it against
    // `SEARCH changes USING COVERING INDEX changes_event_time` with it, and this
    // read runs once per prune job.
    const aged = this.db
      .select({ seq: max(changes.seq) })
      .from(sql`${changes} indexed by ${sql.identifier('changes_event_time')}`)
      .where(lt(changes.eventTime, opts.now - opts.maxAgeMs))
      .get()
    return { thresholdSeq: Math.max(rowCapSeq, aged?.seq ?? 0) }
  }

  /**
   * [spec:SP-c29e] One bounded DELETE using the indexed seq primary key.
   *
   * Touches `changes` ONLY. The installed world is not retained data — see
   * {@link latestChangeStates} — so a prune that also swept it would be deleting
   * the answer to "what is there?" in order to bound the answer to "what changed?".
   */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize = 500): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    if (plan.thresholdSeq <= 0) return 0
    const result = this.db
      .delete(changes)
      .where(
        inArray(
          changes.seq,
          this.db
            .select({ seq: changes.seq })
            .from(changes)
            .where(lte(changes.seq, plan.thresholdSeq))
            .orderBy(asc(changes.seq))
            .limit(batchSize),
        ),
      )
      .run()
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
  latestChangeStates(): ChangeLogReadRow[] {
    if (this.latestChangeStatesCache !== undefined) return this.latestChangeStatesCache
    // FOUR COLUMNS OF FOUR — the whole table, named rather than spread so the
    // projection stays a statement about what this read wants [spec rule 39].
    const rows = this.db
      .select({
        seq: changeLatest.seq,
        entity: changeLatest.entity,
        entityId: changeLatest.entityId,
        payload: changeLatest.payload,
      })
      .from(changeLatest)
      .orderBy(asc(changeLatest.seq))
      .all()
    this.latestChangeStatesCache = rows.map((r) => mapChangeLogReadRow({ ...r, op: 'upsert' }))
    return this.latestChangeStatesCache
  }

  private invalidateLatestChangeStatesCache(): void {
    this.latestChangeStatesCache = undefined
    this.latestChangeStatesGenerationValue++
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(mutationId: MutationId): string | undefined {
    const row = this.db
      .select({ result: appliedMutations.result })
      .from(appliedMutations)
      .where(eq(appliedMutations.mutationId, mutationId))
      .get()
    return row?.result
  }

  recordAppliedMutation(
    mutationId: MutationId,
    proc: string,
    result: string,
    appliedAt: number,
  ): void {
    // `INSERT OR IGNORE` -> `onConflictDoNothing()` [spec rules 31, 31a]. The two
    // forms differ only where a NOT NULL or a CHECK violation is reachable, and
    // on the shipped `applied_mutations` neither is: the table declares no CHECK
    // constraint, and all four of its NOT NULL columns are supplied here from
    // non-nullable parameters. The conflict target is left off deliberately —
    // a bare `on conflict do nothing` covers every uniqueness constraint, which
    // is what `OR IGNORE` did.
    this.db
      .insert(appliedMutations)
      .values({ mutationId, proc, result, appliedAt })
      .onConflictDoNothing()
      .run()
  }

  pruneAppliedMutations(opts: { maxAgeMs: number; now: number }): void {
    this.db
      .delete(appliedMutations)
      .where(lt(appliedMutations.appliedAt, opts.now - opts.maxAgeMs))
      .run()
  }

  /** Enqueue a message; the id IS the mutationId, so a replayed enqueue is a no-op.
   *  Returns false when the id already existed (replay). */
  enqueueMessage(row: {
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
  }): boolean {
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
    const r = this.db
      .insert(this.queuedMessages)
      .values({
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
      })
      .onConflictDoNothing()
      .run()
    return Number(r.changes) > 0
  }

  /** FIFO head-first queue for one session. */
  listQueuedMessages(sessionId: SessionId): {
    id: string
    text: string
    attempts: number
    inputOrigin: ObservationInputOrigin
    principalKind: 'user' | 'agent' | 'system'
    principalRef: string
    delegationRef: string | null
    actorKind: 'user' | 'agent' | 'system'
    actorId: string
    onBehalfOf: string | null
    sourceMessageId: string | null
  }[] {
    // ELEVEN COLUMNS OF THIRTEEN, named [spec rule 39]: `queued_at` and
    // `session_id` are the ordering and the predicate, not part of the answer.
    const rows = this.db
      .select({
        id: this.queuedMessages.id,
        text: this.queuedMessages.text,
        attempts: this.queuedMessages.attempts,
        inputOrigin: this.queuedMessages.inputOrigin,
        principalKind: this.queuedMessages.principalKind,
        principalRef: this.queuedMessages.principalRef,
        delegationRef: this.queuedMessages.delegationRef,
        actorKind: this.queuedMessages.actorKind,
        actorId: this.queuedMessages.actorId,
        onBehalfOf: this.queuedMessages.onBehalfOf,
        sourceMessageId: this.queuedMessages.sourceMessageId,
      })
      .from(this.queuedMessages)
      .where(eq(this.queuedMessages.sessionId, sessionId))
      .orderBy(asc(this.queuedMessages.queuedAt), asc(sql`rowid`))
      .all()
    // The casts are the structural port's, not the driver's — see the field
    // declaration above: an injected table's columns are bare `SQLiteColumn`, so
    // their values arrive `unknown` exactly as they did before the conversion.
    return rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      attempts: r.attempts as number,
      inputOrigin: (r.inputOrigin as ObservationInputOrigin | null) ?? 'unknown',
      principalKind: r.principalKind as 'user' | 'agent' | 'system',
      principalRef: r.principalRef as string,
      delegationRef: (r.delegationRef as string | null) ?? null,
      actorKind: r.actorKind as 'user' | 'agent' | 'system',
      actorId: r.actorId as string,
      onBehalfOf: (r.onBehalfOf as string | null) ?? null,
      sourceMessageId: (r.sourceMessageId as string | null) ?? null,
    }))
  }

  /** Per-session queued counts — the boot seed for Session.queuedMessageCount. */
  queuedMessageCounts(): Map<SessionId, number> {
    const rows = this.db
      .select({ sessionId: this.queuedMessages.sessionId, n: count() })
      .from(this.queuedMessages)
      .groupBy(this.queuedMessages.sessionId)
      .all()
    // SERIALIZATION EDGE: an untyped column re-entering the session id space.
    return new Map(rows.map((r) => [r.sessionId as SessionId, r.n]))
  }

  deleteQueuedMessage(id: string): void {
    this.db.delete(this.queuedMessages).where(eq(this.queuedMessages.id, id)).run()
  }

  bumpQueuedAttempts(id: string): void {
    this.db
      .update(this.queuedMessages)
      .set({ attempts: sql`${this.queuedMessages.attempts} + 1` })
      .where(eq(this.queuedMessages.id, id))
      .run()
  }

  /** The count bounds how many copies ONE CLI process may be typed; a fresh PTY
   *  has received none of them, so a bind clears it (POD-1242). */
  resetQueuedAttempts(id: string): void {
    this.db
      .update(this.queuedMessages)
      .set({ attempts: 0 })
      .where(eq(this.queuedMessages.id, id))
      .run()
  }

  /** Drop a dead session's queue (kill without resume ref, permanent delete). */
  deleteQueuedMessagesForSession(sessionId: SessionId): void {
    this.db.delete(this.queuedMessages).where(eq(this.queuedMessages.sessionId, sessionId)).run()
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
  listParkedUpstreamMutations(): { mutationId: MutationId; proc: string; queuedAt: number }[] {
    // THREE COLUMNS OF FIVE, named [spec rule 39]: `input` is the parked payload
    // this report deliberately does not read, and `attempts` belongs to the
    // retired forwarder.
    const rows = this.db
      .select({
        mutationId: this.upstreamOutbox.mutationId,
        proc: this.upstreamOutbox.proc,
        queuedAt: this.upstreamOutbox.queuedAt,
      })
      .from(this.upstreamOutbox)
      .orderBy(asc(this.upstreamOutbox.queuedAt), asc(sql`rowid`))
      .all()
    return rows.map((r) => ({
      mutationId: asMutationId(r.mutationId as string),
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
  readFeedIdentity(): { feedId: string; epoch: string } | null {
    const row = this.db
      .select({ feedId: feedIdentity.feedId, epoch: feedIdentity.epoch })
      .from(feedIdentity)
      .where(eq(feedIdentity.singleton, 1))
      .get()
    return row === undefined ? null : { feedId: row.feedId, epoch: row.epoch }
  }

  /**
   * Persist the identity. UPSERT on the singleton key, so a bump REPLACES rather
   * than appends: there is exactly one current generation, and a table that could
   * hold two would leave "which epoch is this feed on?" answered by whichever row
   * a query happened to return first.
   */
  writeFeedIdentity(identity: { feedId: string; epoch: string }, mintedAt: number): void {
    // TARGETED ON THE PRIMARY KEY, which is `feed_identity`'s ONLY uniqueness
    // constraint — checked with `pragma index_list` on the migrated table
    // [spec rule 31a].
    this.db
      .insert(feedIdentity)
      .values({ singleton: 1, feedId: identity.feedId, epoch: identity.epoch, mintedAt })
      .onConflictDoUpdate({
        target: feedIdentity.singleton,
        set: {
          feedId: sql`excluded.feed_id`,
          epoch: sql`excluded.epoch`,
          mintedAt: sql`excluded.minted_at`,
        },
      })
      .run()
  }
}
