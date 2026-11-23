// workspace-scoped (POD-6959)
/**
 * THE JANITOR'S READS [POD-6993, POD-6958 design 2.9].
 *
 * The janitor (`packages/janitor`) observes durable facts and proposes maintenance
 * commands; the server revalidates every observation when it applies one. These are the
 * facts it observes, as query definitions on the store's binding, so the same reads run
 * on SQLite and on Postgres. The janitor package holds the engine (paging, time budget,
 * the observations it builds from these rows) and no SQL: it reads through the
 * `JanitorReads` port this repository implements. Its worker opens a read session of the
 * store's own engine per scan (`janitor-database.ts`) and builds this repository over it.
 *
 * ONE WORKSPACE'S ROWS (POD-7021, POD-6959 design 2.4). Every definition here is a
 * workspace definition: each table it reads is held to the handle's workspace, joins
 * included. The one read across workspaces is {@link listWorkspacesWithFeed}, on the
 * cross-workspace allowlist.
 *
 * TWO FORMS WHERE THE ENGINES DIFFER. SQLite is told which index to read (`INDEXED BY`,
 * kept from the janitor's raw reads, so its plans do not change); Postgres has no index
 * hints and plans from its own statistics. `maintenance_commands` has no integer key, and
 * SQLite's plan position was its `rowid`, which Postgres has not (see
 * {@link commandPruneHeadOf}). An order on a nullable column is written `ASC NULLS FIRST`,
 * SQLite's own order for ASC, so the rows come back in one order on both.
 */

import type {
  DueAutomationRow,
  ExpiryRow,
  FeedBounds,
  IssueArchiveRow,
  JanitorReads,
  MachineRow,
  QueuedExpiryRow,
  SessionArchiveRow,
  WorktreeGcRow,
} from '@podium/janitor'
import type { WorkspaceId } from '@podium/model'
import { and, asc, type Column, desc, eq, isNotNull, isNull, lte, type SQL, sql } from 'drizzle-orm'
import { LIST_WORKSPACES_WITH_FEED } from './cross-workspace-allowlist'
import { dialectOf } from './executor/dialect-prepared'
import type {
  FleetDb,
  StoreDrizzle,
  StoreTables,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, preparedAcross } from './executor/sync-drizzle'

/**
 * A column by its bare name, decoded as the column decodes: drizzle refuses a table's own
 * columns over a raw FROM (an `INDEXED BY` clause), so each is a fragment mapped with it.
 */
const bare = <C extends Column>(
  column: C,
): SQL<C['_']['data'] | (C['_']['notNull'] extends true ? never : null)> =>
  sql`${sql.identifier(column.name)}`.mapWith(column) as SQL<
    C['_']['data'] | (C['_']['notNull'] extends true ? never : null)
  >

/** SQLite's ascending order for a nullable column, written out so Postgres keeps it. */
const ascNullsFirst = (column: Column): SQL => sql`${column} ASC NULLS FIRST`

/** `table` on Postgres; `table INDEXED BY index` on SQLite. */
const fromIndexed = (db: StoreDrizzle, table: SQL | object, index: string): SQL =>
  dialectOf(db) === 'pg' ? sql`${table}` : sql`${table} INDEXED BY ${sql.identifier(index)}`

/** An aggregate as a JavaScript number on both engines (Postgres may send int8 as text). */
const asNumber = (value: unknown): number | null => (value === null ? null : Number(value))

/** `COUNT(*)` as a number. */
const count = (): SQL<number> => sql<number>`COUNT(*)`.mapWith(Number)

// ---------------------------------------------------------------------------
// The workspaces (the one cross-workspace read).

/**
 * Every workspace with a feed, which is every provisioned workspace. Ids only: each
 * observation the janitor then makes reads one of them.
 */
const listWorkspacesWithFeed = preparedAcross(LIST_WORKSPACES_WITH_FEED, (db, t) =>
  db
    .select({ workspaceId: t.syncFeed.workspaceId })
    .from(t.syncFeed)
    .orderBy(asc(t.syncFeed.workspaceId))
    .prepare(),
)

/** The workspaces whose maintenance the janitor observes, in id order. */
export async function workspacesWithFeed(fleet: FleetDb): Promise<WorkspaceId[]> {
  return (await listWorkspacesWithFeed(fleet).all()).map((row) => row.workspaceId)
}

// ---------------------------------------------------------------------------
// The workspace's admin (the janitor's boot check).

/** The same rule as `UsersRepository.earliestAdmin`: the earliest active admin. */
const earliestAdminOf = prepared((db, t) =>
  db
    .select({ id: t.users.id })
    .from(t.users)
    .where(inWorkspace(t.users, eq(t.users.role, 'admin'), isNull(t.users.disabledAt)))
    .orderBy(asc(t.users.createdAt), asc(t.users.id))
    .limit(1)
    .prepare(),
)

// ---------------------------------------------------------------------------
// Message expiry: the `stored` rows past their deadline, in two keyset walks.

const expiryColumns = (t: StoreTables) => ({
  id: bare(t.messages.id),
  lifecycle: bare(t.messages.lifecycle),
  createdAt: bare(t.messages.createdAt),
  expiresAt: bare(t.messages.expiresAt),
})

/** A `wait` message with no deadline of its own expires at the implicit cutoff. */
const implicitExpiryTerms = (t: StoreTables, ...after: SQL[]) =>
  inWorkspace(
    t.messages,
    sql`${t.messages.deliveryStatus} = 'stored' AND ${t.messages.lifecycle} = 'wait' AND ${t.messages.expiresAt} IS NULL`,
    lte(t.messages.createdAt, param(t.messages.createdAt, 'cutoff')),
    ...after,
  )

const implicitExpiryFirst = prepared((db, t) =>
  db
    .select(expiryColumns(t))
    .from(fromIndexed(db, t.messages, 'idx_messages_delivery_expiry_implicit'))
    .where(implicitExpiryTerms(t))
    .orderBy(asc(t.messages.createdAt), asc(t.messages.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const implicitExpiryAfter = prepared((db, t) =>
  db
    .select(expiryColumns(t))
    .from(fromIndexed(db, t.messages, 'idx_messages_delivery_expiry_implicit'))
    .where(
      implicitExpiryTerms(
        t,
        sql`(${t.messages.createdAt}, ${t.messages.id}) > (${param(t.messages.createdAt, 'afterCreatedAt')}, ${param(t.messages.id, 'afterId')})`,
      ),
    )
    .orderBy(asc(t.messages.createdAt), asc(t.messages.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** A message with its own deadline expires at it. */
const explicitExpiryTerms = (t: StoreTables, ...after: SQL[]) =>
  inWorkspace(
    t.messages,
    sql`${t.messages.deliveryStatus} = 'stored' AND ${t.messages.expiresAt} IS NOT NULL`,
    lte(t.messages.expiresAt, param(t.messages.expiresAt, 'now')),
    ...after,
  )

const explicitExpiryFirst = prepared((db, t) =>
  db
    .select(expiryColumns(t))
    .from(fromIndexed(db, t.messages, 'idx_messages_delivery_expiry_explicit'))
    .where(explicitExpiryTerms(t))
    .orderBy(ascNullsFirst(t.messages.expiresAt), asc(t.messages.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const explicitExpiryAfter = prepared((db, t) =>
  db
    .select(expiryColumns(t))
    .from(fromIndexed(db, t.messages, 'idx_messages_delivery_expiry_explicit'))
    .where(
      explicitExpiryTerms(
        t,
        sql`(${t.messages.expiresAt}, ${t.messages.id}) > (${param(t.messages.expiresAt, 'afterExpiresAt')}, ${param(t.messages.id, 'afterId')})`,
      ),
    )
    .orderBy(ascNullsFirst(t.messages.expiresAt), asc(t.messages.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

// ---------------------------------------------------------------------------
// Event-log retention: the row-count cap and the prunable head.

/**
 * THE ROW CAP AS A SEEK (POD-7035), as the server computes it
 * (`EventsRepository.eventCapThroughId`). The cut is the id of the newest event beyond
 * the newest `maxRows`. Ids are AUTOINCREMENT, so it is never above `max(id) - maxRows`
 * (the guess), and below it only by the ids missing above: count the workspace's events
 * above the guess, then step down from the guess past exactly the missing number. The
 * count reads the narrowest index (named on SQLite) and never a table page, where an
 * `OFFSET maxRows` walked `maxRows` rows, payloads and all.
 */
const eventsAboveGuessOf = prepared((db, t) =>
  db
    .select({ n: count() })
    .from(fromIndexed(db, t.podiumEvents, 'idx_podium_events_kind'))
    .where(
      inWorkspace(t.podiumEvents, sql`${t.podiumEvents.id} > ${param(t.podiumEvents.id, 'guess')}`),
    )
    .prepare(),
)

/** The id `missing` rows below the guess, at or below it. */
const eventCutOf = prepared((db, t) =>
  db
    .select({ id: t.podiumEvents.id })
    .from(t.podiumEvents)
    .where(
      inWorkspace(
        t.podiumEvents,
        sql`${t.podiumEvents.id} <= ${param(t.podiumEvents.id, 'guess')}`,
      ),
    )
    .orderBy(desc(t.podiumEvents.id))
    .limit(1)
    .offset(sql.placeholder('missing'))
    .prepare(),
)

/**
 * PRUNABLE EVENTS AS TWO SEEKS (POD-7435), as the server's delete reads them
 * (`EventsRepository.pruneEventBatch`): at or below the cap along the
 * `(workspace_id, id)` key, or older than the cutoff along `idx_podium_events_ts`.
 * Ids do not follow ts (a historical transcript replay appends old timestamps
 * under new ids), so the two limits have no one range; their `OR` walked the
 * whole log on every janitor tick.
 */
const overCapEvents = (t: StoreTables) =>
  inWorkspace(t.podiumEvents, lte(t.podiumEvents.id, param(t.podiumEvents.id, 'capThroughId')))

const agedEvents = (t: StoreTables, ...more: SQL[]) =>
  inWorkspace(
    t.podiumEvents,
    sql`${t.podiumEvents.ts} < ${param(t.podiumEvents.ts, 'cutoff')}`,
    ...more,
  )

/** The lowest prunable event id: the lower of the two arms' lowest. */
const eventPruneHeadOf = prepared((db, t) => {
  const arms = db
    .select({ head: sql<number | null>`MIN(${t.podiumEvents.id})`.as('head') })
    .from(t.podiumEvents)
    .where(overCapEvents(t))
    .unionAll(
      db
        // `+ 0`: not the bare key, so Postgres does not answer the MIN by walking the
        // primary key up from the oldest id until an aged row turns up, which reads
        // the log when the aged rows are a replay's newest ids. It reads the aged
        // rows' range of idx_podium_events_ts instead, as SQLite does.
        .select({ head: sql<number | null>`MIN(${t.podiumEvents.id} + 0)`.as('head') })
        .from(t.podiumEvents)
        .where(agedEvents(t)),
    )
    .as('arms')
  return db
    .select({ head: sql<number | null>`MIN(${arms.head})`.mapWith(asNumber) })
    .from(arms)
    .prepare()
})

/** How many events are prunable: those over the cap, and the aged ones above it. */
const eventPruneCountOf = prepared((db, t) => {
  const arms = db
    .select({ n: count().as('n') })
    .from(t.podiumEvents)
    .where(overCapEvents(t))
    .unionAll(
      db
        .select({ n: count().as('n') })
        .from(t.podiumEvents)
        .where(
          agedEvents(t, sql`${t.podiumEvents.id} > ${param(t.podiumEvents.id, 'capThroughId')}`),
        ),
    )
    .as('arms')
  return db
    .select({ n: sql<number>`COALESCE(SUM(${arms.n}), 0)`.mapWith(Number) })
    .from(arms)
    .prepare()
})

// ---------------------------------------------------------------------------
// Change-log retention: the feed's bounds and its newest aged sequence.

/**
 * The workspace's feed bounds and the highest sequence older than the age threshold, in
 * one snapshot. The correlated lookup seeks the age index (`changes_event_time`, named on
 * SQLite) without loading payloads.
 */
const changeFeedOf = prepared((db, t) =>
  db
    .select({
      headSeq: t.syncFeed.headSeq,
      floorSeq: t.syncFeed.floorSeq,
      agedSeq: sql<
        number | null
      >`(SELECT MAX(${t.changes.seq}) FROM ${fromIndexed(db, t.changes, 'changes_event_time')} WHERE ${inWorkspace(
        t.changes,
        sql`${t.changes.eventTime} < ${param(t.changes.eventTime, 'agedBeforeMs')}`,
      )})`.mapWith(asNumber),
    })
    .from(t.syncFeed)
    .where(inWorkspace(t.syncFeed, sql`${t.syncFeed.floorSeq} <= ${t.syncFeed.headSeq}`))
    .prepare(),
)

// ---------------------------------------------------------------------------
// Maintenance-command retention.

/**
 * The prunable head of the idempotency ledger: receipts applied before the cutoff. The
 * head is a PLAN POSITION only: it seeds each batch's run key so a later tick never reuses
 * a finished batch's key (the server prunes the oldest receipts by `applied_at` and reads
 * no position). SQLite's is the lowest `rowid`, as before; Postgres has no `rowid`, so its
 * position is the oldest receipt's `applied_at` in epoch milliseconds, which also only
 * grows as the head is pruned.
 */
const prunableCommands = (t: StoreTables) =>
  inWorkspace(
    t.maintenanceCommands,
    sql`${t.maintenanceCommands.appliedAt} < ${param(t.maintenanceCommands.appliedAt, 'cutoffAppliedAt')}`,
  )

const commandPruneHeadOf = prepared((db, t) =>
  db
    .select({
      head:
        dialectOf(db) === 'pg'
          ? sql<
              number | null
            >`(EXTRACT(EPOCH FROM MIN(${t.maintenanceCommands.appliedAt})) * 1000)::bigint`.mapWith(
              asNumber,
            )
          : sql<number | null>`MIN(rowid)`.mapWith(asNumber),
    })
    .from(t.maintenanceCommands)
    .where(prunableCommands(t))
    .prepare(),
)

/** How many receipts were applied before the cutoff. */
const commandPruneCountOf = prepared((db, t) =>
  db.select({ n: count() }).from(t.maintenanceCommands).where(prunableCommands(t)).prepare(),
)

// ---------------------------------------------------------------------------
// Mutation-receipt retention and queued-input expiry (POD-7035).

/** Receipts applied before the cutoff (epoch ms), off `idx_applied_mutations_applied_at`. */
const prunableReceipts = (t: StoreTables) =>
  inWorkspace(
    t.appliedMutations,
    sql`${t.appliedMutations.appliedAt} < ${param(t.appliedMutations.appliedAt, 'cutoffAppliedAt')}`,
  )

/** The oldest prunable receipt's time: the batches' plan position. */
const receiptPruneHeadOf = prepared((db, t) =>
  db
    .select({ head: sql<number | null>`MIN(${t.appliedMutations.appliedAt})`.mapWith(asNumber) })
    .from(t.appliedMutations)
    .where(prunableReceipts(t))
    .prepare(),
)

/** How many receipts are prunable. */
const receiptPruneCountOf = prepared((db, t) =>
  db.select({ n: count() }).from(t.appliedMutations).where(prunableReceipts(t)).prepare(),
)

/** Rows queued at or before the horizon (epoch ms). */
const expiredQueued = (t: StoreTables) =>
  inWorkspace(
    t.queuedMessages,
    sql`${t.queuedMessages.queuedAt} <= ${param(t.queuedMessages.queuedAt, 'through')}`,
  )

/**
 * The sessions holding input queued past the horizon, oldest first, one row each. The
 * table is a queue its consumer empties (a small table to both query-plan audits), so no
 * index is named; the session index leads with the queue's order, not its time.
 * Whether a session is running, and drains its own queue, is the server's to say.
 */
const queuedExpiryPageOf = prepared((db, t) =>
  db
    .select({
      sessionId: bare(t.queuedMessages.sessionId),
      through: sql<number>`MAX(${sql.identifier('queued_at')})`.mapWith(Number).as('through'),
      rows: count().as('n'),
    })
    .from(t.queuedMessages)
    .where(expiredQueued(t))
    .groupBy(sql`${sql.identifier('session_id')}`)
    .orderBy(sql`MIN(${sql.identifier('queued_at')}) ASC`, sql`${sql.identifier('session_id')} ASC`)
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** How many rows of every session are queued past the horizon. */
const queuedExpiryCountOf = prepared((db, t) =>
  db.select({ n: count() }).from(t.queuedMessages).where(expiredQueued(t)).prepare(),
)

// ---------------------------------------------------------------------------
// Auto-archive: read-and-done sessions and issues, by the reader the server asks.

/**
 * Stopped sessions their OWNER has read since they stopped, past the cutoff (POD-6285):
 * sessions are private, so only the owner's read can say they are done with it. INNER
 * JOIN on the owner's read state: no row means never read. A sub-issue's session is left
 * to the archive of its parent.
 */
const sessionArchiveOf = prepared((db, t) =>
  db
    .select({
      id: t.sessions.id,
      issueId: t.sessions.issueId,
      stoppedAt: t.sessions.stoppedAt,
      ownerUserId: t.sessions.ownerUserId,
    })
    .from(t.sessions)
    .innerJoin(
      t.sessionUserState,
      and(
        eq(t.sessionUserState.sessionId, t.sessions.id),
        eq(t.sessionUserState.userId, t.sessions.ownerUserId),
        eq(t.sessionUserState.workspaceId, t.sessions.workspaceId),
      ),
    )
    .leftJoin(
      t.issues,
      and(eq(t.issues.id, t.sessions.issueId), eq(t.issues.workspaceId, t.sessions.workspaceId)),
    )
    .where(
      inWorkspace(
        t.sessions,
        eq(t.sessions.archived, false),
        isNotNull(t.sessions.stoppedAt),
        isNotNull(t.sessionUserState.readAt),
        sql`${t.sessionUserState.readAt} >= ${t.sessions.stoppedAt}`,
        sql`${t.sessionUserState.readAt} <= ${param(t.sessionUserState.readAt, 'cutoffReadAt')}`,
        sql`${t.sessions.stoppedAt} <= ${param(t.sessions.stoppedAt, 'cutoffStoppedAt')}`,
        sql`(${t.sessions.issueId} IS NULL OR ${t.issues.parentId} IS NULL)`,
      ),
    )
    .orderBy(ascNullsFirst(t.sessionUserState.readAt), asc(t.sessions.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/**
 * Finished top-level issues their ASSIGNEE has read, past the cutoff (POD-6291). One row
 * per issue survives the join (the reader is pinned to one user), so `(read_at, id)` is a
 * total order for the keyset walk.
 */
const issueArchiveTerms = (t: StoreTables, ...after: SQL[]) =>
  inWorkspace(
    t.issues,
    eq(t.issues.archived, false),
    isNull(t.issues.deletedAt),
    isNotNull(t.issueUserState.readAt),
    sql`${t.issueUserState.readAt} <= ${param(t.issueUserState.readAt, 'cutoffReadAt')}`,
    sql`(${t.issues.stage} = 'done' OR ${t.issues.closedReason} IS NOT NULL)`,
    isNull(t.issues.parentId),
    ...after,
  )

const issueArchiveColumns = (t: StoreTables) => ({
  id: t.issues.id,
  stage: t.issues.stage,
  closedReason: t.issues.closedReason,
  ownerUserId: t.issues.ownerUserId,
  readAt: t.issueUserState.readAt,
})

const issueArchiveJoin = (t: StoreTables) =>
  and(
    eq(t.issueUserState.issueId, t.issues.id),
    eq(t.issueUserState.userId, t.issues.ownerUserId),
    eq(t.issueUserState.workspaceId, t.issues.workspaceId),
  )

const issueArchiveFirst = prepared((db, t) =>
  db
    .select(issueArchiveColumns(t))
    .from(t.issues)
    .innerJoin(t.issueUserState, issueArchiveJoin(t))
    .where(issueArchiveTerms(t))
    .orderBy(ascNullsFirst(t.issueUserState.readAt), asc(t.issues.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const issueArchiveAfter = prepared((db, t) =>
  db
    .select(issueArchiveColumns(t))
    .from(t.issues)
    .innerJoin(t.issueUserState, issueArchiveJoin(t))
    .where(
      issueArchiveTerms(
        t,
        sql`(${t.issueUserState.readAt}, ${t.issues.id}) > (${param(t.issueUserState.readAt, 'afterReadAt')}, ${param(t.issues.id, 'afterId')})`,
      ),
    )
    .orderBy(ascNullsFirst(t.issueUserState.readAt), asc(t.issues.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

// ---------------------------------------------------------------------------
// Worktree GC: reclaimable checkouts on finished issues (POD-564).

/**
 * No `parent_id IS NULL` gate (sub-issues' checkouts are in scope) and archived rows
 * count (POD-567 frees on archive, so one with a path is one whose free was refused).
 * The live-session clause is a durable approximation of `isMemberCwd`'s prefix rule; the
 * server re-reads the live registry at apply time. SQLite's LIKE folds ASCII case, so
 * Postgres matches it with ILIKE, its pattern in SQLite's byte order (`COLLATE "C"`).
 */
const worktreeGcTerms = (db: StoreDrizzle, t: StoreTables, ...after: SQL[]) => {
  const under =
    dialectOf(db) === 'pg'
      ? sql`${t.sessions.cwd} ILIKE (${t.issues.worktreePath} || '/%') COLLATE "C"`
      : sql`${t.sessions.cwd} LIKE ${t.issues.worktreePath} || '/%'`
  return inWorkspace(
    t.issues,
    isNotNull(t.issues.worktreePath),
    isNull(t.issues.deletedAt),
    sql`(${t.issues.stage} = 'done' OR ${t.issues.closedReason} IS NOT NULL)`,
    isNotNull(t.issues.closedAt),
    sql`${t.issues.closedAt} <= ${param(t.issues.closedAt, 'cutoffClosedAt')}`,
    sql`NOT EXISTS (SELECT 1 FROM ${t.sessions} WHERE ${inWorkspace(
      t.sessions,
      sql`${t.sessions.status} IN ('live', 'starting')`,
      sql`(${t.sessions.cwd} = ${t.issues.worktreePath} OR ${under})`,
    )})`,
    ...after,
  )
}

const worktreeGcColumns = (t: StoreTables) => ({
  id: t.issues.id,
  worktreePath: t.issues.worktreePath,
  stage: t.issues.stage,
  closedReason: t.issues.closedReason,
  closedAt: t.issues.closedAt,
})

const worktreeGcFirst = prepared((db, t) =>
  db
    .select(worktreeGcColumns(t))
    .from(t.issues)
    .where(worktreeGcTerms(db, t))
    .orderBy(ascNullsFirst(t.issues.closedAt), asc(t.issues.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const worktreeGcAfter = prepared((db, t) =>
  db
    .select(worktreeGcColumns(t))
    .from(t.issues)
    .where(
      worktreeGcTerms(
        db,
        t,
        sql`(${t.issues.closedAt}, ${t.issues.id}) > (${param(t.issues.closedAt, 'afterClosedAt')}, ${param(t.issues.id, 'afterId')})`,
      ),
    )
    .orderBy(ascNullsFirst(t.issues.closedAt), asc(t.issues.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

// ---------------------------------------------------------------------------
// Automations, the steward cursor, connect scans.

/** Enabled automations whose next run is due; overlap is revalidated at apply. */
const dueAutomationsOf = prepared((db, t) =>
  db
    .select({
      id: t.automations.id,
      scheduleKind: t.automations.scheduleKind,
      cron: t.automations.cron,
      nextRunAt: t.automations.nextRunAt,
    })
    .from(t.automations)
    .where(
      inWorkspace(
        t.automations,
        eq(t.automations.enabled, true),
        isNotNull(t.automations.nextRunAt),
        sql`${t.automations.nextRunAt} <= ${param(t.automations.nextRunAt, 'now')}`,
      ),
    )
    .orderBy(ascNullsFirst(t.automations.nextRunAt), asc(t.automations.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const stewardCursorOf = prepared((db, t) =>
  db
    .select({ value: t.stewardState.value })
    .from(t.stewardState)
    .where(inWorkspace(t.stewardState, eq(t.stewardState.key, 'cursor')))
    .prepare(),
)

const maxEventIdOf = prepared((db, t) =>
  db
    // A bare MAX over the key (workspace_id, id): SQLite's min/max optimization reads
    // the one entry at the end; the 0 for an empty log is added in TypeScript.
    .select({ max: sql<number | null>`MAX(${t.podiumEvents.id})`.mapWith(asNumber) })
    .from(t.podiumEvents)
    .where(inWorkspace(t.podiumEvents))
    .prepare(),
)

/**
 * Every machine but this one, newest handshake first [POD-925]. No freshness filter: a
 * still-connected machine's `last_seen_at` moves only on a handshake (delay, not lose).
 */
const remoteMachinesOf = prepared((db, t) =>
  db
    .select({ id: t.machines.id, lastSeenAt: t.machines.lastSeenAt })
    .from(t.machines)
    .where(
      inWorkspace(
        t.machines,
        sql`(CAST(${sql.placeholder('localMachineId')} AS TEXT) IS NULL OR ${t.machines.id} <> ${sql.placeholder('localMachineId')})`,
      ),
    )
    .orderBy(desc(t.machines.lastSeenAt), asc(t.machines.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

// ---------------------------------------------------------------------------

/** The janitor's reads of one workspace, on the handle it is built with. */
export class JanitorReadsRepository implements JanitorReads {
  private readonly scope: WorkspaceDb

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
  }

  protected get db(): WorkspaceDb {
    return this.scope
  }

  async earliestAdminId(): Promise<string | undefined> {
    return (await earliestAdminOf(this.db).get())?.id
  }

  async implicitExpiryPage(input: {
    cutoff: string
    limit: number
    after?: { createdAt: string; id: string }
  }): Promise<ExpiryRow[]> {
    const { cutoff, limit, after } = input
    return after === undefined
      ? await implicitExpiryFirst(this.db).all({ cutoff, limit })
      : await implicitExpiryAfter(this.db).all({
          cutoff,
          limit,
          afterCreatedAt: after.createdAt,
          afterId: after.id,
        })
  }

  async explicitExpiryPage(input: {
    now: string
    limit: number
    after?: { expiresAt: string; id: string }
  }): Promise<ExpiryRow[]> {
    const { now, limit, after } = input
    return after === undefined
      ? await explicitExpiryFirst(this.db).all({ now, limit })
      : await explicitExpiryAfter(this.db).all({
          now,
          limit,
          afterExpiresAt: after.expiresAt,
          afterId: after.id,
        })
  }

  async eventCapThroughId(maxRows: number): Promise<number | undefined> {
    const guess = (await this.maxEventId()) - maxRows
    if (guess <= 0) return undefined
    const above = (await eventsAboveGuessOf(this.db).get({ guess }))?.n ?? 0
    const missing = Math.max(0, maxRows - above)
    return (await eventCutOf(this.db).get({ guess, missing }))?.id
  }

  async eventPruneHead(input: { cutoff: string; capThroughId: number }): Promise<number | null> {
    return (await eventPruneHeadOf(this.db).get(input))?.head ?? null
  }

  async eventPruneCount(input: { cutoff: string; capThroughId: number }): Promise<number> {
    return (await eventPruneCountOf(this.db).get(input))?.n ?? 0
  }

  async changeFeed(agedBeforeMs: number): Promise<FeedBounds | undefined> {
    return await changeFeedOf(this.db).get({ agedBeforeMs })
  }

  async commandPruneHead(cutoffAppliedAt: string): Promise<number | null> {
    return (await commandPruneHeadOf(this.db).get({ cutoffAppliedAt }))?.head ?? null
  }

  async commandPruneCount(cutoffAppliedAt: string): Promise<number> {
    return (await commandPruneCountOf(this.db).get({ cutoffAppliedAt }))?.n ?? 0
  }

  async receiptPruneHead(cutoffAppliedAt: number): Promise<number | null> {
    return (await receiptPruneHeadOf(this.db).get({ cutoffAppliedAt }))?.head ?? null
  }

  async receiptPruneCount(cutoffAppliedAt: number): Promise<number> {
    return (await receiptPruneCountOf(this.db).get({ cutoffAppliedAt }))?.n ?? 0
  }

  async queuedExpiryPage(input: { through: number; limit: number }): Promise<QueuedExpiryRow[]> {
    return await queuedExpiryPageOf(this.db).all(input)
  }

  async queuedExpiryCount(through: number): Promise<number> {
    return (await queuedExpiryCountOf(this.db).get({ through }))?.n ?? 0
  }

  async sessionArchivePage(input: {
    cutoffReadAt: string
    limit: number
  }): Promise<SessionArchiveRow[]> {
    const rows = await sessionArchiveOf(this.db).all({
      cutoffReadAt: input.cutoffReadAt,
      cutoffStoppedAt: input.cutoffReadAt,
      limit: input.limit,
    })
    // The WHERE holds `stopped_at` to NOT NULL; the column's type does not know it.
    return rows.map((row) => ({ ...row, stoppedAt: row.stoppedAt as string }))
  }

  async issueArchivePage(input: {
    cutoffReadAt: string
    limit: number
    after?: { readAt: string; id: string }
  }): Promise<IssueArchiveRow[]> {
    const { cutoffReadAt, limit, after } = input
    const rows =
      after === undefined
        ? await issueArchiveFirst(this.db).all({ cutoffReadAt, limit })
        : await issueArchiveAfter(this.db).all({
            cutoffReadAt,
            limit,
            afterReadAt: after.readAt,
            afterId: after.id,
          })
    return rows.map((row) => ({ ...row, readAt: row.readAt as string }))
  }

  async worktreeGcPage(input: {
    cutoffClosedAt: string
    limit: number
    after?: { closedAt: string; id: string }
  }): Promise<WorktreeGcRow[]> {
    const { cutoffClosedAt, limit, after } = input
    const rows =
      after === undefined
        ? await worktreeGcFirst(this.db).all({ cutoffClosedAt, limit })
        : await worktreeGcAfter(this.db).all({
            cutoffClosedAt,
            limit,
            afterClosedAt: after.closedAt,
            afterId: after.id,
          })
    return rows.map((row) => ({
      ...row,
      worktreePath: row.worktreePath as string,
      closedAt: row.closedAt as string,
    }))
  }

  async dueAutomations(input: { now: string; limit: number }): Promise<DueAutomationRow[]> {
    const rows = await dueAutomationsOf(this.db).all(input)
    return rows.map((row) => ({
      id: row.id,
      scheduleKind: row.scheduleKind as DueAutomationRow['scheduleKind'],
      cron: row.cron,
      nextRunAt: row.nextRunAt as string,
    }))
  }

  async stewardCursor(): Promise<string | undefined> {
    return (await stewardCursorOf(this.db).get())?.value
  }

  async maxEventId(): Promise<number> {
    return (await maxEventIdOf(this.db).get())?.max ?? 0
  }

  async remoteMachines(input: {
    localMachineId: string | null
    limit: number
  }): Promise<MachineRow[]> {
    return await remoteMachinesOf(this.db).all(input)
  }
}
