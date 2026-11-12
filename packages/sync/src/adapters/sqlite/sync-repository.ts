/**
 * Sync aggregate — owns the durable read/write sync machinery:
 * the tenant feed (`sync_feed`, ADR 2 D1), the metadata oplog (`changes`,
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
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, max, sql } from 'drizzle-orm'
import type { ChangeLogReadRow, ChangeLogWriteRow } from '../../authority/change-lifecycle'
import type { ChangePrunePlan } from '../../change-log'
import { inListOf, inListSize, inListValues, param, prepared, preparedFamily } from './prepared'
import { appliedMutations, changes, SELF_HOSTED_TENANT_ID, syncFeed, syncKind } from './schema'
import type { QueuedMessagesTable, SyncServerTables, UpstreamOutboxTable } from './server-tables'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './store-queries'

// One row per registered kind in this tenant, independent of record count.
const kindGenerations = prepared((db: StoreDrizzle) =>
  db
    .select({ kind: syncKind.kind, generation: syncKind.generation })
    .from(syncKind)
    .where(eq(syncKind.tenantId, param(syncKind.tenantId, 'tenantId')))
    .prepare(),
)

/** UPDATE holds this tenant's row lock until the surrounding write commits.
 * Postgres uses the same UPDATE ... RETURNING contract; it must never use a
 * sequence, whose numbers can commit in a different order or survive rollback. */
const reserveChangeSeqs = prepared((db: StoreDrizzle) =>
  db
    .update(syncFeed)
    .set({ headSeq: sql`${syncFeed.headSeq} + ${sql.placeholder('count')}` })
    .where(eq(syncFeed.tenantId, param(syncFeed.tenantId, 'tenantId')))
    .returning({ headSeq: syncFeed.headSeq })
    .prepare(),
)

const currentFeedState = prepared((db: StoreDrizzle) =>
  db
    .select({ headSeq: syncFeed.headSeq, floorSeq: syncFeed.floorSeq })
    .from(syncFeed)
    .where(eq(syncFeed.tenantId, param(syncFeed.tenantId, 'tenantId')))
    .prepare(),
)

/** An empty feed's head 0 -> 1; the floor stays 1. Seq 0
 * is the reserved cold-start cursor and a row at seq 0 is malformed (ADR 2 D12),
 * so a start-up load stamped at head 0 cannot carry the model rows a fresh
 * install may already hold (setup, migrations, backfills). Head 1 with no row
 * at 1 is an ordinary empty range (0, 1]; a floor of 2 would sit above the
 * load's head and refuse both the load and a delta from 0. Only a head of 0
 * moves; it never renumbers. */
const raiseEmptyHead = prepared((db: StoreDrizzle) =>
  db
    .update(syncFeed)
    .set({ headSeq: 1 })
    .where(
      and(eq(syncFeed.tenantId, param(syncFeed.tenantId, 'tenantId')), eq(syncFeed.headSeq, 0)),
    )
    .prepare(),
)

const advanceFloor = prepared((db: StoreDrizzle) =>
  db
    .update(syncFeed)
    .set({
      floorSeq: sql`coalesce((select min(${changes.seq}) from ${changes} where ${changes.tenantId} = ${sql.placeholder('tenantId')}), ${syncFeed.headSeq} + 1)`,
    })
    .where(eq(syncFeed.tenantId, param(syncFeed.tenantId, 'tenantId')))
    .prepare(),
)

/**
 * One append chunk, keyed by its ROW COUNT (1 to the 100-row chunk of
 * {@link SyncRepository.appendChanges}): a VALUES list cannot be padded the way
 * an IN list can. Row `i` fills `entity${i}`, `entityId${i}`, `op${i}`,
 * `payload${i}` and the provenance triple `originId${i}`, `causationId${i}`,
 * `mutationId${i}` (POD-6272); every row shares `eventTime`.
 */
const insertChangeRows = preparedFamily((db: StoreDrizzle, rows: number) =>
  db
    .insert(changes)
    .values(
      Array.from({ length: rows }, (_, i) => ({
        tenantId: sql.placeholder('tenantId'),
        seq: sql.placeholder(`seq${i}`),
        entity: sql.placeholder(`entity${i}`),
        entityId: sql.placeholder(`entityId${i}`),
        op: sql.placeholder(`op${i}`),
        payload: sql.placeholder(`payload${i}`),
        eventTime: sql.placeholder('eventTime'),
        originId: sql.placeholder(`originId${i}`),
        causationId: sql.placeholder(`causationId${i}`),
        mutationId: sql.placeholder(`mutationId${i}`),
      })),
    )
    .prepare(),
)

// EIGHT COLUMNS OF NINE, named rather than spread [spec rule 39]: the five the
// original statement projected plus the provenance triple a reader now needs to
// confirm a client's write (POD-6272). `event_time` stays unread: no range
// reader asks for the clock.
const changesAfter = prepared((db: StoreDrizzle) =>
  db
    .select({
      seq: changes.seq,
      entity: changes.entity,
      entityId: changes.entityId,
      op: changes.op,
      payload: changes.payload,
      originId: changes.originId,
      causationId: changes.causationId,
      mutationId: changes.mutationId,
    })
    .from(changes)
    .where(
      and(
        eq(changes.tenantId, param(changes.tenantId, 'tenantId')),
        gt(changes.seq, param(changes.seq, 'cursor')),
      ),
    )
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
      originId: changes.originId,
      causationId: changes.causationId,
      mutationId: changes.mutationId,
    })
    .from(changes)
    .where(
      and(
        eq(changes.tenantId, param(changes.tenantId, 'tenantId')),
        gt(changes.seq, param(changes.seq, 'from')),
        lte(changes.seq, param(changes.seq, 'through')),
      ),
    )
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
    .where(
      and(
        eq(changes.tenantId, param(changes.tenantId, 'tenantId')),
        lt(changes.eventTime, param(changes.eventTime, 'before')),
      ),
    )
    .prepare(),
)

const deleteChangeHead = prepared((db: StoreDrizzle) =>
  db
    .delete(changes)
    .where(
      and(
        eq(changes.tenantId, param(changes.tenantId, 'tenantId')),
        inArray(
          changes.seq,
          db
            .select({ seq: changes.seq })
            .from(changes)
            .where(
              and(
                eq(changes.tenantId, param(changes.tenantId, 'tenantId')),
                lte(changes.seq, param(changes.seq, 'thresholdSeq')),
              ),
            )
            .orderBy(asc(changes.seq))
            .limit(sql.placeholder('batchSize')),
        ),
      ),
    )
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
    .select({ feedId: syncFeed.feedId, epoch: syncFeed.epoch })
    .from(syncFeed)
    .where(eq(syncFeed.tenantId, param(syncFeed.tenantId, 'tenantId')))
    .prepare(),
)

const initialFeedValues = {
  tenantId: sql.placeholder('tenantId'),
  feedId: sql.placeholder('feedId'),
  epoch: sql.placeholder('epoch'),
  mintedAt: sql.placeholder('mintedAt'),
  headSeq: 0,
  floorSeq: 1,
}

/** Created inside an append, whose reservation moves the head past 0 in the
 *  same transaction, so this row is never observed at head 0. */
const ensureFeedIdentity = prepared((db: StoreDrizzle) =>
  db.insert(syncFeed).values(initialFeedValues).onConflictDoNothing().prepare(),
)

/** An identity minted before any append creates the feed at head 1, never 0:
 *  see `raiseEmptyHead` (ADR 2 D12). An existing row keeps its counters. */
const upsertFeedIdentity = prepared((db: StoreDrizzle) =>
  db
    .insert(syncFeed)
    .values({ ...initialFeedValues, headSeq: 1 })
    .onConflictDoUpdate({
      target: syncFeed.tenantId,
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

    /** Keyed by the restriction: none, one session, or a set of sessions as a
     *  portable `IN` list keyed by its prepared size ({@link inListSize}). */
    queuedCounts: preparedFamily((db: StoreDrizzle, scope: 'all' | 'one' | number) =>
      db
        .select({ sessionId: queued.sessionId, n: count() })
        .from(queued)
        .where(
          scope === 'all'
            ? undefined
            : scope === 'one'
              ? eq(queued.sessionId, param(queued.sessionId, 'sessionId'))
              : inListOf(queued.sessionId, scope, 'ids'),
        )
        .groupBy(queued.sessionId)
        .prepare(),
    ),

    queuedSessionOf: prepared((db: StoreDrizzle) =>
      db
        .select({ sessionId: queued.sessionId })
        .from(queued)
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),
    deleteQueued: prepared((db: StoreDrizzle) =>
      db
        .delete(queued)
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
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
        .set({
          retractRequestedAt: sql`coalesce(${queued.retractRequestedAt}, ${sql.placeholder('at')})`,
        })
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
      db
        .update(queued)
        .set({ deliveryOwner: 'daemon', attempts: sql`max(${queued.attempts}, 1)` })
        .where(eq(queued.id, param(queued.id, 'id')))
        .prepare(),
    ),

    releaseQueuedDelivery: prepared((db: StoreDrizzle) =>
      db
        .update(queued)
        .set({ deliveryOwner: null, attempts: sql.placeholder('attempts') })
        .where(and(eq(queued.id, param(queued.id, 'id')), eq(queued.deliveryOwner, 'daemon')))
        .prepare(),
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
      db
        .delete(queued)
        .where(eq(queued.sessionId, param(queued.sessionId, 'sessionId')))
        .prepare(),
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
  originId?: string | null
  causationId?: string | null
  mutationId?: MutationId | null
}): ChangeLogReadRow {
  const row: ChangeLogReadRow = {
    seq: r.seq,
    entity: r.entity as ChangeLogReadRow['entity'],
    entityId: r.entityId,
    op: r.op as ChangeLogReadRow['op'],
    payload: r.payload,
  }
  // A NULL provenance column is an ABSENT key, never `null` (POD-6272): the
  // row had no causing command, and the model's fields are optional, not nullable.
  if (r.originId != null) row.originId = r.originId
  if (r.causationId != null) row.causationId = r.causationId
  if (r.mutationId != null) row.mutationId = r.mutationId
  return row
}

export class SyncRepository {
  /** Queue membership changes the dependent session record, in the source commit. */
  sessionRecordWrite?: <T>(
    ids: () => Promise<readonly SessionId[]>,
    write: () => Promise<T>,
  ) => Promise<T>

  private async writeQueue<T>(
    ids: () => Promise<readonly SessionId[]>,
    write: () => Promise<T>,
  ): Promise<T> {
    return this.sessionRecordWrite ? await this.sessionRecordWrite(ids, write) : await write()
  }

  private async queuedSessionIds(id: string): Promise<SessionId[]> {
    const row = await this.serverTables.queuedSessionOf(this.db).get({ id })
    return row ? [row.sessionId] : []
  }

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

  constructor(
    queries: StoreQueries,
    private readonly tables: SyncServerTables,
    readonly tenantId: string = SELF_HOSTED_TENANT_ID,
  ) {
    if (!tenantId) throw new Error('a sync repository requires a tenant')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.serverTables = serverTableQueries(tables.queuedMessages, tables.upstreamOutbox)
  }

  /** A tenant-bound view over the same executor and transaction runner. */
  forTenant(tenantId: string): SyncRepository {
    return new SyncRepository(
      { rootDb: this.rootDb, createOrJoinTransaction: this.createOrJoinTransaction },
      this.tables,
      tenantId,
    )
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — reservation and append commit together under the tenant row lock).
   * The compare-at-save funnel sends only real changes.
   *
   * Row type is {@link ChangeLogWriteRow} — composed from the lifecycle shape,
   * not restated here (POD-1251).
   */
  async appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): Promise<number[]> {
    if (rows.length === 0) return []
    // Ten bound values per row including repeated tenant/event time placeholders:
    // 100 rows fit SQLite's supported builds (the previous batch already repeated
    // eventTime per row). Never pad a VALUES list: every action gets one number.
    const seqs: number[] = []
    const chunkSize = 100
    await this.createOrJoinTransaction(async () => {
      const { tenantId } = this
      let reserved = await reserveChangeSeqs(this.db).get({ tenantId, count: rows.length })
      if (!reserved) {
        // A first writer can precede client admission. A competing first writer
        // must keep the winner's identity, so initialization never updates it.
        await ensureFeedIdentity(this.db).run({
          tenantId,
          feedId: crypto.randomUUID(),
          epoch: crypto.randomUUID(),
          mintedAt: eventTime,
        })
        reserved = await reserveChangeSeqs(this.db).get({ tenantId, count: rows.length })
      }
      if (!reserved) throw new Error('tenant feed reservation failed')
      const first = reserved.headSeq - rows.length + 1
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize)
        const values: Record<string, unknown> = { eventTime, tenantId }
        chunk.forEach((row, i) => {
          values[`seq${i}`] = first + start + i
          values[`entity${i}`] = row.entity
          values[`entityId${i}`] = row.entityId
          values[`op${i}`] = row.op
          values[`payload${i}`] = row.payload
          values[`originId${i}`] = row.originId ?? null
          values[`causationId${i}`] = row.causationId ?? null
          values[`mutationId${i}`] = row.mutationId ?? null
        })
        await insertChangeRows(this.db, chunk.length).run(values)
      }
      for (let i = 0; i < rows.length; i++) seqs.push(first + i)
    })
    return seqs
  }

  /** Raise this tenant's head from 0 to 1 at writable boot, after migrations, so
   *  every start-up load is stamped at a positive seq (ADR 2 D12). No-op otherwise. */
  async raiseEmptyHead(): Promise<void> {
    await raiseEmptyHead(this.db).run({ tenantId: this.tenantId })
  }

  /** One snapshot read of this tenant's durable cursor bounds. */
  async readFeedState(): Promise<{ headSeq: number; floorSeq: number }> {
    return (
      (await currentFeedState(this.db).get({ tenantId: this.tenantId })) ?? {
        headSeq: 0,
        floorSeq: 1,
      }
    )
  }

  /** Highest committed seq for this tenant, surviving a fully pruned log. */
  async maxChangeSeq(): Promise<number> {
    return (await this.readFeedState()).headSeq
  }

  /** Lowest RETAINED seq, or null when the log is empty. */
  async minChangeSeq(): Promise<number | null> {
    const { headSeq, floorSeq } = await this.readFeedState()
    return floorSeq <= headSeq ? floorSeq : null
  }

  /**
   * Change rows with seq > cursor, in seq order. The CALLER decides whether the
   * cursor is still within the retained range (see Ledger.changesSince) —
   * this is a plain range read.
   */
  async changesSince(cursor: number, limit = 10_000): Promise<ChangeLogReadRow[]> {
    const rows = await changesAfter(this.db).all({ tenantId: this.tenantId, cursor, limit })
    return rows.map((r) => mapChangeLogReadRow(r))
  }

  /** Read exactly (from, through], with a bounded page size. */
  async changesInRange(from: number, through: number, limit: number): Promise<ChangeLogReadRow[]> {
    const rows = await changesBetween(this.db).all({
      tenantId: this.tenantId,
      from,
      through,
      limit,
    })
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
  async planChangePrune(opts: {
    keepRows: number
    maxAgeMs: number
    now: number
  }): Promise<ChangePrunePlan> {
    const rowCapSeq = (await this.maxChangeSeq()) - opts.keepRows
    // Force the covering (tenant_id, event_time, seq) index: the age lookup
    // seeks this tenant's time range and reads seq without loading log payloads.
    // seq must be explicit because the composite primary key is not the rowid.
    // `INDEXED BY` has no builder form, hence newestAgedSeq's SQL FROM fragment.
    const aged = await newestAgedSeq(this.db).get({
      tenantId: this.tenantId,
      before: opts.now - opts.maxAgeMs,
    })
    return { thresholdSeq: Math.max(rowCapSeq, aged?.seq ?? 0) }
  }

  /**
   * [spec:SP-c29e] One bounded DELETE using the indexed seq primary key.
   *
   * Trimming the catch-up log never changes the model tables used by bootstrap.
   */
  async pruneChangeBatch(plan: ChangePrunePlan, batchSize = 500): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    if (plan.thresholdSeq <= 0) return 0
    return await this.createOrJoinTransaction(async () => {
      // Take the same tenant lock as appends before changing the floor.
      await reserveChangeSeqs(this.db).get({ tenantId: this.tenantId, count: 0 })
      const result = await deleteChangeHead(this.db).run({
        tenantId: this.tenantId,
        thresholdSeq: plan.thresholdSeq,
        batchSize,
      })
      if (Number(result.changes) > 0) await advanceFloor(this.db).run({ tenantId: this.tenantId })
      return Number(result.changes)
    })
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
    return await this.writeQueue(
      async () => [row.sessionId],
      async () => {
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
      },
    )
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
  async queuedMessageCounts(
    sessionId?: SessionId | readonly SessionId[],
  ): Promise<Map<SessionId, number>> {
    if (sessionId === undefined || typeof sessionId === 'string') {
      const rows =
        sessionId === undefined
          ? await this.serverTables.queuedCounts(this.db, 'all').all()
          : await this.serverTables.queuedCounts(this.db, 'one').all({ sessionId })
      return new Map(rows.map((r) => [r.sessionId, r.n]))
    }
    // One query per 500 ids keeps a fleet-sized set below SQLite's parameter limit.
    const out = new Map<SessionId, number>()
    const unique = [...new Set(sessionId)]
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      const size = inListSize(chunk.length)
      for (const r of await this.serverTables
        .queuedCounts(this.db, size)
        .all(inListValues(chunk, size, 'ids'))) {
        out.set(r.sessionId, r.n)
      }
    }
    return out
  }

  async deleteQueuedMessage(id: string): Promise<void> {
    await this.writeQueue(
      () => this.queuedSessionIds(id),
      async () => {
        await this.serverTables.deleteQueued(this.db).run({ id })
      },
    )
  }

  /** Delete a row only while no daemon has custody of it (POD-4776): the one
   *  statement a retract and {@link reserveQueuedDelivery} race through, so
   *  exactly one of them wins. Answers whether THIS call deleted it. */
  async deleteUnreservedQueuedMessage(id: string): Promise<boolean> {
    return await this.writeQueue(
      () => this.queuedSessionIds(id),
      async () => {
        const r = await this.serverTables.deleteUnreservedQueued(this.db).run({ id })
        return Number(r.changes) > 0
      },
    )
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
    await this.writeQueue(
      async () => [sessionId],
      async () => {
        await this.serverTables.deleteQueuedOfSession(this.db).run({ sessionId })
      },
    )
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
  async listParkedUpstreamMutations(): Promise<
    { mutationId: MutationId; proc: string; queuedAt: number }[]
  > {
    const rows = await this.serverTables.parkedUpstream(this.db).all()
    return rows.map((r) => ({
      mutationId: r.mutationId,
      proc: r.proc as string,
      queuedAt: Number(r.queuedAt),
    }))
  }

  async readKindGenerations(): Promise<{ kind: string; generation: number }[]> {
    return await kindGenerations(this.db).all({ tenantId: this.tenantId })
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
    const row = await currentFeedIdentity(this.db).get({ tenantId: this.tenantId })
    return row === undefined ? null : { feedId: row.feedId, epoch: row.epoch }
  }

  /**
   * Persist the identity. UPSERT on the tenant key, so a bump REPLACES rather
   * than appends: there is exactly one current generation, and a table that could
   * hold two would leave "which epoch is this feed on?" answered by whichever row
   * a query happened to return first.
   */
  async writeFeedIdentity(
    identity: { feedId: string; epoch: string },
    mintedAt: number,
  ): Promise<void> {
    // TARGETED ON THE PRIMARY KEY, which is `sync_feed`'s ONLY uniqueness
    // constraint — checked with `pragma index_list` on the migrated table
    // [spec rule 31a].
    await upsertFeedIdentity(this.db).run({
      tenantId: this.tenantId,
      feedId: identity.feedId,
      epoch: identity.epoch,
      mintedAt,
    })
  }
}
