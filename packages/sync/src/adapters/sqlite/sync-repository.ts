// workspace-scoped (POD-6959)
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
 *
 * ONE WORKSPACE'S FEED (POD-7021, POD-6959 design 2.7). The repository is built
 * over one workspace's query handle and takes its workspace from it: every
 * statement below names the `workspaceId` placeholder, which the handle fills,
 * and constrains each workspace table it touches to it (`inWorkspace`, and
 * `sameWorkspace` for a self-join), so the feed row, the change log, the kind
 * generations, the mutation receipts and the two injected server tables are all
 * this workspace's. A caller cannot name another workspace, and a statement run
 * inside another workspace's transaction is refused by the fill. The change
 * capture table is per transaction, not per workspace: the drain
 * (`apps/server/src/sync/record-source.ts`) refuses a captured row of another
 * workspace.
 */

import type { MutationId, SessionId, WorkspaceId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { ChangeLogReadRow, ChangeLogWriteRow } from '../../authority/change-lifecycle'
import type { ChangePrunePlan } from '../../change-log'
import type { AppliedMutationFallback } from '../../mutation-ledger'
import { type DialectForms, dialectPrepared as dialectPreparedOn } from '../pg/dialect'
import type { SyncTables } from './binding'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  type PreparedAccessor,
  type PreparedFamilyAccessor,
  param,
  preparedFamily as preparedFamilyOn,
  prepared as preparedOn,
  sameWorkspace,
  WORKSPACE,
  type WorkspaceHandle,
} from './prepared'
import { ACCESS_MOVES_SINCE, ACCESS_MOVES_THROUGH } from './schema'
import type {
  CaptureWrite,
  QueuedMessagesTable,
  SyncServerTables,
  UpstreamOutboxTable,
} from './server-tables'
import type { StoreDrizzle, SyncQueries, TransactionRunner } from './store-queries'

export { type SyncTables, sqliteSyncTables } from './binding'

// The shared helpers, typed for this adapter's instance and tables. The same
// functions, so each definition's registered site is still its own line.
/** Rows per access-move upsert (humans and marks): three bound values each. */
const ACCESS_MOVE_CHUNK = 100

const prepared: <P>(
  build: (db: StoreDrizzle, t: SyncTables) => P,
) => PreparedAccessor<StoreDrizzle, P> = preparedOn
const dialectPrepared: () => <P>(
  forms: DialectForms<StoreDrizzle, SyncTables, P>,
) => PreparedAccessor<StoreDrizzle, P> = dialectPreparedOn
const preparedFamily: <K extends string | number, P>(
  build: (db: StoreDrizzle, t: SyncTables, key: K) => P,
) => PreparedFamilyAccessor<StoreDrizzle, K, P> = preparedFamilyOn

/** Take the current transaction's captured rows above a mark (POD-6920).
 *  The table holds only what this transaction wrote since its last drain. */
const drainCaptureRows = prepared((db, t) =>
  db
    .delete(t.syncCapture)
    .where(gt(t.syncCapture.id, sql.placeholder('after')))
    .returning({
      id: t.syncCapture.id,
      kind: t.syncCapture.kind,
      source: t.syncCapture.source,
      op: t.syncCapture.op,
      oldKey: t.syncCapture.oldKey,
      newKey: t.syncCapture.newKey,
    })
    .prepare(),
)

/** One captured change: the model row a kind's source table lost, gained or
 *  changed, as the old and new values of the source's key columns. */
export interface CapturedRow {
  readonly id: number
  readonly kind: string
  readonly source: number
  readonly op: 'i' | 'u' | 'd'
  readonly oldKey: readonly unknown[] | null
  readonly newKey: readonly unknown[] | null
}

/** The newest captured row of the current transaction, 0 when none. */
const captureHead = prepared((db, t) =>
  db
    .select({ head: sql<number>`coalesce(max(${t.syncCapture.id}), 0)` })
    .from(t.syncCapture)
    .prepare(),
)

/**
 * Raise the generation of every kind captured after a mark, once per kind,
 * in one statement: the kinds' rows come from `sync_capture` itself, so the
 * statement count does not depend on what was written (POD-7100). A kind
 * with no row yet starts at generation 1 (absent reads as 0).
 */
const bumpCapturedKindGenerations = prepared((db, t) =>
  db
    .insert(t.syncKind)
    .select(
      db
        .selectDistinct({
          workspaceId: sql<string>`${WORKSPACE}`.as('workspace_id'),
          kind: t.syncCapture.kind,
          generation: sql<number>`1`.as('generation'),
        })
        .from(t.syncCapture)
        .where(gt(t.syncCapture.id, sql.placeholder('after'))),
    )
    .onConflictDoUpdate({
      target: [t.syncKind.workspaceId, t.syncKind.kind],
      set: { generation: sql`${t.syncKind.generation} + 1` },
    })
    .prepare(),
)

// One row per registered kind in this tenant, independent of record count.
const kindGenerations = prepared((db, t) =>
  db
    .select({ kind: t.syncKind.kind, generation: t.syncKind.generation })
    .from(t.syncKind)
    .where(inWorkspace(t.syncKind))
    .prepare(),
)

/** UPDATE holds this tenant's row lock until the surrounding write commits.
 * Postgres uses the same UPDATE ... RETURNING contract; it must never use a
 * sequence, whose numbers can commit in a different order or survive rollback. */
const reserveChangeSeqs = prepared((db, t) =>
  db
    .update(t.syncFeed)
    .set({ headSeq: sql`${t.syncFeed.headSeq} + ${sql.placeholder('count')}` })
    .where(inWorkspace(t.syncFeed))
    .returning({ headSeq: t.syncFeed.headSeq })
    .prepare(),
)

const currentFeedState = prepared((db, t) =>
  db
    .select({ headSeq: t.syncFeed.headSeq, floorSeq: t.syncFeed.floorSeq })
    .from(t.syncFeed)
    .where(inWorkspace(t.syncFeed))
    .prepare(),
)

/** An empty feed's head 0 -> 1; the floor stays 1. Seq 0
 * is the reserved cold-start cursor and a row at seq 0 is malformed (ADR 2 D12),
 * so a start-up load stamped at head 0 cannot carry the model rows a fresh
 * install may already hold (setup, migrations, backfills). Head 1 with no row
 * at 1 is an ordinary empty range (0, 1]; a floor of 2 would sit above the
 * load's head and refuse both the load and a delta from 0. Only a head of 0
 * moves; it never renumbers. */
const raiseEmptyHead = prepared((db, t) =>
  db
    .update(t.syncFeed)
    .set({ headSeq: 1 })
    .where(inWorkspace(t.syncFeed, eq(t.syncFeed.headSeq, 0)))
    .prepare(),
)

const advanceFloor = prepared((db, t) =>
  db
    .update(t.syncFeed)
    .set({
      floorSeq: sql`coalesce((select min(${t.changes.seq}) from ${t.changes} where ${t.changes.workspaceId} = ${WORKSPACE}), ${t.syncFeed.headSeq} + 1)`,
    })
    .where(inWorkspace(t.syncFeed))
    .prepare(),
)

/**
 * One append chunk, keyed by its ROW COUNT (1 to the 100-row chunk of
 * {@link SyncRepository.appendChanges}): a VALUES list cannot be padded the way
 * an IN list can. Row `i` fills `entity${i}`, `entityId${i}`, `op${i}`,
 * `payload${i}` and the provenance triple `originId${i}`, `causationId${i}`,
 * `mutationId${i}` (POD-6272); every row shares `eventTime`.
 */
const insertChangeRows = preparedFamily((db, t, rows: number) =>
  db
    .insert(t.changes)
    .values(
      Array.from({ length: rows }, (_, i) => ({
        workspaceId: WORKSPACE,
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
const changesAfter = prepared((db, t) =>
  db
    .select({
      seq: t.changes.seq,
      entity: t.changes.entity,
      entityId: t.changes.entityId,
      op: t.changes.op,
      payload: t.changes.payload,
      originId: t.changes.originId,
      causationId: t.changes.causationId,
      mutationId: t.changes.mutationId,
    })
    .from(t.changes)
    .where(inWorkspace(t.changes, gt(t.changes.seq, param(t.changes.seq, 'cursor'))))
    .orderBy(asc(t.changes.seq))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const changesBetween = prepared((db, t) =>
  db
    .select({
      seq: t.changes.seq,
      entity: t.changes.entity,
      entityId: t.changes.entityId,
      op: t.changes.op,
      payload: t.changes.payload,
      originId: t.changes.originId,
      causationId: t.changes.causationId,
      mutationId: t.changes.mutationId,
    })
    .from(t.changes)
    .where(
      inWorkspace(
        t.changes,
        gt(t.changes.seq, param(t.changes.seq, 'from')),
        lte(t.changes.seq, param(t.changes.seq, 'through')),
      ),
    )
    .orderBy(asc(t.changes.seq))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const agedBefore = (t: SyncTables) =>
  inWorkspace(t.changes, lt(t.changes.eventTime, param(t.changes.eventTime, 'before')))

// `INDEXED BY` HAS NO BUILDER FORM, so the SQLite FROM clause is an `sql`
// fragment — see {@link SyncRepository.planChangePrune}. Postgres has no index
// hints: its planner takes `changes_event_time (workspace_id, event_time, seq)`
// for the range on its own, and the Postgres query-plan audit (POD-6992) proves it.
const newestAgedSeq = dialectPrepared()({
  sqlite: (db, t) =>
    db
      .select({ seq: max(t.changes.seq) })
      .from(sql`${t.changes} indexed by ${sql.identifier('changes_event_time')}`)
      .where(agedBefore(t))
      .prepare(),
  pg: (db, t) =>
    db
      .select({ seq: max(t.changes.seq) })
      .from(t.changes)
      .where(agedBefore(t))
      .prepare(),
})

const deleteChangeHead = prepared((db, t) =>
  db
    .delete(t.changes)
    .where(
      inWorkspace(
        t.changes,
        inArray(
          t.changes.seq,
          db
            .select({ seq: t.changes.seq })
            .from(t.changes)
            .where(inWorkspace(t.changes, lte(t.changes.seq, param(t.changes.seq, 'thresholdSeq'))))
            .orderBy(asc(t.changes.seq))
            .limit(sql.placeholder('batchSize')),
        ),
      ),
    )
    .prepare(),
)

/**
 * Each of `size` changes by seq, with the change of the same row just before it
 * (POD-6834). The earlier change is one primary-key seek through a correlated
 * `max(seq)` on `changes_entity (workspace_id, entity, entity_id, seq)`; a row with
 * no earlier change in the log (first write, or pruned) comes back with a NULL
 * prior. Catch-up reads the log here only to compare two logged records of one
 * row; a pruned prior answers "moved", which costs a re-send, never a fact.
 */
const priorChange = (t: SyncTables) => alias(t.changes, 'prior')
const earlierChange = (t: SyncTables) => alias(t.changes, 'earlier')
const changesWithPrior = preparedFamily((db, t, size: number) =>
  db
    .select({
      seq: t.changes.seq,
      op: t.changes.op,
      payload: t.changes.payload,
      // Named apart: the row reader keys columns by name, so a second `op` and
      // `payload` would overwrite the change's own.
      priorOp: sql<string | null>`${priorChange(t).op}`.as('prior_op'),
      priorPayload: sql<string | null>`${priorChange(t).payload}`.as('prior_payload'),
    })
    .from(t.changes)
    .leftJoin(
      priorChange(t),
      and(
        sameWorkspace(priorChange(t), t.changes),
        eq(
          priorChange(t).seq,
          db
            .select({ seq: max(earlierChange(t).seq) })
            .from(earlierChange(t))
            .where(
              and(
                sameWorkspace(earlierChange(t), t.changes),
                eq(earlierChange(t).entity, t.changes.entity),
                eq(earlierChange(t).entityId, t.changes.entityId),
                lt(earlierChange(t).seq, t.changes.seq),
              ),
            ),
        ),
      ),
    )
    .where(inWorkspace(t.changes, inListOf(t.changes.seq, size)))
    .prepare(),
)

/** Seqs per grouped prior-change read: one parameter each. */
const SEQ_CHUNK = 500
const appliedMutationResult = prepared((db, t) =>
  db
    .select({ result: t.appliedMutations.result })
    .from(t.appliedMutations)
    .where(
      inWorkspace(
        t.appliedMutations,
        eq(t.appliedMutations.mutationId, param(t.appliedMutations.mutationId, 'mutationId')),
      ),
    )
    .prepare(),
)

/** At most two primary-key hits; choose the current key before the legacy key. */
const appliedMutationWithFallback = prepared((db, t) =>
  db
    .select({
      mutationId: t.appliedMutations.mutationId,
      result: t.appliedMutations.result,
      appliedAt: t.appliedMutations.appliedAt,
    })
    .from(t.appliedMutations)
    .where(
      inWorkspace(
        t.appliedMutations,
        or(
          eq(t.appliedMutations.mutationId, param(t.appliedMutations.mutationId, 'mutationId')),
          eq(t.appliedMutations.mutationId, param(t.appliedMutations.mutationId, 'fallbackId')),
        ),
      ),
    )
    .prepare(),
)

const insertAppliedMutation = prepared((db, t) =>
  db
    .insert(t.appliedMutations)
    .values({
      workspaceId: WORKSPACE,
      mutationId: sql.placeholder('mutationId'),
      proc: sql.placeholder('proc'),
      result: sql.placeholder('result'),
      appliedAt: sql.placeholder('appliedAt'),
    })
    .onConflictDoNothing()
    .prepare(),
)

/**
 * ONE BATCH OF THE RECEIPT PRUNE (POD-7035): the oldest `batchSize` receipts
 * applied before the cutoff, read off the front of
 * `idx_applied_mutations_applied_at`. The janitor sends one batch per command;
 * the boot path's single unbatched `DELETE … WHERE applied_at < ?` is gone, so a
 * long uptime never turns into hundreds of megabytes deleted in one statement.
 * The batch is named by its key, `(workspace_id, mutation_id)`, not by SQLite's
 * rowid, so the one text runs on both engines.
 */
const deleteAppliedMutationsBatch = prepared((db, t) => {
  const oldest = db
    .select({ mutationId: t.appliedMutations.mutationId })
    .from(t.appliedMutations)
    .where(
      inWorkspace(
        t.appliedMutations,
        lt(t.appliedMutations.appliedAt, param(t.appliedMutations.appliedAt, 'before')),
      ),
    )
    .orderBy(asc(t.appliedMutations.appliedAt))
    .limit(sql.placeholder('batchSize'))
  return db
    .delete(t.appliedMutations)
    .where(inWorkspace(t.appliedMutations, inArray(t.appliedMutations.mutationId, oldest)))
    .prepare()
})

/**
 * POD-7552 — raise each named human's last access move to `seq${i}`, never
 * lower it: a batch evaluated out of order cannot take a move back. Keyed by
 * its ROW COUNT, as {@link insertChangeRows}.
 */
const upsertAccessMoves = preparedFamily((db, t, rows: number) =>
  db
    .insert(t.syncAccessMoves)
    .values(
      Array.from({ length: rows }, (_, i) => ({
        workspaceId: WORKSPACE,
        humanId: sql.placeholder(`human${i}`),
        seq: sql.placeholder(`seq${i}`),
      })),
    )
    .onConflictDoUpdate({
      target: [t.syncAccessMoves.workspaceId, t.syncAccessMoves.humanId],
      set: {
        seq: sql`case when ${t.syncAccessMoves.seq} > excluded.seq then ${t.syncAccessMoves.seq} else excluded.seq end`,
      },
    })
    .prepare(),
)

/** POD-7552 — the later of one human's last access move and where recording started: two
 *  primary-key seeks. */
const lastAccessMove = prepared((db, t) =>
  db
    .select({ seq: max(t.syncAccessMoves.seq) })
    .from(t.syncAccessMoves)
    .where(
      inWorkspace(
        t.syncAccessMoves,
        inArray(t.syncAccessMoves.humanId, [sql.placeholder('human'), ACCESS_MOVES_SINCE]),
      ),
    )
    .prepare(),
)

const currentFeedIdentity = prepared((db, t) =>
  db
    .select({ feedId: t.syncFeed.feedId, epoch: t.syncFeed.epoch })
    .from(t.syncFeed)
    .where(inWorkspace(t.syncFeed))
    .prepare(),
)

const initialFeedValues = {
  workspaceId: WORKSPACE,
  feedId: sql.placeholder('feedId'),
  epoch: sql.placeholder('epoch'),
  mintedAt: sql.placeholder('mintedAt'),
  headSeq: 0,
  floorSeq: 1,
}

/** Created inside an append, whose reservation moves the head past 0 in the
 *  same transaction, so this row is never observed at head 0. */
const ensureFeedIdentity = prepared((db, t) =>
  db.insert(t.syncFeed).values(initialFeedValues).onConflictDoNothing().prepare(),
)

/** An identity minted before any append creates the feed at head 1, never 0:
 *  see `raiseEmptyHead` (ADR 2 D12). An existing row keeps its counters. */
const upsertFeedIdentity = prepared((db, t) =>
  db
    .insert(t.syncFeed)
    .values({ ...initialFeedValues, headSeq: 1 })
    .onConflictDoUpdate({
      target: t.syncFeed.workspaceId,
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
function serverTableQueries(
  queued: QueuedMessagesTable,
  upstream: UpstreamOutboxTable,
  captureWrite: CaptureWrite,
) {
  return {
    insertQueued: prepared((db) =>
      captureWrite(
        db.insert(queued).values({
          workspaceId: WORKSPACE,
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
          // THE QUEUE'S ORDER, TAKEN IN THIS STATEMENT (POD-7075): one more than the
          // session's highest. One workspace's writers are serialised (SQLite's one
          // writer; on Postgres the workspace lock every write takes first), so no two
          // enqueues of a session read the same maximum, and the order is the order
          // the rows were queued on both engines: no wall clock, no engine row order.
          // A replay that inserts nothing takes no number.
          queueOrder: sql`(select coalesce(max(${queued.queueOrder}), 0) + 1 from ${queued} where ${queued.workspaceId} = ${WORKSPACE} and ${queued.sessionId} = ${sql.placeholder('sessionId')})`,
        }),
      )
        .onConflictDoNothing()
        .prepare(),
    ),

    // SIXTEEN COLUMNS OF EIGHTEEN, named [spec rule 39]: `session_id` is the
    // predicate and `queue_order` the ordering, not part of the answer. `queued_at`
    // is an answer since POD-4360: the inbox compares it against the transcript to
    // recognise a row a previous server process already delivered. It is no longer
    // the order: a clock can step back, and two rows can share a millisecond.
    queuedOfSession: prepared((db) =>
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
        .where(inWorkspace(queued, eq(queued.sessionId, param(queued.sessionId, 'sessionId'))))
        .orderBy(asc(queued.queueOrder))
        .prepare(),
    ),

    /** Keyed by the restriction: none, one session, or a set of sessions as a
     *  portable `IN` list keyed by its prepared size ({@link inListSize}). */
    queuedCounts: preparedFamily((db, _t, scope: 'all' | 'one' | number) =>
      db
        .select({ sessionId: queued.sessionId, n: count() })
        .from(queued)
        .where(
          inWorkspace(
            queued,
            scope === 'all'
              ? undefined
              : scope === 'one'
                ? eq(queued.sessionId, param(queued.sessionId, 'sessionId'))
                : inListOf(queued.sessionId, scope, 'ids'),
          ),
        )
        .groupBy(queued.sessionId)
        .prepare(),
    ),

    queuedSessionOf: prepared((db) =>
      db
        .select({ sessionId: queued.sessionId })
        .from(queued)
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),
    deleteQueued: prepared((db) =>
      captureWrite(db.delete(queued))
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),

    deleteUnreservedQueued: prepared((db) =>
      captureWrite(db.delete(queued))
        .where(
          inWorkspace(queued, eq(queued.id, param(queued.id, 'id')), isNull(queued.deliveryOwner)),
        )
        .prepare(),
    ),

    requestQueuedRetract: prepared((db) =>
      db
        .update(queued)
        .set({
          retractRequestedAt: sql`coalesce(${queued.retractRequestedAt}, ${sql.placeholder('at')})`,
        })
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),

    clearQueuedRetract: prepared((db) =>
      db
        .update(queued)
        .set({ retractRequestedAt: null })
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),

    // Two-argument `MAX` is SQLite's scalar maximum; Postgres spells it `GREATEST`.
    reserveQueuedDelivery: dialectPrepared()({
      sqlite: (db) =>
        db
          .update(queued)
          .set({ deliveryOwner: 'daemon', attempts: sql`max(${queued.attempts}, 1)` })
          .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
          .prepare(),
      pg: (db) =>
        db
          .update(queued)
          .set({ deliveryOwner: 'daemon', attempts: sql`greatest(${queued.attempts}, 1)` })
          .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
          .prepare(),
    }),

    releaseQueuedDelivery: prepared((db) =>
      db
        .update(queued)
        .set({ deliveryOwner: null, attempts: sql.placeholder('attempts') })
        .where(
          inWorkspace(
            queued,
            eq(queued.id, param(queued.id, 'id')),
            eq(queued.deliveryOwner, 'daemon'),
          ),
        )
        .prepare(),
    ),

    bumpQueuedAttempts: prepared((db) =>
      db
        .update(queued)
        .set({ attempts: sql`${queued.attempts} + 1` })
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),

    resetQueuedAttempts: prepared((db) =>
      db
        .update(queued)
        .set({ attempts: 0 })
        .where(inWorkspace(queued, eq(queued.id, param(queued.id, 'id'))))
        .prepare(),
    ),

    deleteQueuedOfSession: prepared((db) =>
      captureWrite(db.delete(queued))
        .where(inWorkspace(queued, eq(queued.sessionId, param(queued.sessionId, 'sessionId'))))
        .prepare(),
    ),

    // The expiry of one session's rows queued at or before a time (POD-7035):
    // a range of one session on `queued_messages_session`.
    deleteQueuedOfSessionThrough: prepared((db) =>
      captureWrite(db.delete(queued))
        .where(
          inWorkspace(
            queued,
            eq(queued.sessionId, param(queued.sessionId, 'sessionId')),
            lte(queued.queuedAt, sql.placeholder('through')),
          ),
        )
        .prepare(),
    ),

    // THREE COLUMNS OF SIX, named [spec rule 39]: `input` is the parked payload
    // this report deliberately does not read, `attempts` belongs to the retired
    // forwarder, and `queue_order` (numbered by its migration, POD-7075) is the order.
    parkedUpstream: prepared((db) =>
      db
        .select({
          mutationId: upstream.mutationId,
          proc: upstream.proc,
          queuedAt: upstream.queuedAt,
        })
        .from(upstream)
        .where(inWorkspace(upstream))
        .orderBy(asc(upstream.queueOrder))
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
  /**
   * Queue membership changes the dependent session record: a queue write runs
   * as a change-log commit, which drains the database's change capture in the
   * source transaction (POD-6920). Installed by composition.
   */
  sessionRecordWrite?: <T>(write: () => Promise<T>) => Promise<T>

  /**
   * Rows were appended to this workspace's change log. Runs once per append, after its
   * statements: before the enclosing transaction commits when the append joined one, after
   * the append's own commit otherwise. So the hook defers anything external to the commit
   * (the server registers a post-commit effect that publishes the workspace wake-up,
   * POD-7292). Installed by composition.
   */
  onAppended?: () => void

  private async writeQueue<T>(write: () => Promise<T>): Promise<T> {
    return this.sessionRecordWrite ? await this.sessionRecordWrite(write) : await write()
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
  /**
   * The workspace's query handle over the store's one drizzle instance: the
   * executor routes each statement to the current transaction, and the handle
   * fills each statement's `workspaceId`.
   */
  private readonly db: WorkspaceHandle<StoreDrizzle>
  protected readonly createOrJoinTransaction: TransactionRunner

  /**
   * Built over one workspace's queries (a workspace's store, POD-7010): every
   * statement takes its workspace from the handle, so there is no default and no
   * statement a caller can point at another workspace. The transaction runner
   * opens that workspace's transaction. `workspaceId` is the workspace the
   * builder means; it must be the handle's, so a repository built over another
   * workspace's queries is refused here rather than at its first statement.
   */
  constructor(queries: SyncQueries, tables: SyncServerTables, workspaceId: string) {
    const context = queries.db.context
    if (context.kind !== 'workspace' || !context.workspaceId) {
      throw new Error('a sync repository requires a workspace handle')
    }
    if (context.workspaceId !== workspaceId) {
      throw new Error(
        `a sync repository for workspace ${workspaceId} was built over the queries of workspace ${context.workspaceId}`,
      )
    }
    this.db = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.serverTables = serverTableQueries(
      tables.queuedMessages,
      tables.upstreamOutbox,
      tables.captureWrite,
    )
  }

  /** The workspace whose feed this is. */
  get workspaceId(): WorkspaceId {
    return this.db.context.workspaceId
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — reservation and append commit together under the tenant row lock).
   * The Authority sends one row per record the drained capture reached.
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
      let reserved = await reserveChangeSeqs(this.db).get({ count: rows.length })
      if (!reserved) {
        // A first writer can precede client admission. A competing first writer
        // must keep the winner's identity, so initialization never updates it.
        await ensureFeedIdentity(this.db).run({
          feedId: crypto.randomUUID(),
          epoch: crypto.randomUUID(),
          mintedAt: eventTime,
        })
        reserved = await reserveChangeSeqs(this.db).get({ count: rows.length })
      }
      if (!reserved) throw new Error('tenant feed reservation failed')
      const first = reserved.headSeq - rows.length + 1
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize)
        const values: Record<string, unknown> = { eventTime }
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
    this.onAppended?.()
    return seqs
  }

  /**
   * DERIVED CHANGE CAPTURE (POD-6920): every row the capture triggers wrote
   * in the current transaction since its last drain and after `after` (a
   * {@link captureMark}), oldest first, taken off the table. A transaction
   * may commit once the table is empty. One statement.
   */
  async drainCapture(after = 0): Promise<CapturedRow[]> {
    const rows = await drainCaptureRows(this.db).all({ after })
    if (rows.length === 0) return []
    return rows
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        source: row.source,
        op: row.op as CapturedRow['op'],
        oldKey: row.oldKey === null ? null : (JSON.parse(row.oldKey) as unknown[]),
        newKey: row.newKey === null ? null : (JSON.parse(row.newKey) as unknown[]),
      }))
  }

  /**
   * A write that no change log can take (one made while no server runs, such
   * as a transfer target's offline promotion) retires its capture instead of
   * draining it into the log: the generation of each kind it captured after
   * `after` goes up, as a data migration's does, and the captured rows go.
   * A client whose kind token names the older generation refetches the kind,
   * so it does not keep a record the log never heard about (POD-7100).
   * Returns the kinds, sorted. Two statements.
   */
  async retireCapture(after = 0): Promise<string[]> {
    await bumpCapturedKindGenerations(this.db).run({ after })
    const kinds = new Set((await this.drainCapture(after)).map((row) => row.kind))
    return [...kinds].sort()
  }

  /**
   * Where a commit nested in an open transaction starts: the newest row
   * captured before it, which belongs to whoever wrote it (POD-6920).
   */
  async captureMark(): Promise<number> {
    return (await captureHead(this.db).get())?.head ?? 0
  }

  /** Raise this tenant's head from 0 to 1 at writable boot, after migrations, so
   *  every start-up load is stamped at a positive seq (ADR 2 D12). No-op otherwise. */
  async raiseEmptyHead(): Promise<void> {
    await raiseEmptyHead(this.db).run()
  }

  /** One snapshot read of this tenant's durable cursor bounds. */
  async readFeedState(): Promise<{ headSeq: number; floorSeq: number }> {
    return (
      (await currentFeedState(this.db).get()) ?? {
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
    const rows = await changesAfter(this.db).all({ cursor, limit })
    return rows.map((r) => mapChangeLogReadRow(r))
  }

  /** Read exactly (from, through], with a bounded page size. */
  async changesInRange(from: number, through: number, limit: number): Promise<ChangeLogReadRow[]> {
    const rows = await changesBetween(this.db).all({
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
    // Force the covering (workspace_id, event_time, seq) index: the age lookup
    // seeks this tenant's time range and reads seq without loading log payloads.
    // seq must be explicit because the composite primary key is not the rowid.
    // `INDEXED BY` has no builder form, hence newestAgedSeq's SQL FROM fragment.
    const aged = await newestAgedSeq(this.db).get({
      before: opts.now - opts.maxAgeMs,
    })
    return { thresholdSeq: Math.max(rowCapSeq, aged?.seq ?? 0) }
  }

  /**
   * One bounded DELETE using the indexed seq primary key.
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
      await reserveChangeSeqs(this.db).get({ count: 0 })
      const result = await deleteChangeHead(this.db).run({
        thresholdSeq: plan.thresholdSeq,
        batchSize,
      })
      if (Number(result.changes) > 0) await advanceFloor(this.db).run()
      return Number(result.changes)
    })
  }

  /**
   * These changes by seq, each with the change of the same row just before it
   * (POD-6834): what a visibility anchor compares to tell a write that MOVED a
   * fact from one that rewrote it unchanged. One statement per
   * {@link SEQ_CHUNK} seqs. A seq not in the log is absent; a change with no
   * earlier change in the log has `prior` undefined.
   */
  async changesWithPrior(seqs: readonly number[]): Promise<
    Map<
      number,
      {
        readonly op: string
        readonly payload: string | null
        readonly prior?: { readonly op: string; readonly payload: string | null }
      }
    >
  > {
    const distinct = [...new Set(seqs)]
    const out = new Map<
      number,
      {
        op: string
        payload: string | null
        prior?: { op: string; payload: string | null }
      }
    >()
    for (let start = 0; start < distinct.length; start += SEQ_CHUNK) {
      const chunk = distinct.slice(start, start + SEQ_CHUNK)
      const size = inListSize(chunk.length)
      const values = inListValues(chunk, size, 'in')
      for (const row of await changesWithPrior(this.db, size).all(values)) {
        out.set(row.seq, {
          op: row.op,
          payload: row.payload,
          ...(row.priorOp == null ? {} : { prior: { op: row.priorOp, payload: row.priorPayload } }),
        })
      }
    }
    return out
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  async getAppliedMutation(
    mutationId: MutationId,
    fallback?: AppliedMutationFallback,
  ): Promise<string | undefined> {
    if (fallback === undefined)
      return (await appliedMutationResult(this.db).get({ mutationId }))?.result
    const rows = await appliedMutationWithFallback(this.db).all({
      mutationId,
      fallbackId: fallback.mutationId,
    })
    const current = rows.find((row) => row.mutationId === mutationId)
    if (current !== undefined) return current.result
    const legacy = rows.find((row) => row.mutationId === fallback.mutationId)
    return legacy !== undefined && legacy.appliedAt < fallback.before ? legacy.result : undefined
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

  /** Delete at most `batchSize` of the oldest receipts applied before `before`;
   *  returns how many went. */
  async pruneAppliedMutationsBatch(before: number, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    const result = await deleteAppliedMutationsBatch(this.db).run({ before, batchSize })
    return Number(result.changes)
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
    return await this.writeQueue(async () => {
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
    })
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
    await this.writeQueue(async () => {
      await this.serverTables.deleteQueued(this.db).run({ id })
    })
  }

  /** Delete a row only while no daemon has custody of it (POD-4776): the one
   *  statement a retract and {@link reserveQueuedDelivery} race through, so
   *  exactly one of them wins. Answers whether THIS call deleted it. */
  async deleteUnreservedQueuedMessage(id: string): Promise<boolean> {
    return await this.writeQueue(async () => {
      const r = await this.serverTables.deleteUnreservedQueued(this.db).run({ id })
      return Number(r.changes) > 0
    })
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
    await this.writeQueue(async () => {
      await this.serverTables.deleteQueuedOfSession(this.db).run({ sessionId })
    })
  }

  /**
   * Expire one session's queued rows queued at or before `through` (epoch ms),
   * as the session record's queue write (POD-7035). Returns how many went.
   */
  async expireQueuedMessagesOfSession(sessionId: SessionId, through: number): Promise<number> {
    return await this.writeQueue(async () => {
      const result = await this.serverTables
        .deleteQueuedOfSessionThrough(this.db)
        .run({ sessionId, through })
      return Number(result.changes)
    })
  }

  // ---- ARCHIVED: the retired node→hub issue-write outbox (POD-309) ----

  /**
   * Rows still sitting in `upstream_outbox` — issue mutations a NODE queued for a hub
   * it could not reach, at the moment federation was deferred.
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

  // ---- access moves (POD-7552) ----

  /**
   * Record the feed number of each human's latest access move: a visibility
   * edge named them in its audience at that seq. A seq below the stored one
   * changes nothing. With `through`, the recorded-through mark rides in the
   * same statement as one more row (POD-7585). One statement per
   * {@link ACCESS_MOVE_CHUNK} rows.
   */
  async recordAccessMoves(moves: ReadonlyMap<string, number>, through?: number): Promise<void> {
    const entries: [string, number][] = [
      ...(through === undefined ? [] : [[ACCESS_MOVES_THROUGH, through] as [string, number]]),
      ...moves,
    ]
    await this.upsertAccessMoveRows(entries)
  }

  /**
   * POD-7585 — the recorded-through mark, or where recording started when that
   * is later (a change below it cannot be told about anyway). One statement.
   */
  async readRecordedThrough(): Promise<number> {
    const row = await lastAccessMove(this.db).get({ human: ACCESS_MOVES_THROUGH })
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
  }

  /**
   * POD-7585 — the changes up to `seq` cannot be replayed: recording starts
   * there, and the recorded-through mark is at least there. One statement.
   */
  async raiseRecordingStart(seq: number): Promise<void> {
    await this.upsertAccessMoveRows([
      [ACCESS_MOVES_SINCE, seq],
      [ACCESS_MOVES_THROUGH, seq],
    ])
  }

  private async upsertAccessMoveRows(entries: readonly [string, number][]): Promise<void> {
    if (entries.length === 0) return
    await this.createOrJoinTransaction(async () => {
      for (let start = 0; start < entries.length; start += ACCESS_MOVE_CHUNK) {
        const chunk = entries.slice(start, start + ACCESS_MOVE_CHUNK)
        const values: Record<string, unknown> = {}
        chunk.forEach(([human, seq], i) => {
          values[`human${i}`] = human
          values[`seq${i}`] = seq
        })
        await upsertAccessMoves(this.db, chunk.length).run(values)
      }
    })
  }

  /**
   * Did this human's access move after `seq`, or can the server not tell (a
   * cursor below where recording started)? One statement.
   */
  async accessMovedAfter(human: string, seq: number): Promise<boolean> {
    const row = await lastAccessMove(this.db).get({ human })
    const last = row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
    return last > seq
  }

  async readKindGenerations(): Promise<{ kind: string; generation: number }[]> {
    return await kindGenerations(this.db).all()
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
      feedId: identity.feedId,
      epoch: identity.epoch,
      mintedAt,
    })
  }
}
