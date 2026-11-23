// workspace-scoped (POD-6959)
/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import {
  type ActorKind,
  AgentKind,
  AgentRuntimeState,
  actorColumns,
  actorFromColumns,
  asSessionId,
  type CredentialId,
  CredentialMismatch,
  EffectiveAuth,
  type IssueId,
  LaunchPostureReport,
  type MachineId,
  machinePathSeparator,
  type PinWire,
  SessionDesired,
  type SessionId,
  SessionLifecycleFailure,
  SessionMeta,
  type SessionUserStateWire,
  sessionUserStateRowId,
  type TabOrderWire,
  type UserId,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import {
  and,
  asc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type Placeholder,
  type SQL,
  sql,
} from 'drizzle-orm'
import type {
  offers as offersTable,
  sessionDrafts,
  sessions as sessionsTable,
} from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { type ChangeLogCommit, throughChangeLog } from './change-log-commit'
import { dialectOf, dialectPrepared } from './executor/dialect-prepared'
import { applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
  WORKSPACE,
} from './executor/sync-drizzle'
import { requireUserId } from './helpers'
import { bareColumns, throughIndex } from './index-hints'
import { prefixUpperBound } from './prefix-range'
import type { RepoPlaces } from './repos'
import type {
  OfferMap,
  OfferRecord,
  PinKind,
  SessionDeletionSource,
  SessionDriverCapabilities,
  SessionLifecycleRow,
  SessionRow,
  SessionSeatRow,
  SessionStatusPersisted,
  SnoozeMap,
} from './types'
import { NO_LIFECYCLE } from './types'
import { WrittenColumns } from './written-columns'

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo', 'issue'])

/** Setup needs existence, including archived/deleted work, never a session count. */
const anySession = prepared((db, t) =>
  db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(inWorkspace(t.sessions))
    .limit(1)
    .prepare(),
)

export const SESSION_LAST_ACTIVE_PUBLISH_INTERVAL_MS = 60_000
const ACTIVITY_PUBLICATION_BATCH_SIZE = 256

/** A stored tab order's ids; a corrupt row reads as no saved order. */
function parseTabIds(raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : undefined
  } catch {
    return undefined
  }
}

/** RETAINED EXTERNAL-INPUT BRAND CASTS: compatibility helpers accept and trim
 * raw session ids before queries or writes. Selected session ids flow from the
 * schema without re-entry casts. */
/** The one row shape every session read returns, before mapping. */
type SessionSelect = typeof sessionsTable.$inferSelect

const pendingActivityPublication = (t: StoreTables) =>
  sql`${t.sessions.publishedLastActiveAt} < ${t.sessions.lastActiveAt} AND ${t.sessions.deletedAt} IS NULL`

const activityPublicationsDueWhere = (t: StoreTables) =>
  inWorkspace(
    t.sessions,
    pendingActivityPublication(t),
    lte(t.sessions.lastActivePublishAfter, param(t.sessions.lastActivePublishAfter, 'now')),
  )

// The partial index contains only sessions with an unpublished activity stamp,
// including stopped sessions left by a restart. History never enters the tick.
// SQLite is told the index (INDEXED BY, so the columns are bare identifiers);
// Postgres has no such clause and its planner matches the partial index itself.
const activityPublicationsDue = dialectPrepared<{ readonly now: number }, { id: SessionId }>()({
  sqlite: (db, t) =>
    db
      .select({ id: sql<SessionId>`id` })
      .from(sql`${t.sessions} INDEXED BY idx_sessions_pending_activity`)
      .where(activityPublicationsDueWhere(t))
      .orderBy(asc(t.sessions.lastActivePublishAfter), asc(t.sessions.id))
      .limit(ACTIVITY_PUBLICATION_BATCH_SIZE)
      .prepare(),
  pg: (db, t) =>
    db
      .select({ id: t.sessions.id })
      .from(t.sessions)
      .where(activityPublicationsDueWhere(t))
      .orderBy(asc(t.sessions.lastActivePublishAfter), asc(t.sessions.id))
      .limit(ACTIVITY_PUBLICATION_BATCH_SIZE)
      .prepare(),
})

const publishSessionActivity = preparedFamily((db, t, size: number) =>
  captureWrite(
    db
      .update(t.sessions)
      .set({
        publishedLastActiveAt: t.sessions.lastActiveAt,
        lastActivePublishAfter: sql.placeholder('next'),
      })
      .where(
        inWorkspace(
          t.sessions,
          inListOf(t.sessions.id, size),
          pendingActivityPublication(t),
          lte(t.sessions.lastActivePublishAfter, param(t.sessions.lastActivePublishAfter, 'now')),
        ),
      ),
  ).prepare(),
)

// Every query this repository runs, prepared once per store [POD-6147].

const bindingOwnersOnMachine = prepared((db, t) =>
  db
    .select({ id: t.sessions.id, owner: t.sessions.ownerUserId })
    .from(t.sessions)
    .where(
      inWorkspace(t.sessions, eq(t.sessions.machineId, param(t.sessions.machineId, 'machineId'))),
    )
    .prepare(),
)

const bindingOwnersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.sessions.id, owner: t.sessions.ownerUserId })
    .from(t.sessions)
    .where(inWorkspace(t.sessions, inListOf(t.sessions.id, size)))
    .prepare(),
)

const bindingFactsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.sessions.id,
      owner: t.sessions.ownerUserId,
      machineId: t.sessions.machineId,
      deletedAt: t.sessions.deletedAt,
      delegation: t.sessions.delegation,
    })
    .from(t.sessions)
    .where(inWorkspace(t.sessions, inListOf(t.sessions.id, size)))
    .prepare(),
)

/**
 * THE ONE SESSION READ. Every reader supplies a predicate and inherits this
 * ordering; three of them depend on it meaning the same thing, so it is
 * declared once (see `findSessionByResumeValue`). Ties on `created_at` break by
 * the primary key, which both engines have (POD-6983; it was SQLite's `rowid`,
 * insertion order, which Postgres has no counterpart of).
 */
function sessionsWhere(db: StoreDrizzle, t: StoreTables, where: SQL | undefined) {
  return db
    .select()
    .from(t.sessions)
    .where(inWorkspace(t.sessions, where))
    .orderBy(asc(t.sessions.createdAt), asc(t.sessions.id))
    .prepare()
}

/**
 * The selections the durable session records ask (POD-6160): a predicate and
 * NO ordering. Their caller merges them with the resident sessions and orders
 * the few rows itself, so an ORDER BY here would only add a sort to an index
 * read.
 */
function sessionsMatching(db: StoreDrizzle, t: StoreTables, where: SQL | undefined) {
  return db.select().from(t.sessions).where(inWorkspace(t.sessions, where)).prepare()
}

/**
 * {@link sessionsMatching} through one named index [POD-7034]. For an IN list
 * whose keys are sparse while a few common values hold many rows: the
 * statistics give the average, and at a few hundred keys the planner prices
 * the seeks above a scan of every session, though each asked key holds a few.
 */
function sessionsMatchingThrough(
  db: StoreDrizzle,
  t: StoreTables,
  index: string,
  where: SQL | undefined,
) {
  return db
    .select(bareColumns(t.sessions))
    .from(sql`${t.sessions} INDEXED BY ${sql.identifier(index)}`)
    .where(inWorkspace(t.sessions, where))
    .prepare()
}

/**
 * THE MOST-EXECUTED SESSION STATEMENT, PREPARED ONCE [POD-3854].
 *
 * `getSession` reads one row by id with the ordering every session read shares
 * (`sessionsWhere`). Seven minutes of a live instance issued it 146,040 times,
 * and against a 49-column selection the per-call rebuild dominated: 256.6 us
 * fluent against 28.8 us prepared on the migrated schema.
 *
 * THE ORDERING IS KEPT THOUGH IT CANNOT MATTER. `id` is the primary key, so
 * there is at most one row to order. It stays because the SQL TEXT is the key
 * to the driver's per-connection statement cache and the bucket the query
 * attribution counts under, and changing the text would move this statement to
 * a new slot in both while claiming to have only made it cheaper.
 */
const sessionById = prepared((db, t) =>
  sessionsWhere(db, t, eq(t.sessions.id, param(t.sessions.id, 'id'))),
)

const liveSessionByResumeValue = prepared((db, t) =>
  sessionsWhere(
    db,
    t,
    and(
      eq(t.sessions.resumeValue, param(t.sessions.resumeValue, 'resumeValue')),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

const sessionsOfIds = preparedFamily((db, t, size: number) =>
  sessionsWhere(db, t, inListOf(t.sessions.id, size)),
)

/** The predicate the two plural resume readers share, so they cannot drift. */
const liveSessionsOfResumeValues = preparedFamily((db, t, size: number) =>
  sessionsWhere(db, t, and(inListOf(t.sessions.resumeValue, size), isNull(t.sessions.deletedAt))),
)

const liveSessionsOfIssueIds = preparedFamily((db, t, size: number) =>
  sessionsWhere(db, t, and(inListOf(t.sessions.issueId, size), isNull(t.sessions.deletedAt))),
)

/**
 * THE COLUMNS A FLIGHT DECK PICKS ITS SEATS BY (POD-7431): mission membership,
 * resume identity, liveness and the birth ref. No payload column and no
 * satellite: the deck projects only the sessions it selects.
 */
function seatFactsWhere(db: StoreDrizzle, t: StoreTables, where: SQL, index?: string) {
  const c = bareColumns(t.sessions)
  return db
    .select({
      id: c.id,
      agentKind: c.agentKind,
      issueId: c.issueId,
      resumeKind: c.resumeKind,
      resumeValue: c.resumeValue,
      headless: c.headless,
      archived: c.archived,
      status: c.status,
      refIssueId: c.refIssueId,
      refLetter: c.refLetter,
      refDraft: c.refDraft,
      cwd: c.cwd,
      machineId: c.machineId,
    })
    .from(index ? throughIndex(db, t.sessions, index) : sql`${t.sessions}`)
    .where(inWorkspace(t.sessions, where, isNull(t.sessions.deletedAt)))
    .prepare()
}

// Through `idx_sessions_issue` by name: a mission of a few hundred issues
// would otherwise read every session under the operator's statistics, which
// price a few hundred seeks above one scan (POD-7034, POD-7118).
const seatFactsOfIssueIds = preparedFamily((db, t, size: number) =>
  seatFactsWhere(db, t, inListOf(t.sessions.issueId, size), 'idx_sessions_issue'),
)
const seatFactsOfIds = preparedFamily((db, t, size: number) =>
  seatFactsWhere(db, t, inListOf(t.sessions.id, size)),
)
const seatFactsOfResumeValues = preparedFamily((db, t, size: number) =>
  seatFactsWhere(db, t, inListOf(t.sessions.resumeValue, size)),
)
const SEAT_FACTS = {
  issue: seatFactsOfIssueIds,
  id: seatFactsOfIds,
  resume: seatFactsOfResumeValues,
} as const

/** The folded cwd `idx_sessions_cwd_folded` indexes; repeat it exactly. */
const foldedCwd = (t: StoreTables) => sql`lower(replace(${t.sessions.cwd}, '/', '\\'))`

/** Live sessions whose literal cwd lies in the key range [lo, hi) (POD-6160). */
const liveSessionsInCwdRange = prepared((db, t) =>
  sessionsMatching(
    db,
    t,
    and(
      gte(t.sessions.cwd, param(t.sessions.cwd, 'lo')),
      lt(t.sessions.cwd, param(t.sessions.cwd, 'hi')),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

/**
 * The same over the folded cwd, for Windows-style roots (POD-6160). On Postgres
 * the folded text is compared in byte order, as SQLite compares it: `COLLATE "C"`,
 * which is also the collation `idx_sessions_cwd_folded` holds there (design 2.3,
 * rule 13).
 */
const liveSessionsInFoldedCwdRange = dialectPrepared<
  { readonly lo: string; readonly hi: string },
  SessionSelect
>()({
  sqlite: (db, t) =>
    sessionsMatching(
      db,
      t,
      and(
        sql`${foldedCwd(t)} >= ${sql.placeholder('lo')}`,
        sql`${foldedCwd(t)} < ${sql.placeholder('hi')}`,
        isNull(t.sessions.deletedAt),
      ),
    ),
  pg: (db, t) =>
    sessionsMatching(
      db,
      t,
      and(
        sql`${foldedCwd(t)} COLLATE "C" >= ${sql.placeholder('lo')}`,
        sql`${foldedCwd(t)} COLLATE "C" < ${sql.placeholder('hi')}`,
        isNull(t.sessions.deletedAt),
      ),
    ),
})

/** Live sessions in one of these statuses (POD-6160). */
const liveSessionsOfStatuses = preparedFamily((db, t, size: number) =>
  sessionsMatching(db, t, and(inListOf(t.sessions.status, size), isNull(t.sessions.deletedAt))),
)

/**
 * Live headless sessions (POD-6160): resident while their row exists. The flag is a
 * literal, as `idx_sessions_headless`'s partial WHERE spells it on each engine (an
 * integer on SQLite, a boolean on Postgres), so the planner can prove the index.
 */
const liveHeadlessSessions = dialectPrepared<Record<string, never>, SessionSelect>()({
  sqlite: (db, t) =>
    sessionsMatching(db, t, and(sql`${t.sessions.headless} = 1`, isNull(t.sessions.deletedAt))),
  pg: (db, t) =>
    sessionsMatching(db, t, and(sql`${t.sessions.headless} = true`, isNull(t.sessions.deletedAt))),
})

/** Live sessions whose id lies in the key range [lo, hi): a short-id prefix (POD-6160). */
const liveSessionsInIdRange = prepared((db, t) =>
  sessionsMatching(
    db,
    t,
    and(
      gte(t.sessions.id, param(t.sessions.id, 'lo')),
      lt(t.sessions.id, param(t.sessions.id, 'hi')),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

/** Live sessions born on one of these issues with this letter (POD-6160). */
const liveSessionsOfBirthLetter = preparedFamily((db, t, size: number) =>
  sessionsMatching(
    db,
    t,
    and(
      inListOf(t.sessions.refIssueId, size),
      eq(t.sessions.refLetter, param(t.sessions.refLetter, 'letter')),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

/** Live sessions whose birth ref names one of these issues (POD-6160 D2g).
 *  `IS NOT NULL` lets the partial `idx_sessions_ref_issue` serve the IN list. */
const liveSessionsReferencingIssues = preparedFamily((db, t, size: number) =>
  sessionsMatching(
    db,
    t,
    and(
      inListOf(t.sessions.refIssueId, size),
      isNotNull(t.sessions.refIssueId),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

/** Live sessions with this draft ordinal, in any repository (POD-6160). */
const liveSessionsOfDraft = prepared((db, t) =>
  sessionsMatching(
    db,
    t,
    and(eq(t.sessions.refDraft, param(t.sessions.refDraft, 'draft')), isNull(t.sessions.deletedAt)),
  ),
)

/** Live sessions spawned by one of these parents (`spawned_by` values) (POD-6160).
 *  Through `idx_sessions_spawned_by` by name on SQLite (POD-7034): the operator's
 *  statistics average 15 sessions a value, a mean over one `user` value that
 *  holds a third of all sessions and many parents with a few children; at a
 *  few hundred parents they price the seeks above a scan of every session.
 *  Postgres has no INDEXED BY; its planner reads the per-value statistics. */
const liveSessionsSpawnedBy = preparedFamily((db, t, size: number) => {
  const where = and(inListOf(t.sessions.spawnedBy, size), isNull(t.sessions.deletedAt))
  return dialectOf(db) === 'pg'
    ? sessionsMatching(db, t, where)
    : sessionsMatchingThrough(db, t, 'idx_sessions_spawned_by', where)
})

/** The issues with this sequence number, in any repository: the issue half of
 *  a birth ref (`POD-13-A`), before its prefix is checked (POD-6160). */
const issueIdsOfSeq = prepared((db, t) =>
  db
    .select({ id: t.issues.id })
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.seq, param(t.issues.seq, 'seq'))))
    .prepare(),
)

/** A machine's live sessions (POD-6160). */
const liveSessionsOnMachine = prepared((db, t) =>
  sessionsMatching(
    db,
    t,
    and(
      eq(t.sessions.machineId, param(t.sessions.machineId, 'machineId')),
      isNull(t.sessions.deletedAt),
    ),
  ),
)

/**
 * The live sessions on one credential (credential management §7, §8): what a
 * renewal restarts and a removal stops. Ids only, through the partial index
 * `idx_sessions_credential`, whose condition this repeats.
 */
const liveSessionIdsOnCredential = prepared((db, t) =>
  db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(
      inWorkspace(
        t.sessions,
        eq(t.sessions.credentialId, param(t.sessions.credentialId, 'credentialId')),
        isNotNull(t.sessions.credentialId),
        isNull(t.sessions.deletedAt),
      ),
    )
    .prepare(),
)

const liveSessions = prepared((db, t) => sessionsWhere(db, t, isNull(t.sessions.deletedAt)))

/**
 * A machine's sessions whose desired state the lifecycle controller has not
 * acknowledged (POD-6356). The condition is the partial index's own, spelled as
 * literal column comparisons so the planner can prove it, and the index is
 * named (server-data rule 3); the FROM is an INDEXED BY clause, so the columns
 * are bare identifiers.
 */
const lifecyclePendingWhere = (t: StoreTables) =>
  inWorkspace(
    t.sessions,
    sql`machine_id = ${sql.placeholder('machineId')} AND revision > observed_revision AND deleted_at IS NULL`,
  )

/** Postgres has no INDEXED BY: its planner proves the partial index from the same terms. */
const lifecyclePendingOnMachine = dialectPrepared<{ readonly machineId: string }, { id: string }>()(
  {
    sqlite: (db, t) =>
      db
        .select({ id: sql<string>`id` })
        .from(sql`${t.sessions} INDEXED BY idx_sessions_lifecycle_pending`)
        .where(lifecyclePendingWhere(t))
        .prepare(),
    pg: (db, t) =>
      db.select({ id: sql<string>`id` }).from(t.sessions).where(lifecyclePendingWhere(t)).prepare(),
  },
)

/**
 * ONE PAGE OF THE LIVE SESSIONS, in id order after `after` (POD-6160 D2g): the
 * boot's ledger baseline reads every session this way, a page at a time, so no
 * statement returns the whole table and nothing is made resident.
 */
const liveSessionsPage = prepared((db, t) =>
  db
    .select()
    .from(t.sessions)
    .where(
      inWorkspace(
        t.sessions,
        isNull(t.sessions.deletedAt),
        sql`${t.sessions.id} > ${sql.placeholder('after')}`,
      ),
    )
    .orderBy(asc(t.sessions.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** Live sessions with no birth ref yet, in the boot ref backfill's order
 *  (#474): created_at, then id. */
const liveSessionsWithoutRef = prepared((db, t) =>
  db
    .select()
    .from(t.sessions)
    .where(
      inWorkspace(
        t.sessions,
        isNull(t.sessions.refIssueId),
        isNull(t.sessions.refDraft),
        isNull(t.sessions.deletedAt),
      ),
    )
    .orderBy(asc(t.sessions.createdAt), asc(t.sessions.id))
    .prepare(),
)

/** The ref-less live terms, spelled as `idx_sessions_refless_*` declare them so
 *  the planner can use those partial indexes. */
const REFLESS = sql.raw('s.ref_issue_id IS NULL AND s.ref_draft IS NULL AND s.deleted_at IS NULL')
/** Each arm's own workspace term on its `s`; the issue arm's probe holds `i` to that `s`. */
const S_IN_WORKSPACE = sql`s.workspace_id = ${WORKSPACE}`

/**
 * THE BOOT REF BACKFILL'S CANDIDATES (POD-6222): ref-less live sessions in one
 * of the place ranges ({@link RepoPlaces}), or bound to an issue that exists, in
 * the backfill's order. Each range is driven from `json_each` (CROSS JOIN keeps
 * it the outer loop) as one index range on `idx_sessions_refless_place`, and the
 * issue half reads `idx_sessions_refless_issue`, named with INDEXED BY because
 * without statistics the planner prefers `ref_draft IS NULL` on
 * `idx_sessions_ref_draft`, which holds every session. So the statement touches
 * the rows that can still get a ref, not every ref-less session in history.
 */
const refBackfillCandidates = dialectPrepared<
  { readonly bounded: string; readonly open: string },
  SessionSelect
>()({
  sqlite: (db, t) =>
    db
      .select()
      .from(t.sessions)
      .where(
        inWorkspace(
          t.sessions,
          sql`${t.sessions}.rowid IN (
      SELECT s.rowid FROM json_each(${sql.placeholder('bounded')}) AS b CROSS JOIN ${t.sessions} AS s
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.machine_id = json_extract(b.value, '$[0]')
          AND s.cwd >= json_extract(b.value, '$[1]') AND s.cwd < json_extract(b.value, '$[2]')
      UNION ALL
      SELECT s.rowid FROM json_each(${sql.placeholder('open')}) AS o CROSS JOIN ${t.sessions} AS s
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.machine_id = json_extract(o.value, '$[0]') AND s.cwd >= json_extract(o.value, '$[1]')
      UNION ALL
      SELECT s.rowid FROM ${t.sessions} AS s INDEXED BY idx_sessions_refless_issue
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.issue_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ${t.issues} AS i WHERE i.workspace_id = s.workspace_id AND i.id = s.issue_id)
    )`,
        ),
      )
      .orderBy(asc(t.sessions.createdAt), asc(t.sessions.id))
      .prepare(),
  // The same three arms on Postgres: each range comes from `json_array_elements`
  // over the same JSON parameter, its bounds compared in byte order (`COLLATE "C"`,
  // design 2.3 rule 13), the rows matched by primary key instead of `rowid`, and
  // no INDEXED BY (the planner reads statistics, which SQLite's lacks).
  pg: (db, t) =>
    db
      .select()
      .from(t.sessions)
      .where(
        inWorkspace(
          t.sessions,
          sql`${t.sessions.id} IN (
      SELECT s.id FROM json_array_elements(CAST(${sql.placeholder('bounded')} AS json)) AS b(value) CROSS JOIN ${t.sessions} AS s
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.machine_id = (b.value->>0) COLLATE "C"
          AND s.cwd >= (b.value->>1) COLLATE "C" AND s.cwd < (b.value->>2) COLLATE "C"
      UNION ALL
      SELECT s.id FROM json_array_elements(CAST(${sql.placeholder('open')} AS json)) AS o(value) CROSS JOIN ${t.sessions} AS s
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.machine_id = (o.value->>0) COLLATE "C" AND s.cwd >= (o.value->>1) COLLATE "C"
      UNION ALL
      SELECT s.id FROM ${t.sessions} AS s
        WHERE ${S_IN_WORKSPACE} AND ${REFLESS} AND s.issue_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ${t.issues} AS i WHERE i.workspace_id = s.workspace_id AND i.id = s.issue_id)
    )`,
        ),
      )
      .orderBy(asc(t.sessions.createdAt), asc(t.sessions.id))
      .prepare(),
})

const deletedSessions = prepared((db, t) => sessionsWhere(db, t, isNotNull(t.sessions.deletedAt)))

const deletedByIssue = (t: StoreTables): SQL | undefined =>
  and(
    isNotNull(t.sessions.deletedAt),
    eq(t.sessions.deletionSource, 'issue'),
    eq(t.sessions.deletedByIssueId, param(t.sessions.deletedByIssueId, 'issueId')),
  )

const deletedSessionsForIssue = prepared((db, t) => sessionsWhere(db, t, deletedByIssue(t)))

/**
 * The upsert keyed by the set of keys its values actually carry: drizzle skips
 * an `undefined` value in both `.values()` and `.set()`, so a row with a key
 * left undefined built a different statement in the fluent form, and builds
 * the same one here. Every caller passes the full row today; the family keeps
 * that exact.
 */
type SessionPlaceholders = Partial<Record<keyof typeof sessionsTable.$inferInsert, Placeholder>>

type SessionInsert = typeof sessionsTable.$inferInsert
type SessionColumnKey = keyof SessionInsert

/**
 * THE INDEXED COLUMNS AN UPSERT SETS ONLY WHEN THEY CHANGED [POD-6234].
 *
 * SQLite rewrites every index whose columns (or partial WHERE) an UPDATE's SET
 * names, whether or not the value moved, and it rewrites the row record whole
 * either way. So naming every column rewrote all of the sessions indexes on
 * each write: about 150 us per upsert on the rename path, and most of the pages
 * a nested savepoint journals. A column no index reads costs nothing to
 * restate and stays in every set; these are set only when their group changed.
 * Grouped so a family keyed by the changed groups has at most 2^5 statements
 * per key shape: the hot `status` alone, the rest by how they move together.
 */
const INDEXED_GROUPS: readonly (readonly SessionColumnKey[])[] = [
  ['status'],
  ['resumeValue'],
  ['issueId'],
  ['cwd', 'machineId'],
  [
    'spawnedBy',
    'refIssueId',
    'refDraft',
    'deletedAt',
    'deletedByIssueId',
    'revision',
    'observedRevision',
  ],
]
const INDEXED_COLUMNS = INDEXED_GROUPS.flat()
const GROUP_BIT = new Map(
  INDEXED_GROUPS.flatMap((group, index) => group.map((key) => [key, 1 << index] as const)),
)
const STATUS_GROUP = 1
/** Every group set: the full write, for a row this store cannot vouch for. */
const ALL_GROUPS = (1 << INDEXED_GROUPS.length) - 1

/** The indexed column values a write sends, in {@link INDEXED_COLUMNS} order. */
type IndexedColumns = readonly unknown[]

/** From the values a write sends or the row a read returns: the same keys, and
 *  every indexed column is text or integer, so a stored value reads back as the
 *  value that was sent. */
function indexedColumnsOf(values: object): IndexedColumns {
  const record = values as Record<string, unknown>
  return INDEXED_COLUMNS.map((key) => record[key])
}

/** The groups whose values differ from what the row holds. */
function changedGroups(
  stored: IndexedColumns | undefined,
  values: Record<string, unknown>,
): number {
  if (stored === undefined) return ALL_GROUPS
  let groups = 0
  INDEXED_COLUMNS.forEach((key, index) => {
    if (stored[index] !== values[key]) groups |= GROUP_BIT.get(key)!
  })
  return groups
}

/**
 * The ON CONFLICT set both session upserts share, so the one-row and the
 * many-row forms cannot drift apart. `value(key)` names the incoming value of a
 * column: its placeholder in the one-row form, `excluded."column"` in the
 * many-row form. `id`, `ownerUserId`, `agentKind`, `createdAt` and `headless`
 * are written on insert only. An indexed column outside `groups` is left out
 * (see {@link INDEXED_GROUPS}).
 */
function sessionUpsertSet(
  t: StoreTables,
  value: (key: SessionColumnKey) => Placeholder | SQL | undefined,
  groups: number,
) {
  const set: Partial<Record<SessionColumnKey, Placeholder | SQL | undefined>> =
    fullSessionUpsertSet(t, value)
  for (const key of INDEXED_COLUMNS) if ((groups & GROUP_BIT.get(key)!) === 0) delete set[key]
  return set
}

function fullSessionUpsertSet(
  t: StoreTables,
  value: (key: SessionColumnKey) => Placeholder | SQL | undefined,
) {
  const nextPublication = value('lastActivePublishAfter')
  // The interval is added to the column, not taken from the incoming value: in the
  // one-row form that value is a bare parameter, and Postgres cannot type
  // `$n - $m` from two parameters (POD-6983). For integers the two are one test.
  const publishActivity = sql`${t.sessions.lastActivePublishAfter} + ${SESSION_LAST_ACTIVE_PUBLISH_INTERVAL_MS} <= ${nextPublication}
    AND excluded."last_active_at" > ${t.sessions.publishedLastActiveAt}`
  return {
    cwd: value('cwd'),
    model: value('model'),
    effort: value('effort'),
    requestedModel: value('requestedModel'),
    requestedEffort: value('requestedEffort'),
    accountId: value('accountId'),
    credentialId: value('credentialId'),
    effectiveAuth: value('effectiveAuth'),
    credentialMismatch: value('credentialMismatch'),
    loginHarness: sql`COALESCE(${t.sessions.loginHarness}, excluded."login_harness")`,
    title: value('title'),
    name: value('name'),
    nameSource: value('nameSource'),
    originKind: value('originKind'),
    conversationId: value('conversationId'),
    resumeKind: value('resumeKind'),
    resumeValue: value('resumeValue'),
    selectedDriverId: value('selectedDriverId'),
    requestedDriverId: value('requestedDriverId'),
    boundDriverId: value('boundDriverId'),
    boundDriverCapabilities: value('boundDriverCapabilities'),
    agentStateJson: value('agentStateJson'),
    agentColor: value('agentColor'),
    observedModel: value('observedModel'),
    observedEffort: value('observedEffort'),
    observedMode: value('observedMode'),
    launchPostureJson: value('launchPostureJson'),
    handoffTargetMachineId: value('handoffTargetMachineId'),
    // BINDING IS ONE-WAY (POD-2392): once a launch is known to have had a
    // native conversation, no later write may say it never did. The rule
    // lives here rather than in the caller because it is the premise the
    // fresh-relaunch path depends on — a caller that reconstructs a stale
    // Session and persists it must not be able to un-prove a conversation.
    conversationBinding: sql`CASE
         WHEN ${t.sessions.conversationBinding} = 'bound' THEN 'bound'
         ELSE excluded."conversation_binding"
       END`,
    status: value('status'),
    exitCode: value('exitCode'),
    spawnFailure: value('spawnFailure'),
    durableLabel: value('durableLabel'),
    lastActiveAt: value('lastActiveAt'),
    publishedLastActiveAt:
      nextPublication === undefined
        ? undefined
        : sql`CASE WHEN ${publishActivity} THEN excluded."last_active_at" ELSE ${t.sessions.publishedLastActiveAt} END`,
    lastActivePublishAfter:
      nextPublication === undefined
        ? undefined
        : sql`CASE WHEN ${publishActivity} THEN ${nextPublication} ELSE ${t.sessions.lastActivePublishAfter} END`,
    terminalCols: value('terminalCols'),
    terminalRows: value('terminalRows'),
    workingMsTotal: value('workingMsTotal'),
    inputCount: value('inputCount'),
    outputCount: value('outputCount'),
    activityCount: value('activityCount'),
    archived: value('archived'),
    concertmaster: value('concertmaster'),
    workState: value('workState'),
    machineId: value('machineId'),
    lastOutputAt: value('lastOutputAt'),
    lastInputAt: value('lastInputAt'),
    lastResumedAt: value('lastResumedAt'),
    spawnedBy: value('spawnedBy'),
    issueId: value('issueId'),
    stoppedAt: value('stoppedAt'),
    stopReason: value('stopReason'),
    oomKilledAt: value('oomKilledAt'),
    desired: value('desired'),
    desiredForce: value('desiredForce'),
    revision: value('revision'),
    observedRevision: value('observedRevision'),
    lifecycleFailure: value('lifecycleFailure'),
    desiredByUser: value('desiredByUser'),
    desiredByAgent: value('desiredByAgent'),
    deletedAt: value('deletedAt'),
    deletionSource: value('deletionSource'),
    deletedByIssueId: value('deletedByIssueId'),
    workflowRunId: value('workflowRunId'),
    workflowStepId: value('workflowStepId'),
    agentProfileId: value('agentProfileId'),
    // Birth name is PERMANENT (#474): once allocated it never changes, even
    // when the session re-attaches to a different issue. COALESCE keeps the
    // first non-null allocation.
    refIssueId: sql`COALESCE(${t.sessions.refIssueId}, excluded."ref_issue_id")`,
    refLetter: sql`COALESCE(${t.sessions.refLetter}, excluded."ref_letter")`,
    refDraft: sql`COALESCE(${t.sessions.refDraft}, excluded."ref_draft")`,
    // ATTRIBUTION IS IMMUTABLE AFTER CREATE (POD-365's
    // SESSION_IMMUTABLE_AFTER_CREATE lists `createdBy`). COALESCE keeps the
    // pair stamped at birth: an upsert from a later code path — a status
    // change, a rename, a reattach — must not be able to re-attribute the
    // session to whoever happened to trigger it. It can only FILL a pair
    // that was never recorded, never overwrite one that was.
    delegation: sql`COALESCE(${t.sessions.delegation}, excluded."delegation")`,
    createdByActorKind: sql`COALESCE(${t.sessions.createdByActorKind}, excluded."created_by_actor_kind")`,
    createdByActorId: sql`COALESCE(${t.sessions.createdByActorId}, excluded."created_by_actor_id")`,
    createdByOnBehalfOf: sql`COALESCE(${t.sessions.createdByOnBehalfOf}, excluded."created_by_on_behalf_of")`,
  }
}

/** The one-row upsert, keyed `${groups}|${shape}`: the changed groups, then the keys its values carry. */
const upsertSessionOfShape = preparedFamily((db, t, key: string) => {
  const bar = key.indexOf('|')
  const groups = Number(key.slice(0, bar))
  const p = placeholdersFor(key.slice(bar + 1)) as SessionPlaceholders
  return captureWrite(
    db
      .insert(t.sessions)
      .values({ ...p, workspaceId: WORKSPACE } as unknown as SessionInsert)
      .onConflictDoUpdate({
        target: [t.sessions.workspaceId, t.sessions.id],
        set: sessionUpsertSet(t, (name) => p[name], groups),
      }),
  ).prepare()
})

/**
 * At most this many rows go in one many-row upsert. A sessions row binds 57
 * values, so 256 rows bind 14592, under SQLite's 32766 bound parameters, and
 * one activity flush of up to 256 busy sessions is one statement.
 */
const UPSERT_ROWS_PER_STATEMENT = 256

/** Placeholder name of `key` in row `index` of a many-row upsert. */
const rowParam = (index: number, key: string): string => `r${index}_${key}`

/**
 * The upsert of `size` rows that all carry the keys in `shape` [POD-6175],
 * keyed `${size}|${groups}|${shape}`. `size` comes from {@link inListSize}, so
 * there are at most log2(256) + 2 sizes per shape; a shorter batch repeats its
 * last row, and an upsert of the same row twice leaves it as once (the set is
 * the incoming values, and every COALESCE and CASE in it keeps a value it
 * already wrote). `groups` is {@link manyRowGroups} of the rows' changed groups,
 * so three per size. On Postgres, which refuses a row twice in one upsert, `size`
 * is the batch's own length instead (`padsUpsertRows`).
 */
const upsertSessionsOfShape = preparedFamily((db, t, key: string) => {
  const [sizeKey, groupsKey] = key.split('|', 2) as [string, string]
  const size = Number(sizeKey)
  const groups = Number(groupsKey)
  const shape = key.slice(sizeKey.length + groupsKey.length + 2)
  const keys = shape === '' ? [] : shape.split(',')
  const present = new Set<string>(keys)
  const columns = getTableColumns(t.sessions)
  const rows = Array.from({ length: size }, (_, index) => ({
    ...Object.fromEntries(keys.map((name) => [name, sql.placeholder(rowParam(index, name))])),
    workspaceId: WORKSPACE,
  }))
  return captureWrite(
    db
      .insert(t.sessions)
      .values(rows as unknown as SessionInsert[])
      .onConflictDoUpdate({
        target: [t.sessions.workspaceId, t.sessions.id],
        set: sessionUpsertSet(
          t,
          (name) =>
            present.has(name) ? sql`excluded.${sql.identifier(columns[name].name)}` : undefined,
          groups,
        ),
      }),
  ).prepare()
})

/**
 * The groups one many-row statement sets: what its rows changed, widened to
 * none, `status` alone or all, so a size has three statements. An activity
 * flush changes counters and times, which no index reads, and now and then a
 * status; a row whose group another row changed restates its own value, which
 * is what the full write did.
 */
function manyRowGroups(changed: number): number {
  return (changed & ~STATUS_GROUP) === 0 ? changed : ALL_GROUPS
}

/** The column values of one session row, refused before any write when the row
 *  is one no client could read. */
function sessionUpsertValues(row: SessionRow, now = Date.now()) {
  if (!row.ownerUserId) {
    throw new Error(`upsertSession: ownerUserId is required for ${row.id}`)
  }
  // Strict on write: never persist an out-of-enum agentKind. That value later fails
  // synced session validation on every client
  // (see relay.createSession, which resolves the 'auto' sentinel before it gets here).
  if (!AgentKind.safeParse(row.agentKind).success) {
    throw new Error(
      `upsertSession: refusing to persist invalid agentKind ${JSON.stringify(row.agentKind)} for ${row.id}`,
    )
  }
  const createdBy = row.createdBy ? actorColumns(row.createdBy.actor) : null
  const values = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    agentKind: row.agentKind,
    model: row.model ?? null,
    effort: row.effort ?? null,
    requestedModel: row.requestedModel ?? null,
    requestedEffort: row.requestedEffort ?? null,
    accountId: row.accountId ?? null,
    credentialId: row.credentialId ?? null,
    effectiveAuth: row.effectiveAuth == null ? null : JSON.stringify(row.effectiveAuth),
    credentialMismatch:
      row.credentialMismatch == null ? null : JSON.stringify(row.credentialMismatch),
    loginHarness: row.loginHarness ?? null,
    cwd: row.cwd,
    title: row.title,
    name: row.name,
    nameSource: row.nameSource ?? null,
    originKind: row.originKind,
    conversationId: row.conversationId,
    resumeKind: row.resumeKind,
    resumeValue: row.resumeValue,
    selectedDriverId: row.selectedDriverId ?? null,
    requestedDriverId: row.requestedDriverId ?? null,
    boundDriverId: row.boundDriverId ?? null,
    boundDriverCapabilities:
      row.boundDriverCapabilities == null ? null : JSON.stringify(row.boundDriverCapabilities),
    agentStateJson: row.agentState ? JSON.stringify(row.agentState) : null,
    agentColor: row.agentColor ?? null,
    observedModel: row.observedModel ?? null,
    observedEffort: row.observedEffort ?? null,
    observedMode: row.observedMode ?? null,
    launchPostureJson: row.launchPosture ? JSON.stringify(row.launchPosture) : null,
    handoffTargetMachineId: row.handoffTargetMachineId ?? null,
    conversationBinding: row.conversationBinding ?? null,
    status: row.status,
    exitCode: row.exitCode,
    spawnFailure: row.spawnFailure ?? null,
    durableLabel: row.durableLabel,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    publishedLastActiveAt: row.lastActiveAt,
    lastActivePublishAfter: now + SESSION_LAST_ACTIVE_PUBLISH_INTERVAL_MS,
    terminalCols: row.geometry?.cols ?? 80,
    terminalRows: row.geometry?.rows ?? 24,
    workingMsTotal: row.workingMsTotal ?? null,
    inputCount: row.inputCount ?? 0,
    outputCount: row.outputCount ?? 0,
    activityCount: row.activityCount ?? 0,
    archived: row.archived,
    concertmaster: row.concertmaster ?? false,
    workState: row.workState,
    machineId: row.machineId,
    lastOutputAt: row.lastOutputAt ?? null,
    lastInputAt: row.lastInputAt ?? null,
    lastResumedAt: row.lastResumedAt ?? null,
    spawnedBy: row.spawnedBy ?? null,
    headless: row.headless ?? false,
    issueId: row.issueId ?? null,
    stoppedAt: row.stoppedAt ?? null,
    /**
     * `stop_reason` KEEPS ITS FOUR-VALUE VOCABULARY, and `oom` is not one
     * of them: `sessions_stop_reason_check` admits only self/parent/
     * forced/exited, and widening it means a SQLite table rebuild the
     * expand-only gate refuses. So the DEATH persists as `exited` and the
     * CAUSE persists beside it as a timestamp; `Session.hydrate` re-derives
     * `oom` from the pair. Without this the whole write threw on the CHECK
     * and took the durable `oomKilled` event append down with it.
     */
    stopReason: row.stopReason === 'oom' ? 'exited' : (row.stopReason ?? null),
    oomKilledAt: row.oomKilledAt ?? null,
    desired: (row.lifecycle ?? NO_LIFECYCLE).desired,
    desiredForce: (row.lifecycle ?? NO_LIFECYCLE).force,
    revision: (row.lifecycle ?? NO_LIFECYCLE).revision,
    observedRevision: (row.lifecycle ?? NO_LIFECYCLE).observedRevision,
    lifecycleFailure: encodeLifecycleFailure((row.lifecycle ?? NO_LIFECYCLE).failure),
    desiredByUser: (row.lifecycle ?? NO_LIFECYCLE).byUser,
    desiredByAgent: (row.lifecycle ?? NO_LIFECYCLE).byAgent,
    deletedAt: row.deletedAt ?? null,
    deletionSource: row.deletionSource ?? null,
    deletedByIssueId: row.deletedByIssueId ?? null,
    workflowRunId: row.workflowRunId ?? null,
    workflowStepId: row.workflowStepId ?? null,
    agentProfileId: row.agentProfileId ?? null,
    refIssueId: row.refIssueId ?? null,
    refLetter: row.refLetter ?? null,
    refDraft: row.refDraft ?? null,
    delegation: row.delegation ?? null,
    createdByActorKind: createdBy ? createdBy.kind : null,
    createdByActorId: createdBy ? createdBy.id : null,
    createdByOnBehalfOf: row.createdBy?.onBehalfOf ?? null,
  }
  return values
}

const untombstonedById = (t: StoreTables): SQL | undefined =>
  inWorkspace(
    t.sessions,
    eq(t.sessions.id, param(t.sessions.id, 'id')),
    isNull(t.sessions.deletedAt),
  )

const stopRunningForTombstone = prepared((db, t) =>
  captureWrite(
    db
      .update(t.sessions)
      .set({ status: 'exited', stoppedAt: sql.placeholder('deletedAt'), stopReason: 'forced' })
      .where(and(untombstonedById(t), inArray(t.sessions.status, ['starting', 'live']))),
  ).prepare(),
)

const tombstoneSession = prepared((db, t) =>
  captureWrite(
    db
      .update(t.sessions)
      .set({
        deletedAt: sql.placeholder('deletedAt'),
        deletionSource: sql.placeholder('source'),
        deletedByIssueId: sql.placeholder('deletedByIssueId'),
      })
      .where(untombstonedById(t)),
  ).prepare(),
)

const restoreSessionsOfIssue = prepared((db, t) =>
  captureWrite(
    db
      .update(t.sessions)
      .set({
        deletedAt: null,
        deletionSource: null,
        deletedByIssueId: null,
        status: 'exited',
        exitCode: null,
      })
      .where(inWorkspace(t.sessions, deletedByIssue(t))),
  ).prepare(),
)

const detachTombstones = prepared((db, t) => {
  const issueId = sql.placeholder('issueId')
  return captureWrite(
    db
      .update(t.sessions)
      .set({
        issueId: sql`CASE WHEN ${t.sessions.issueId} = ${issueId} THEN NULL ELSE ${t.sessions.issueId} END`,
        refIssueId: sql`CASE WHEN ${t.sessions.refIssueId} = ${issueId} THEN NULL ELSE ${t.sessions.refIssueId} END`,
        refLetter: sql`CASE WHEN ${t.sessions.refIssueId} = ${issueId} THEN NULL ELSE ${t.sessions.refLetter} END`,
      })
      .where(
        inWorkspace(
          t.sessions,
          isNotNull(t.sessions.deletedAt),
          or(
            eq(t.sessions.issueId, param(t.sessions.issueId, 'issueId')),
            eq(t.sessions.refIssueId, param(t.sessions.refIssueId, 'issueId')),
          ),
        ),
      ),
  ).prepare()
})

const detachDanglingReferences = prepared((db, t) => {
  // The subquery's own column is unqualified and resolves inside `issues`,
  // which is what it must do; the OUTER columns are the `sessions` ones the
  // builder qualifies for us here because they are named as columns rather
  // than interpolated into the fragment.
  // The subquery reads this workspace's issues only, in its own scope.
  const workspaceIssueIds = sql`SELECT ${t.issues.id} FROM ${t.issues} WHERE ${t.issues.workspaceId} = ${WORKSPACE}`
  const danglingIssue = sql`${t.sessions.issueId} IS NOT NULL AND ${t.sessions.issueId} NOT IN (${workspaceIssueIds})`
  const danglingRef = sql`${t.sessions.refIssueId} IS NOT NULL AND ${t.sessions.refIssueId} NOT IN (${workspaceIssueIds})`
  return captureWrite(
    db
      .update(t.sessions)
      .set({
        issueId: sql`CASE WHEN ${danglingIssue} THEN NULL ELSE ${t.sessions.issueId} END`,
        refLetter: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${t.sessions.refLetter} END`,
        refIssueId: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${t.sessions.refIssueId} END`,
      })
      .where(inWorkspace(t.sessions, or(danglingIssue, danglingRef))),
  ).prepare()
})

const deleteCheckpointsOfSession = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.runtimeEventCheckpoints)
      .where(
        inWorkspace(
          t.runtimeEventCheckpoints,
          eq(t.runtimeEventCheckpoints.sessionId, param(t.runtimeEventCheckpoints.sessionId, 'id')),
        ),
      ),
  ).prepare(),
)

const deleteSessionRow = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.sessions)
      .where(inWorkspace(t.sessions, eq(t.sessions.id, param(t.sessions.id, 'id')))),
  ).prepare(),
)

const deletePanelPinsOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.pins)
      .where(inWorkspace(t.pins, eq(t.pins.kind, 'panel'), eq(t.pins.id, param(t.pins.id, 'id')))),
  ).prepare(),
)

const deleteDraftOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.sessionDrafts)
      .where(
        inWorkspace(
          t.sessionDrafts,
          eq(t.sessionDrafts.sessionId, param(t.sessionDrafts.sessionId, 'id')),
        ),
      ),
  ).prepare(),
)

const deleteSnoozesOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.snoozes)
      .where(inWorkspace(t.snoozes, eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'id')))),
  ).prepare(),
)

const deleteUserStateOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.sessionUserState)
      .where(
        inWorkspace(
          t.sessionUserState,
          eq(t.sessionUserState.sessionId, param(t.sessionUserState.sessionId, 'id')),
        ),
      ),
  ).prepare(),
)

const deleteOfferOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.offers)
      .where(inWorkspace(t.offers, eq(t.offers.sessionId, param(t.offers.sessionId, 'id')))),
  ).prepare(),
)

const insertPin = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.pins)
      .values({
        workspaceId: WORKSPACE,
        userId: sql.placeholder('userId'),
        kind: sql.placeholder('kind'),
        id: sql.placeholder('id'),
        pinnedAt: sql.placeholder('pinnedAt'),
      })
      .onConflictDoNothing(),
  ).prepare(),
)

const onePin = (t: StoreTables) =>
  inWorkspace(
    t.pins,
    eq(t.pins.userId, param(t.pins.userId, 'userId')),
    eq(t.pins.kind, param(t.pins.kind, 'kind')),
    eq(t.pins.id, param(t.pins.id, 'id')),
  )

const deletePin = prepared((db, t) => captureWrite(db.delete(t.pins).where(onePin(t))).prepare())

// Every person's pin of one thing, removed with it (POD-6692: a purged issue).
const deletePinsOfTarget = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.pins)
      .where(
        inWorkspace(
          t.pins,
          eq(t.pins.kind, param(t.pins.kind, 'kind')),
          eq(t.pins.id, param(t.pins.id, 'id')),
        ),
      )
      .returning({ userId: t.pins.userId }),
  ).prepare(),
)

/** Who pins one thing, through `idx_pins_target`. */
const pinnersOfTarget = prepared((db, t) =>
  db
    .select({ userId: t.pins.userId })
    .from(t.pins)
    .where(
      inWorkspace(
        t.pins,
        eq(t.pins.kind, param(t.pins.kind, 'kind')),
        eq(t.pins.id, param(t.pins.id, 'id')),
      ),
    )
    .prepare(),
)

const pinOf = prepared((db, t) =>
  db.select({ pinnedAt: t.pins.pinnedAt }).from(t.pins).where(onePin(t)).prepare(),
)

// Every person's pins: the `pin` kind's full truth for the boot reconcile.
const allPins = prepared((db, t) =>
  db
    .select({
      userId: t.pins.userId,
      kind: t.pins.kind,
      id: t.pins.id,
      pinnedAt: t.pins.pinnedAt,
    })
    .from(t.pins)
    .where(inWorkspace(t.pins))
    // Oldest first, ties by the key: said rather than left to the plan, which since the key
    // leads with the workspace (POD-7024) may read the pins in key order, and the same on
    // both engines (Postgres has no rowid).
    .orderBy(asc(t.pins.pinnedAt), asc(t.pins.userId), asc(t.pins.kind), asc(t.pins.id))
    .prepare(),
)

const allUserStateRows = prepared((db, t) =>
  db.select().from(t.sessionUserState).where(inWorkspace(t.sessionUserState)).prepare(),
)

const personalRecordKeys = preparedFamily((db, t, size: number) =>
  db
    .select({ userId: t.sessionUserState.userId, sessionId: t.sessionUserState.sessionId })
    .from(t.sessionUserState)
    .where(inWorkspace(t.sessionUserState, inListOf(t.sessionUserState.sessionId, size)))
    .unionAll(
      db
        .select({ userId: t.snoozes.userId, sessionId: t.snoozes.sessionId })
        .from(t.snoozes)
        .where(inWorkspace(t.snoozes, inListOf(t.snoozes.sessionId, size))),
    )
    .prepare(),
)

/** The same keys for these people (POD-6920: a disabled person's markers leave). */
const personalRecordKeysOfUsers = preparedFamily((db, t, size: number) =>
  db
    .select({ userId: t.sessionUserState.userId, sessionId: t.sessionUserState.sessionId })
    .from(t.sessionUserState)
    .where(inWorkspace(t.sessionUserState, inListOf(t.sessionUserState.userId, size)))
    .unionAll(
      db
        .select({ userId: t.snoozes.userId, sessionId: t.snoozes.sessionId })
        .from(t.snoozes)
        .where(inWorkspace(t.snoozes, inListOf(t.snoozes.userId, size))),
    )
    .prepare(),
)

const userStateRowsOfSession = prepared((db, t) =>
  db
    .select()
    .from(t.sessionUserState)
    .where(
      inWorkspace(
        t.sessionUserState,
        eq(t.sessionUserState.sessionId, param(t.sessionUserState.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const allSnoozeRows = prepared((db, t) =>
  db.select().from(t.snoozes).where(inWorkspace(t.snoozes)).prepare(),
)

const snoozeRowsOfSession = prepared((db, t) =>
  db
    .select()
    .from(t.snoozes)
    .where(inWorkspace(t.snoozes, eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'sessionId'))))
    .prepare(),
)

const userSessionSnooze = prepared((db, t) =>
  db
    .select({ until: t.snoozes.snoozedUntil })
    .from(t.snoozes)
    .where(
      inWorkspace(
        t.snoozes,
        eq(t.snoozes.userId, param(t.snoozes.userId, 'userId')),
        eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const readAtOfUser = prepared((db, t) =>
  db
    .select({ sessionId: t.sessionUserState.sessionId, readAt: t.sessionUserState.readAt })
    .from(t.sessionUserState)
    .where(
      inWorkspace(
        t.sessionUserState,
        eq(t.sessionUserState.userId, param(t.sessionUserState.userId, 'userId')),
      ),
    )
    .prepare(),
)

const userSessionState = (t: StoreTables): SQL | undefined =>
  inWorkspace(
    t.sessionUserState,
    eq(t.sessionUserState.userId, param(t.sessionUserState.userId, 'userId')),
    eq(t.sessionUserState.sessionId, param(t.sessionUserState.sessionId, 'sessionId')),
  )

const readAtOfUserSession = prepared((db, t) =>
  db
    .select({ readAt: t.sessionUserState.readAt })
    .from(t.sessionUserState)
    .where(userSessionState(t))
    .prepare(),
)

const upsertReadAt = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.sessionUserState)
      .values({
        workspaceId: WORKSPACE,
        userId: sql.placeholder('userId'),
        sessionId: sql.placeholder('sessionId'),
        readAt: sql.placeholder('readAt'),
      })
      .onConflictDoUpdate({
        target: [
          t.sessionUserState.workspaceId,
          t.sessionUserState.userId,
          t.sessionUserState.sessionId,
        ],
        set: { readAt: sql.placeholder('readAt') },
      }),
  ).prepare(),
)

const deleteReadAt = prepared((db, t) =>
  captureWrite(db.delete(t.sessionUserState).where(userSessionState(t))).prepare(),
)

const deleteAllReadAtOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.sessionUserState)
      .where(
        inWorkspace(
          t.sessionUserState,
          eq(t.sessionUserState.sessionId, param(t.sessionUserState.sessionId, 'sessionId')),
        ),
      )
      .returning({ userId: t.sessionUserState.userId }),
  ).prepare(),
)

/** One user's read markers for a set of sessions (POD-6160). */
const readAtOfUserSessions = preparedFamily((db, t, size: number) =>
  db
    .select({ sessionId: t.sessionUserState.sessionId, readAt: t.sessionUserState.readAt })
    .from(t.sessionUserState)
    .where(
      inWorkspace(
        t.sessionUserState,
        eq(t.sessionUserState.userId, param(t.sessionUserState.userId, 'userId')),
        inListOf(t.sessionUserState.sessionId, size),
      ),
    )
    .prepare(),
)

/** One user's snoozes for a set of sessions (POD-6160). */
const snoozesOfUserSessions = preparedFamily((db, t, size: number) =>
  db
    .select({ sessionId: t.snoozes.sessionId, snoozedUntil: t.snoozes.snoozedUntil })
    .from(t.snoozes)
    .where(
      inWorkspace(
        t.snoozes,
        eq(t.snoozes.userId, param(t.snoozes.userId, 'userId')),
        inListOf(t.snoozes.sessionId, size),
      ),
    )
    .prepare(),
)

const snoozesOfUser = prepared((db, t) =>
  db
    .select({ sessionId: t.snoozes.sessionId, snoozedUntil: t.snoozes.snoozedUntil })
    .from(t.snoozes)
    .where(inWorkspace(t.snoozes, eq(t.snoozes.userId, param(t.snoozes.userId, 'userId'))))
    .prepare(),
)

const deleteUserSnooze = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.snoozes)
      .where(
        inWorkspace(
          t.snoozes,
          eq(t.snoozes.userId, param(t.snoozes.userId, 'userId')),
          eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'sessionId')),
        ),
      ),
  ).prepare(),
)

const upsertSnooze = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.snoozes)
      .values({
        workspaceId: WORKSPACE,
        userId: sql.placeholder('userId'),
        sessionId: sql.placeholder('sessionId'),
        snoozedUntil: sql.placeholder('snoozedUntil'),
        createdAt: sql.placeholder('createdAt'),
      })
      .onConflictDoUpdate({
        target: [t.snoozes.workspaceId, t.snoozes.userId, t.snoozes.sessionId],
        set: { snoozedUntil: sql.placeholder('snoozedUntil') },
      }),
  ).prepare(),
)

const anySnoozeOf = prepared((db, t) =>
  db
    .select({ present: sql<number>`1` })
    .from(t.snoozes)
    .where(inWorkspace(t.snoozes, eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'sessionId'))))
    .limit(1)
    .prepare(),
)

const deleteAllSnoozesOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.snoozes)
      .where(
        inWorkspace(t.snoozes, eq(t.snoozes.sessionId, param(t.snoozes.sessionId, 'sessionId'))),
      )
      .returning({ userId: t.snoozes.userId }),
  ).prepare(),
)

const allOffers = prepared((db, t) =>
  db.select().from(t.offers).where(inWorkspace(t.offers)).prepare(),
)

const offersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.offers)
    .where(inWorkspace(t.offers, inListOf(t.offers.sessionId, size)))
    .prepare(),
)

const upsertOffer = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.offers)
      .values({
        workspaceId: WORKSPACE,
        sessionId: sql.placeholder('sessionId'),
        message: sql.placeholder('message'),
        actions: sql.placeholder('actions'),
        artifacts: sql.placeholder('artifacts'),
        createdAt: sql.placeholder('createdAt'),
      })
      .onConflictDoUpdate({
        target: [t.offers.workspaceId, t.offers.sessionId],
        set: {
          message: sql.placeholder('message'),
          actions: sql.placeholder('actions'),
          artifacts: sql.placeholder('artifacts'),
          createdAt: sql.placeholder('createdAt'),
        },
      }),
  ).prepare(),
)

const offerCreatedAtOf = prepared((db, t) =>
  db
    .select({ createdAt: t.offers.createdAt })
    .from(t.offers)
    .where(inWorkspace(t.offers, eq(t.offers.sessionId, param(t.offers.sessionId, 'sessionId'))))
    .prepare(),
)

const tabOrderOf = prepared((db, t) =>
  db
    .select({ ids: t.tabOrder.ids })
    .from(t.tabOrder)
    .where(
      inWorkspace(
        t.tabOrder,
        eq(t.tabOrder.userId, param(t.tabOrder.userId, 'userId')),
        eq(t.tabOrder.worktree, param(t.tabOrder.worktree, 'worktree')),
      ),
    )
    .prepare(),
)

const deleteTabOrder = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.tabOrder)
      .where(
        inWorkspace(
          t.tabOrder,
          eq(t.tabOrder.userId, param(t.tabOrder.userId, 'userId')),
          eq(t.tabOrder.worktree, param(t.tabOrder.worktree, 'worktree')),
        ),
      ),
  ).prepare(),
)

const upsertTabOrder = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.tabOrder)
      .values({
        workspaceId: WORKSPACE,
        userId: sql.placeholder('userId'),
        worktree: sql.placeholder('worktree'),
        ids: sql.placeholder('ids'),
        updatedAt: sql.placeholder('updatedAt'),
      })
      .onConflictDoUpdate({
        target: [t.tabOrder.workspaceId, t.tabOrder.userId, t.tabOrder.worktree],
        set: { ids: sql.placeholder('ids'), updatedAt: sql.placeholder('updatedAt') },
      }),
  ).prepare(),
)

// THREE COLUMNS, NAMED, because the statement this replaces named three
// [spec rule 39]. `tab_order` has four; spreading the table here would read
// `updated_at` on every row of every purge and hand it to a reader that
// builds its object from `user_id`, `worktree` and `ids` — right rows, right
// values, and an extra column over the wire on a remote driver, which is
// this epic's whole criterion. No test could have seen it.
/** Many people's pins and tab orders, for building those records by id
 *  (POD-6763): a person's own rows, through the primary key's `user_id` prefix. */
const pinsOfUsers = preparedFamily((db, t, size: number) =>
  db
    .select({
      userId: t.pins.userId,
      kind: t.pins.kind,
      id: t.pins.id,
      pinnedAt: t.pins.pinnedAt,
    })
    .from(t.pins)
    .where(inWorkspace(t.pins, inListOf(t.pins.userId, size, 'users')))
    .orderBy(asc(t.pins.pinnedAt), asc(t.pins.userId), asc(t.pins.kind), asc(t.pins.id))
    .prepare(),
)

const tabOrdersOfUsers = preparedFamily((db, t, size: number) =>
  db
    .select({ userId: t.tabOrder.userId, worktree: t.tabOrder.worktree, ids: t.tabOrder.ids })
    .from(t.tabOrder)
    .where(inWorkspace(t.tabOrder, inListOf(t.tabOrder.userId, size, 'users')))
    .prepare(),
)

const allTabOrders = prepared((db, t) =>
  db
    .select({ userId: t.tabOrder.userId, worktree: t.tabOrder.worktree, ids: t.tabOrder.ids })
    .from(t.tabOrder)
    .where(inWorkspace(t.tabOrder))
    .prepare(),
)

const draftTexts = prepared((db, t) =>
  db
    .select({ sessionId: t.sessionDrafts.sessionId, text: t.sessionDrafts.text })
    .from(t.sessionDrafts)
    .where(inWorkspace(t.sessionDrafts))
    .prepare(),
)

const draftTimes = prepared((db, t) =>
  db
    .select({ sessionId: t.sessionDrafts.sessionId, updatedAt: t.sessionDrafts.updatedAt })
    .from(t.sessionDrafts)
    .where(inWorkspace(t.sessionDrafts))
    .prepare(),
)

const draftTimesOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ sessionId: t.sessionDrafts.sessionId, updatedAt: t.sessionDrafts.updatedAt })
    .from(t.sessionDrafts)
    .where(inWorkspace(t.sessionDrafts, inListOf(t.sessionDrafts.sessionId, size)))
    .prepare(),
)

const upsertDraftText = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.sessionDrafts)
      .values({
        workspaceId: WORKSPACE,
        sessionId: sql.placeholder('sessionId'),
        text: sql.placeholder('text'),
        updatedAt: sql.placeholder('updatedAt'),
      })
      .onConflictDoUpdate({
        target: [t.sessionDrafts.workspaceId, t.sessionDrafts.sessionId],
        set: { text: sql.placeholder('text'), updatedAt: sql.placeholder('updatedAt') },
      }),
  ).prepare(),
)

const allDraftRows = prepared((db, t) =>
  db.select().from(t.sessionDrafts).where(inWorkspace(t.sessionDrafts)).prepare(),
)

/** One session's versioned draft document (POD-6160: drafts load on use). */
const draftRowOf = prepared((db, t) =>
  db
    .select()
    .from(t.sessionDrafts)
    .where(
      inWorkspace(
        t.sessionDrafts,
        eq(t.sessionDrafts.sessionId, param(t.sessionDrafts.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const upsertDraftDoc = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.sessionDrafts)
      .values({
        workspaceId: WORKSPACE,
        sessionId: sql.placeholder('sessionId'),
        text: sql.placeholder('text'),
        updatedAt: sql.placeholder('updatedAt'),
        rev: sql.placeholder('rev'),
        origin: sql.placeholder('origin'),
        history: sql.placeholder('history'),
      })
      .onConflictDoUpdate({
        target: [t.sessionDrafts.workspaceId, t.sessionDrafts.sessionId],
        set: {
          text: sql.placeholder('text'),
          updatedAt: sql.placeholder('updatedAt'),
          rev: sql.placeholder('rev'),
          origin: sql.placeholder('origin'),
          history: sql.placeholder('history'),
        },
      }),
  ).prepare(),
)

/** Run a session-row write as a change-log commit: a liveness change moves
 *  the session's confirmed message window, and the commit drains the
 *  database's change capture in the same transaction (POD-6920). */
export type SessionMessageWindowWrite = (write: () => Promise<void>) => Promise<void>

export class SessionsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  private messageWindowWrite: SessionMessageWindowWrite | undefined
  private snoozeLapseCommit: ChangeLogCommit | undefined

  /** Installed with the message feed. Every liveness-changing write below
   *  runs as a change-log commit inside the same transaction. */
  setMessageWindowWrite(write: SessionMessageWindowWrite): () => void {
    this.messageWindowWrite = write
    return () => {
      if (this.messageWindowWrite === write) this.messageWindowWrite = undefined
    }
  }

  private async writeSessionRows(write: () => Promise<void>): Promise<void> {
    if (this.messageWindowWrite) await this.messageWindowWrite(write)
    else await write()
  }

  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * The message-window hook supplies the write span after composition. Both
   * query members retain the store's ambient transaction routing.
   */
  constructor(
    queries: WorkspaceQueries,
    private readonly purgeObservationCheckpoint: (
      sessionId: SessionId,
    ) => void | Promise<void> = () => {},
  ) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    const dialect = dialectOf(queries.db.drizzle)
    // Off on Postgres, where more than one process writes `sessions` (written-columns.ts).
    this.writtenColumns = WrittenColumns.forDialect(dialect, 'sessions:written-columns')
    this.padsUpsertRows = dialect === 'sqlite'
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line rather than 39 fields.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  // ---- sessions ----
  /**
   * The `sessionUserState` record ids of the stored read and snooze rows of
   * these sessions, or of these people (POD-6920: a deleted session's and a
   * disabled person's markers leave the feed).
   */
  async sessionUserStateIdsOf(
    by: { sessionIds: readonly string[] } | { userIds: readonly string[] },
  ): Promise<string[]> {
    const ids = 'sessionIds' in by ? by.sessionIds : by.userIds
    const query = 'sessionIds' in by ? personalRecordKeys : personalRecordKeysOfUsers
    const out = new Set<string>()
    for (const chunk of chunked(ids)) {
      const size = inListSize(chunk.length)
      for (const row of await query(this.db, size).all(inListValues(chunk, size)))
        out.add(sessionUserStateRowId(row.userId as UserId, row.sessionId as SessionId))
    }
    return [...out]
  }

  /** The owners of the sessions placed on one machine (a peer that sends no
   * inventory), or of the named ids. Raw facts: the caller decides who may
   * learn them (`disclosedBindingFacts`, `modules/machines/service.ts`). */
  async bindingOwnersForMachine(
    machineId: MachineId,
    sessionIds?: readonly string[],
  ): Promise<Record<string, string>> {
    if (sessionIds?.length === 0) return {}
    let rows: { id: SessionId; owner: UserId }[]
    if (sessionIds === undefined) {
      rows = await bindingOwnersOnMachine(this.db).all({ machineId })
    } else {
      const size = inListSize(sessionIds.length)
      rows = await bindingOwnersOfIds(this.db, size).all(
        inListValues(sessionIds.map(asSessionId), size),
      )
    }
    return Object.fromEntries(rows.map((row) => [row.id, row.owner]))
  }

  /** The placement facts of the requested ids, across machines. Raw facts: the
   * connect path discloses only what the machine may learn
   * (`disclosedBindingFacts`, `modules/machines/service.ts`, POD-6286). */
  async bindingConfirmations(
    ids: readonly string[],
  ): Promise<import('@podium/protocol').BindingConfirmations> {
    const result: import('@podium/protocol').BindingConfirmations = Object.fromEntries(
      ids.map((id) => [id, { owner: null, machineId: null, closed: false }]),
    )
    if (ids.length === 0) return result
    const size = inListSize(ids.length)
    const rows = await bindingFactsOfIds(this.db, size).all(
      inListValues(ids.map(asSessionId), size),
    )
    for (const row of rows)
      result[row.id] = {
        owner: row.owner,
        machineId: row.machineId,
        closed: row.deletedAt !== null,
        ...(row.delegation ? { delegation: row.delegation } : {}),
      }
    return result
  }

  async loadSessions(): Promise<SessionRow[]> {
    return (await liveSessions(this.db).all()).map(mapSession)
  }

  async hasAnySession(): Promise<boolean> {
    return (await anySession(this.db).get()) !== undefined
  }

  /** Up to `limit` live sessions with an id after `after` ('' = the first), in
   *  id order (POD-6160 D2g). */
  async sessionsPage(after: string, limit: number): Promise<SessionRow[]> {
    return (await liveSessionsPage(this.db).all({ after, limit })).map(mapSession)
  }

  /** Every live session with no birth ref, in created_at, id order: the boot
   *  backfill's fallback when a prefix no registered root explains could name
   *  any of them (POD-6222, `ReposRepository.prefixedPlaces`). */
  async sessionsWithoutRef(): Promise<SessionRow[]> {
    return (await liveSessionsWithoutRef(this.db).all()).map(mapSession)
  }

  /** The live ref-less sessions that can still get a birth ref: in `places`, or
   *  bound to an existing issue, in created_at, id order (POD-6222). A superset;
   *  the backfill asks `prepareRefAllocation` per row. */
  async refBackfillCandidates(places: RepoPlaces): Promise<SessionRow[]> {
    return (
      await refBackfillCandidates(this.db).all({
        bounded: JSON.stringify(places.bounded),
        open: JSON.stringify(places.open),
      })
    ).map(mapSession)
  }

  /** One durable row, including a tombstone, for scoped delete visibility. */
  async getSession(sessionId: SessionId): Promise<SessionRow | undefined> {
    const mark = this.writtenColumns.mark
    const row = (await sessionById(this.db).all({ id: sessionId }))[0]
    if (row === undefined) return undefined
    this.writtenColumns.read([[row.id, indexedColumnsOf(row)]], mark)
    return mapSession(row)
  }

  /**
   * {@link getSession} through the operation's loader [POD-6149]. Loads asked
   * for in the same tick become one {@link getSessions} query, and a row already
   * loaded is reused for the rest of the OPERATION (POD-6210: a tRPC call or a
   * daemon frame, its write spans included), so the access check before a write
   * and the restore of a parked session for it read the row once. Outside an
   * operation and an explicit scope it is exactly one `getSession`. Every
   * session-row write below invalidates it, after the write and after its
   * commit ({@link rowsWritten}), so a read after a write sees the write.
   */
  async loadSession(sessionId: SessionId): Promise<SessionRow | undefined> {
    return await this.sessionRows.load(sessionId)
  }

  private readonly sessionRows = operationLoader<string, SessionRow>(
    async (ids) => await this.getSessions(ids),
    { copy: (row) => ({ ...row }), perOperation: true },
  )

  /** A session-row write: invalidated after it and, inside a span, after its commit. */
  private rowsWritten(): void {
    this.sessionRows.invalidate()
    if (spanOpen()) applyAfterCommit(() => this.sessionRows.invalidate(), 'sessions:row-loader')
  }

  /**
   * The live session a conversation resumes into, by its `resumeValue`.
   *
   * A QUERY RATHER THAN A SCAN, and that is the whole point (POD-1614). Feed
   * visibility asks this question once per conversation row of a bootstrap, and
   * the caller used to answer it with `loadSessions().find(…)` — a 49-column
   * load of every live session, mapped into objects, per row. On the live corpus
   * (2019 conversation rows x 1115 sessions) that was 18.9 s of synchronous CPU
   * inside one `authority.bootstrap()` call, which blocked the event loop whole.
   *
   * SAME ROW AS THE SCAN IT REPLACES, deliberately: `sessionsWhere` supplies the
   * `created_at ASC, id ASC` order, so taking `[0]` here picks exactly the
   * entry a `.find()` over `loadSessions()` returned when several sessions share
   * a `resumeValue`. `deleted_at IS NULL` is restated for the same reason — it is
   * the filter `loadSessions` applied, not an added condition.
   */
  async findSessionByResumeValue(resumeValue: string): Promise<SessionRow | undefined> {
    const row = (await liveSessionByResumeValue(this.db).all({ resumeValue }))[0]
    return row === undefined ? undefined : mapSession(row)
  }

  /**
   * The same durable-row read as {@link getSession}, asked about MANY ids at
   * once. Tombstones remain included because feed visibility must preserve the
   * delete-audience answer. The 500-row chunks stay below SQLite's variable
   * limit while keeping one repository call for a bootstrap pass.
   */
  async getSessions(sessionIds: readonly string[]): Promise<Map<string, SessionRow>> {
    const out = new Map<string, SessionRow>()
    for (const chunk of chunked(sessionIds)) {
      const size = inListSize(chunk.length)
      const mark = this.writtenColumns.mark
      const rows = await sessionsOfIds(this.db, size).all(inListValues(chunk, size))
      this.writtenColumns.read(
        rows.map((row) => [row.id, indexedColumnsOf(row)] as const),
        mark,
      )
      for (const row of rows.map(mapSession)) {
        out.set(row.id, row)
      }
    }
    return out
  }

  /**
   * The live resume lookup asked about MANY conversation ids at once. The
   * `sessionsWhere` ordering is deliberately retained so the first row per
   * resume value is exactly the row returned by
   * {@link findSessionByResumeValue} when duplicate values exist.
   */
  async findSessionsByResumeValues(
    resumeValues: readonly string[],
  ): Promise<Map<string, SessionRow>> {
    const out = new Map<string, SessionRow>()
    for (const chunk of chunked(resumeValues)) {
      for (const row of await this.liveByResumeValues(chunk)) {
        if (row.resumeValue !== null && !out.has(row.resumeValue)) {
          out.set(row.resumeValue, row)
        }
      }
    }
    return out
  }

  /**
   * EVERY session that names each of these resume values, not just the first.
   *
   * {@link findSessionsByResumeValues} answers "the live session a conversation
   * resumes into" and deliberately keeps whichever row `sessionsWhere` returns
   * first, so that feed visibility keeps the answer it had before POD-1614 made
   * it a query. Cost attribution needs a different thing: when two rows share a
   * resume value — five pairs on this machine — one may carry an `issueId` and
   * the other not, and letting row order decide whether a transcript is
   * attributed at all is not a tie-break, it is a coin toss. So this returns the
   * candidates and lets the caller state its own preference, leaving the
   * visibility answer above untouched.
   */
  async listSessionsByResumeValues(
    resumeValues: readonly string[],
  ): Promise<Map<string, SessionRow[]>> {
    const out = new Map<string, SessionRow[]>()
    for (const chunk of chunked(resumeValues)) {
      for (const row of await this.liveByResumeValues(chunk)) {
        if (row.resumeValue === null) continue
        const list = out.get(row.resumeValue)
        if (list) list.push(row)
        else out.set(row.resumeValue, [row])
      }
    }
    return out
  }

  /** The read the two plural resume readers share, so they cannot drift. */
  private async liveByResumeValues(chunk: readonly string[]): Promise<SessionRow[]> {
    const size = inListSize(chunk.length)
    return (await liveSessionsOfResumeValues(this.db, size).all(inListValues(chunk, size))).map(
      mapSession,
    )
  }

  /**
   * Every live-table session bound to one of these issues (POD-1858).
   *
   * The cost read's denominator: how many sessions a task HAS is what separates
   * "no sessions ever" from "sessions ran and left no transcript", and neither
   * is a zero-dollar figure. Tombstones stay excluded — a deleted session's work
   * is not part of what the task cost today.
   */
  async findSessionsByIssueIds(issueIds: readonly IssueId[]): Promise<SessionRow[]> {
    const out: SessionRow[] = []
    for (const chunk of chunked(issueIds)) {
      const size = inListSize(chunk.length)
      const rows = await liveSessionsOfIssueIds(this.db, size).all(inListValues(chunk, size))
      out.push(...rows.map(mapSession))
    }
    return out
  }

  /**
   * The seat columns of the live sessions on these issues, with these ids, or
   * with these resume values (POD-7431), unordered: one read per 500 keys
   * through `idx_sessions_issue`, the primary key or `idx_sessions_resume_machine`.
   */
  async seatFacts(by: keyof typeof SEAT_FACTS, keys: readonly string[]): Promise<SessionSeatRow[]> {
    const out: SessionSeatRow[] = []
    for (const chunk of chunked([...new Set(keys)])) {
      const size = inListSize(chunk.length)
      for (const r of await SEAT_FACTS[by](this.db, size).all(inListValues(chunk, size))) {
        out.push({
          id: r.id,
          agentKind: r.agentKind,
          issueId: r.issueId ?? null,
          resumeKind: r.resumeKind ?? null,
          resumeValue: r.resumeValue ?? null,
          headless: r.headless === true,
          archived: r.archived === true,
          status: r.status as SessionStatusPersisted,
          refIssueId: r.refIssueId ?? null,
          refLetter: r.refLetter ?? null,
          refDraft: r.refDraft ?? null,
          cwd: r.cwd,
          machineId: r.machineId,
        })
      }
    }
    return out
  }

  /** All session tombstones, for repository-level inspection and maintenance. */
  /**
   * THE CANDIDATES FOR "SESSIONS AT OR BELOW THIS PATH" (POD-6160): every live
   * session whose cwd starts with `root`, by its literal spelling and, for a
   * Windows-style root, by its folded one. A superset: `root-2` starts with
   * `root` too, so the caller keeps only what `isMemberCwd` admits. Two index
   * range reads, never a whole-table read; rows unordered.
   */
  async sessionsUnderPath(root: string): Promise<SessionRow[]> {
    if (!root) return []
    const byId = new Map<string, SessionSelect>()
    for (const row of await liveSessionsInCwdRange(this.db).all({
      lo: root,
      hi: prefixUpperBound(root),
    })) {
      byId.set(row.id, row)
    }
    if (machinePathSeparator(root) === '\\') {
      const folded = root.replace(/\//g, '\\').replace(/[A-Z]/g, (char) => char.toLowerCase())
      for (const row of await liveSessionsInFoldedCwdRange(this.db).all({
        lo: folded,
        hi: prefixUpperBound(folded),
      })) {
        byId.set(row.id, row)
      }
    }
    return [...byId.values()].map(mapSession)
  }

  /** Live sessions whose id starts with `prefix` (a short id), by a range on the
   *  primary key (POD-6160). */
  async sessionsWithIdPrefix(prefix: string): Promise<SessionRow[]> {
    if (!prefix) return []
    return (
      await liveSessionsInIdRange(this.db).all({ lo: prefix, hi: prefixUpperBound(prefix) })
    ).map(mapSession)
  }

  /** Live sessions in one of these statuses, unordered (POD-6160). */
  async sessionsWithStatuses(statuses: readonly SessionStatusPersisted[]): Promise<SessionRow[]> {
    const unique = [...new Set(statuses)]
    if (unique.length === 0) return []
    const size = inListSize(unique.length)
    return (await liveSessionsOfStatuses(this.db, size).all(inListValues(unique, size))).map(
      mapSession,
    )
  }

  /** Live headless sessions, whatever their status (POD-6160: a boot restores
   *  them beside the running ones). */
  async headlessSessions(): Promise<SessionRow[]> {
    return (await liveHeadlessSessions(this.db).all()).map(mapSession)
  }

  /** The issue ids with this sequence number, in any repository (POD-6160). */
  async issueIdsWithSeq(seq: number): Promise<IssueId[]> {
    return (await issueIdsOfSeq(this.db).all({ seq })).map((row) => row.id as IssueId)
  }

  /** Live sessions born on one of these issues with this letter (POD-6160). */
  /** Live sessions whose birth ref names one of these issues (POD-6160 D2g). */
  async sessionsReferencingIssues(issueIds: readonly IssueId[]): Promise<SessionRow[]> {
    const out: SessionRow[] = []
    for (const chunk of chunked(issueIds)) {
      const size = inListSize(chunk.length)
      const rows = await liveSessionsReferencingIssues(this.db, size).all(inListValues(chunk, size))
      out.push(...rows.map(mapSession))
    }
    return out
  }

  async sessionsOfBirthLetter(issueIds: readonly IssueId[], letter: string): Promise<SessionRow[]> {
    const out: SessionRow[] = []
    for (const chunk of chunked(issueIds)) {
      const size = inListSize(chunk.length)
      const rows = await liveSessionsOfBirthLetter(this.db, size).all({
        letter,
        ...inListValues(chunk, size),
      })
      out.push(...rows.map(mapSession))
    }
    return out
  }

  /** Live sessions with this draft ordinal, in any repository (POD-6160). */
  async sessionsOfDraft(draft: number): Promise<SessionRow[]> {
    return (await liveSessionsOfDraft(this.db).all({ draft })).map(mapSession)
  }

  /** Live sessions spawned by one of these `spawned_by` values (POD-6160). */
  async sessionsSpawnedBy(spawnedBy: readonly string[]): Promise<SessionRow[]> {
    const out: SessionRow[] = []
    for (const chunk of chunked([...new Set(spawnedBy)])) {
      const size = inListSize(chunk.length)
      out.push(
        ...(await liveSessionsSpawnedBy(this.db, size).all(inListValues(chunk, size))).map(
          mapSession,
        ),
      )
    }
    return out
  }

  /** A machine's live sessions, unordered (POD-6160). */
  /**
   * A machine's sessions whose desired state is not yet acknowledged
   * (POD-6356): what its daemon's reconnect reconciles. Ids only; the
   * controller reads each row as it reconciles it.
   */
  async lifecyclePending(machineId: MachineId): Promise<SessionId[]> {
    const rows = await lifecyclePendingOnMachine(this.db).all({ machineId })
    return rows.map((row) => row.id as SessionId)
  }

  /** The ids of the live sessions that run on `credentialId`, in id order. */
  async liveSessionIdsOnCredential(credentialId: CredentialId): Promise<SessionId[]> {
    const rows = await liveSessionIdsOnCredential(this.db).all({ credentialId })
    // Ordered here: the few rows of one credential, not a sort in the plan.
    return rows.map((row) => row.id as SessionId).sort()
  }

  async sessionsOnMachine(machineId: MachineId): Promise<SessionRow[]> {
    return (await liveSessionsOnMachine(this.db).all({ machineId })).map(mapSession)
  }

  async loadDeletedSessions(): Promise<SessionRow[]> {
    return (await deletedSessions(this.db).all()).map(mapSession)
  }

  /** Recoverable session tombstones created by one issue deletion. */
  async loadDeletedSessionsForIssue(issueId: IssueId): Promise<SessionRow[]> {
    return (await deletedSessionsForIssue(this.db).all({ issueId })).map(mapSession)
  }

  async upsertSession(_scope: WriteScope, row: SessionRow): Promise<void> {
    await this.writeSessionRows(async () => {
      const values = sessionUpsertValues(row)
      const groups = changedGroups(this.writtenColumns.get(values.id), values)
      try {
        await upsertSessionOfShape(this.db, `${groups}|${shapeOf(values)}`).run(values)
      } catch (error) {
        this.writtenColumns.forget(values.id)
        throw error
      }
      this.writtenColumns.wrote(values.id, indexedColumnsOf(values))
      this.rowsWritten()
    })
  }

  /** A bounded indexed read, once per activity tick, never once per event. */
  async activityPublicationsDue(now: number): Promise<SessionId[]> {
    return (await activityPublicationsDue(this.db).all({ now })).map((row) => row.id)
  }

  /** Publish the latest exact value, atomically with its next eligible time. */
  async publishActivity(_scope: WriteScope, ids: readonly SessionId[], now: number): Promise<void> {
    if (ids.length === 0) return
    for (const chunk of chunked(ids)) {
      const size = inListSize(chunk.length)
      await publishSessionActivity(this.db, size).run({
        ...inListValues(chunk, size),
        now,
        next: now + SESSION_LAST_ACTIVE_PUBLISH_INTERVAL_MS,
      })
    }
    this.rowsWritten()
  }

  /** The indexed columns each session row holds as this store last wrote or
   *  read them [POD-6234], so an upsert sets only those that changed. */
  private readonly writtenColumns: WrittenColumns<IndexedColumns>

  /**
   * Whether a many-row upsert pads its batch to an `inListSize` by repeating its
   * last row. SQLite applies the repeat as a second, identical update; Postgres
   * refuses an `ON CONFLICT DO UPDATE` that reaches one row twice, so there the
   * statement carries exactly the batch's rows (one statement still, of a size
   * the batch has).
   */
  private readonly padsUpsertRows: boolean

  /**
   * {@link upsertSession} for many rows in one statement per 256 rows of one
   * key shape [POD-6175], for the activity flush that persists every busy
   * session on one tick. Every row is checked before the first is written.
   * Rows are written in the order given; pass each session once.
   */
  async upsertSessions(_scope: WriteScope, rows: readonly SessionRow[]): Promise<void> {
    if (rows.length === 0) return
    const now = Date.now()
    const byShape = new Map<string, ReturnType<typeof sessionUpsertValues>[]>()
    for (const row of rows) {
      const values = sessionUpsertValues(row, now)
      const shape = shapeOf(values)
      const group = byShape.get(shape)
      if (group) group.push(values)
      else byShape.set(shape, [values])
    }
    await this.writeSessionRows(async () => {
      for (const [shape, group] of byShape) {
        const keys = shape === '' ? [] : shape.split(',')
        for (let start = 0; start < group.length; start += UPSERT_ROWS_PER_STATEMENT) {
          const chunk = group.slice(start, start + UPSERT_ROWS_PER_STATEMENT)
          const size = this.padsUpsertRows ? inListSize(chunk.length) : chunk.length
          let changed = 0
          for (const values of chunk)
            changed |= changedGroups(this.writtenColumns.get(values.id), values)
          const params: Record<string, unknown> = {}
          for (let index = 0; index < size; index++) {
            const values = chunk[Math.min(index, chunk.length - 1)] as Record<string, unknown>
            for (const key of keys) params[rowParam(index, key)] = values[key]
          }
          try {
            await upsertSessionsOfShape(this.db, `${size}|${manyRowGroups(changed)}|${shape}`).run(
              params,
            )
          } catch (error) {
            for (const values of chunk) this.writtenColumns.forget(values.id)
            throw error
          }
          for (const values of chunk) this.writtenColumns.wrote(values.id, indexedColumnsOf(values))
        }
      }
      this.rowsWritten()
    })
  }

  /** Tombstone sessions without destroying their metadata or UI satellites.
   *
   *  A tombstone KILLS a running process, and it records that exit in the same
   *  write (POD-4634). Nothing else can: the session leaves the live map at the
   *  commit, so the daemon's `agentExit` finds no session to stamp, and the row
   *  kept `status='live'` with no stop reason for as long as it existed. Only a
   *  RUNNING row changes; a hibernated or exited one already says how it stopped. */
  async softDeleteSessions(
    _scope: WriteScope,
    ids: string[],
    deletedAt: string,
    source: SessionDeletionSource,
    deletedByIssueId: IssueId | null = null,
  ): Promise<void> {
    await this.writeSessionRows(async () => {
      await this.writtenColumns.aside(ids, async () => {
        for (const id of ids) {
          await stopRunningForTombstone(this.db).run({ id, deletedAt })
          await tombstoneSession(this.db).run({ id, deletedAt, source, deletedByIssueId })
        }
      })
      this.rowsWritten()
    })
  }

  /** Mark sessions as deleted by an issue so restoring that issue can recover them. */
  async softDeleteForIssue(
    _scope: WriteScope,
    ids: string[],
    issueId: IssueId,
    deletedAt: string,
  ): Promise<void> {
    await this.softDeleteSessions(_scope, ids, deletedAt, 'issue', issueId)
  }

  /** Re-expose an issue's tombstoned sessions as honestly exited runtime records. */
  async restoreDeletedForIssue(_scope: WriteScope, issueId: IssueId): Promise<void> {
    await this.writtenColumns.aside('all', () => restoreSessionsOfIssue(this.db).run({ issueId }))
    this.rowsWritten()
  }

  /**
   * Clear a TOMBSTONED session's pointers at an issue that is being hard-purged
   * (POD-1926).
   *
   * `purgeEmptyDraft` really does `DELETE FROM issues`, and `sessions.issue_id`
   * carries no foreign key — only `parent_id`, `superseded_by` and `duplicate_of`
   * have `ON DELETE SET NULL` — so nothing at the SQL layer stops a session row
   * outliving the issue it names. The reaper detaches the sessions it can SEE
   * before deleting, but it sees them through `loadSessions()`, which is
   * `deleted_at IS NULL`: a soft-deleted session is invisible to it and kept its
   * `issue_id` forever. One such row (deleted nine seconds after it was spawned,
   * `status` still `live`) is how POD-1926 was found.
   *
   * Deliberately scoped to `deleted_at IS NOT NULL`. Live rows are already
   * detached by the reaper through `setSessionIssueId`, which persists AND
   * refreshes the in-memory `Session`; a raw UPDATE behind that map's back would
   * desync it. Tombstones are not in the map at all, so SQL is the whole truth
   * for them.
   *
   * `ref_issue_id`/`ref_letter` go with it: the pair is sticky on upsert
   * (`COALESCE(sessions.ref_issue_id, excluded.ref_issue_id)`) so a dead ref would
   * never be reallocated, and `prepareRefAllocation` returns early whenever
   * `refIssueId` is set — leaving the session permanently unable to earn the draft
   * ref it should now get.
   */
  async detachTombstonesFromIssue(_scope: WriteScope, issueId: IssueId): Promise<void> {
    await this.writtenColumns.aside('all', () => detachTombstones(this.db).run({ issueId }))
    this.rowsWritten()
  }

  /**
   * Per-boot heal for references left behind by a purge that predates
   * {@link detachTombstonesFromIssue} (POD-1926). Idempotent, and unscoped by
   * `deleted_at` on purpose: it runs from the store facade's constructor, ahead
   * of every reader in the process, so no in-memory `Session` exists yet to
   * desync. Returns the number of rows healed.
   */
  /**
   * The boot heal (`store.ts`): runs as the store opens, before the Ledger is
   * composed, so it has no write scope to take; the boot reconcile that follows
   * reports what it changed (POD-6601).
   */
  async detachDanglingIssueReferences(): Promise<number> {
    const result = await this.writtenColumns.aside('all', () =>
      detachDanglingReferences(this.db).run(),
    )
    this.rowsWritten()
    return Number(result.changes)
  }

  /** Irreversibly remove a session and its satellites. Internal maintenance only. */
  async purgeSession(_scope: WriteScope, id: SessionId): Promise<void> {
    await this.writeSessionRows(async () => {
      await deleteCheckpointsOfSession(this.db).run({ id })
      await this.purgeObservationCheckpoint(id)
      await this.writtenColumns.aside([id], () => deleteSessionRow(this.db).run({ id }))
      this.rowsWritten()
      await deletePanelPinsOf(this.db).run({ id })
      await deleteDraftOf(this.db).run({ id })
      await deleteSnoozesOf(this.db).run({ id })
      await deleteUserStateOf(this.db).run({ id })
      await deleteOfferOf(this.db).run({ id })
      await this.scrubTabOrders(id)
    })
  }

  // ---- pins (PER-USER STATE, POD-380) ----
  //
  // Keyed (user_id, kind, id). `userId` is REQUIRED and leading on every method
  // here rather than optional-with-a-default: a defaulted user id is how one
  // person ends up reading another's rows, and the point of the re-key is that the
  // caller must say whose state it is touching. Server-internal paths that have no
  // principal pass SOLE_USER_ID explicitly, which makes them greppable for
  // POD-1077 (the scoped feed that finally makes the broadcast per-principal).
  /** One pin's `pinnedAt`, or undefined when the thing is not pinned. */
  async pinnedAt(userId: UserId, kind: PinKind, id: string): Promise<string | undefined> {
    return (await pinOf(this.db).get({ userId, kind, id }))?.pinnedAt
  }

  /**
   * Pin one thing for one person; pinning what is pinned keeps the first pin.
   * Answers the stored row, for the `pin` change it publishes (POD-6673), and
   * whether this call made it (an issue pin's event, POD-6692).
   */
  async addPin(
    userId: UserId,
    kind: PinKind,
    id: string,
    at: string,
  ): Promise<{ pin: PinWire; created: boolean }> {
    if (!PIN_KINDS.has(kind)) throw new Error(`invalid pin kind: ${kind}`)
    requireUserId(userId)
    if (!id.trim()) throw new Error('pin id is empty')
    // `onConflictDoNothing` is `INSERT OR IGNORE` here: the four columns are
    // NOT NULL and each is refused above when blank; the table has no CHECK
    // (POD-3403, spec rule 31).
    const inserted = await insertPin(this.db).run({ userId, kind, id, pinnedAt: at })
    const pinnedAt = (await this.pinnedAt(userId, kind, id)) ?? at
    return { pin: { userId, kind, entityId: id, pinnedAt }, created: Number(inserted.changes) > 0 }
  }

  /** Remove every person's pin of one thing; answers whose pins went, for the
   *  `pin` removes the caller publishes. */
  async removePinsOf(kind: PinKind, id: string): Promise<UserId[]> {
    const rows = await deletePinsOfTarget(this.db).all({ kind, id })
    return rows.map((row) => row.userId)
  }

  /** Whose pins {@link removePinsOf} would remove: the `pin` records a purge
   *  of the thing may affect, named before it runs (POD-6769). */
  async pinnersOf(kind: PinKind, id: string): Promise<UserId[]> {
    return (await pinnersOfTarget(this.db).all({ kind, id })).map((row) => row.userId)
  }

  /** Unpin it. Answers whether there was a pin to remove. */
  async removePin(userId: UserId, kind: PinKind, id: string): Promise<boolean> {
    const result = await deletePin(this.db).run({ userId, kind, id })
    return Number(result.changes) > 0
  }

  /** Every person's pins, as the `pin` kind's boot reconcile publishes them. */
  async allPinsForBootReconcile(): Promise<PinWire[]> {
    const rows = await allPins(this.db).all()
    return rows.flatMap((row) =>
      PIN_KINDS.has(row.kind as PinKind)
        ? [
            {
              userId: row.userId,
              kind: row.kind as PinKind,
              entityId: row.id,
              pinnedAt: row.pinnedAt,
            },
          ]
        : [],
    )
  }

  /** {@link allPinsForBootReconcile} for some people only (POD-6763). */
  async pinsOfUsers(userIds: readonly UserId[]): Promise<PinWire[]> {
    const out: PinWire[] = []
    for (const chunk of chunked([...new Set(userIds)])) {
      const size = inListSize(chunk.length)
      for (const row of await pinsOfUsers(this.db, size).all(inListValues(chunk, size, 'users'))) {
        if (PIN_KINDS.has(row.kind as PinKind))
          out.push({
            userId: row.userId,
            kind: row.kind as PinKind,
            entityId: row.id,
            pinnedAt: row.pinnedAt,
          })
      }
    }
    return out
  }

  /** {@link allTabOrdersForBootReconcile} for some people only (POD-6763). */
  async tabOrdersOfUsers(userIds: readonly UserId[]): Promise<TabOrderWire[]> {
    const out: TabOrderWire[] = []
    for (const chunk of chunked([...new Set(userIds)])) {
      const size = inListSize(chunk.length)
      for (const row of await tabOrdersOfUsers(this.db, size).all(
        inListValues(chunk, size, 'users'),
      )) {
        const sessionIds = parseTabIds(row.ids)
        if (sessionIds !== undefined && sessionIds.length > 0)
          out.push({ userId: row.userId, entityId: row.worktree, sessionIds })
      }
    }
    return out
  }

  // ---- per-user session read state (POD-1076) ----
  /**
   * One user's read markers, `sessionId → readAt`. PER-USER STATE keyed
   * `(user_id, session_id)`: `sessions.read_at` was one column for the whole
   * instance until POD-1076, which asserted that exactly one person exists.
   *
   * Returns only sessions this user has opened. An absent key is "never opened",
   * which is the ONLY spelling — see {@link markSessionUnread}.
   */
  /** Capture the two source tables without lazy housekeeping. Sparse source rows
   * still emit an explicit cleared value after a mutation, rather than a remove. */
  async listSessionUserStateRows(
    sessionId?: SessionId,
    now: number = Date.now(),
  ): Promise<SessionUserStateWire[]> {
    const reads =
      sessionId === undefined
        ? await allUserStateRows(this.db).all()
        : await userStateRowsOfSession(this.db).all({ sessionId })
    const snoozes =
      sessionId === undefined
        ? await allSnoozeRows(this.db).all()
        : await snoozeRowsOfSession(this.db).all({ sessionId })
    const byUser = new Map<UserId, Map<SessionId, SessionUserStateWire>>()
    const rowFor = (userId: UserId, id: SessionId): SessionUserStateWire => {
      const userRows = byUser.get(userId) ?? new Map<SessionId, SessionUserStateWire>()
      byUser.set(userId, userRows)
      let row = userRows.get(id)
      if (!row) {
        row = { userId, sessionId: id, readAt: null }
        userRows.set(id, row)
      }
      return row
    }
    for (const r of reads) rowFor(r.userId, r.sessionId).readAt = r.readAt
    for (const r of snoozes) {
      const row = rowFor(r.userId, r.sessionId)
      if (r.snoozedUntil === null || Date.parse(r.snoozedUntil) > now)
        row.snoozedUntil = r.snoozedUntil
    }
    return [...byUser.values()].flatMap((rows) => [...rows.values()])
  }

  async sessionUserStateFor(
    userId: UserId,
    sessionId: SessionId,
    now: number = Date.now(),
  ): Promise<SessionUserStateWire> {
    const readAt = await this.getReadAt(userId, sessionId)
    const snooze = await userSessionSnooze(this.db).get({ userId, sessionId })
    return {
      userId,
      sessionId,
      readAt,
      ...(snooze && (snooze.until === null || Date.parse(snooze.until) > now)
        ? { snoozedUntil: snooze.until }
        : {}),
    }
  }

  async listReadAt(userId: UserId): Promise<Record<string, string | null>> {
    requireUserId(userId)
    const rows = await readAtOfUser(this.db).all({ userId })
    const out: Record<string, string | null> = {}
    for (const r of rows) out[r.sessionId] = r.readAt
    return out
  }

  /**
   * ONE USER'S OVERLAY OF A SET OF SESSIONS (POD-6160): the read marker and
   * the snooze of each, two indexed statements per 500 ids. A snooze that has
   * expired reads as absent, as `listSnoozes` reads it; deleting it is left to
   * that listing, so this read never writes.
   */
  async userStateOf(
    userId: UserId,
    sessionIds: readonly SessionId[],
    now: number = Date.now(),
  ): Promise<Map<SessionId, { readAt: string | null; snoozedUntil?: string | null }>> {
    requireUserId(userId)
    const out = new Map<SessionId, { readAt: string | null; snoozedUntil?: string | null }>()
    const unique = [...new Set(sessionIds)]
    for (const id of unique) out.set(id, { readAt: null })
    for (const chunk of chunked(unique)) {
      const size = inListSize(chunk.length)
      const values = { userId, ...inListValues(chunk, size) }
      for (const r of await readAtOfUserSessions(this.db, size).all(values)) {
        const entry = out.get(r.sessionId as SessionId)
        if (entry) entry.readAt = r.readAt
      }
      for (const r of await snoozesOfUserSessions(this.db, size).all(values)) {
        if (r.snoozedUntil !== null && Date.parse(r.snoozedUntil) <= now) continue
        const entry = out.get(r.sessionId as SessionId)
        if (entry) entry.snoozedUntil = r.snoozedUntil
      }
    }
    return out
  }

  async getReadAt(userId: UserId, sessionId: SessionId): Promise<string | null> {
    requireUserId(userId)
    const row = await readAtOfUserSession(this.db).get({
      userId,
      sessionId: asSessionId(sessionId.trim()),
    })
    return row?.readAt ?? null
  }

  async markSessionRead(
    _scope: WriteScope,
    userId: UserId,
    sessionId: SessionId,
    readAt: string,
  ): Promise<void> {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('read-state session id is empty')
    await upsertReadAt(this.db).run({ userId, sessionId: asSessionId(id), readAt })
  }

  /** DELETES the row rather than writing a null. Absence and `read_at IS NULL`
   *  would be two spellings of "never opened", and a table with two spellings of
   *  one fact acquires a second meaning nobody documented. */
  async markSessionUnread(_scope: WriteScope, userId: UserId, sessionId: SessionId): Promise<void> {
    requireUserId(userId)
    await deleteReadAt(this.db).run({ userId, sessionId: asSessionId(sessionId.trim()) })
  }

  /**
   * Delete EVERY user's read marker for a session — "re-arm unread for all
   * readers", the terminal-transition rule (POD-1076).
   *
   * Takes no `userId` on purpose, and that is the one place in this family where
   * a write legitimately crosses owners: the session became something new, which
   * is true for everybody. It is not a widening — it removes rows, so no reader
   * ever sees another reader's state.
   */
  async clearAllReadAt(_scope: WriteScope, sessionId: SessionId): Promise<UserId[]> {
    const cleared = await deleteAllReadAtOf(this.db).all({
      sessionId: asSessionId(sessionId.trim()),
    })
    return cleared.map((row) => row.userId)
  }

  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time.
   *  The delete runs as a change-log commit when the hook is installed
   *  (POD-6920): a read outside one may not change a synced row. */
  async listSnoozes(userId: UserId, now: number = Date.now()): Promise<SnoozeMap> {
    const rows = await snoozesOfUser(this.db).all({ userId })
    const out: SnoozeMap = {}
    const expired: SessionId[] = []
    for (const r of rows) {
      if (r.snoozedUntil !== null && Date.parse(r.snoozedUntil) <= now) {
        expired.push(r.sessionId)
        continue
      }
      out[r.sessionId] = r.snoozedUntil
    }
    // The lazy delete stays scoped to the reader: housekeeping on read must never
    // drop somebody else's row, even an expired one.
    if (expired.length > 0) {
      await throughChangeLog(this.snoozeLapseCommit, async () => {
        for (const id of expired) {
          await deleteUserSnooze(this.db).run({ userId, sessionId: id })
        }
      })
    }
    return out
  }

  /** The composition root's change-log commit for {@link listSnoozes}' lazy delete. */
  setSnoozeLapseCommit(commit: ChangeLogCommit): void {
    this.snoozeLapseCommit = commit
  }

  /** Snooze a session for one user. `until` = null → until next message; ISO
   *  string → timed. PER-USER STATE (POD-380) — see the note on {@link listPins}. */
  async setSnooze(
    _scope: WriteScope,
    userId: UserId,
    sessionId: SessionId,
    until: string | null,
  ): Promise<void> {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('snooze session id is empty')
    await upsertSnooze(this.db).run({
      userId,
      sessionId: asSessionId(id),
      snoozedUntil: until,
      createdAt: new Date().toISOString(),
    })
  }

  /** Un-snooze a session for one user (no-op if not snoozed). */
  async clearSnooze(_scope: WriteScope, userId: UserId, sessionId: SessionId): Promise<void> {
    await deleteUserSnooze(this.db).run({ userId, sessionId: asSessionId(sessionId.trim()) })
  }

  async hasAnySnooze(sessionId: SessionId): Promise<boolean> {
    return (
      (await anySnoozeOf(this.db).get({ sessionId: asSessionId(sessionId.trim()) })) !== undefined
    )
  }

  /** Clear every viewer's independent snooze after a shared session event. */
  async clearAllSnoozes(_scope: WriteScope, sessionId: SessionId): Promise<UserId[]> {
    const cleared = await deleteAllSnoozesOf(this.db).all({
      sessionId: asSessionId(sessionId.trim()),
    })
    return cleared.map((row) => row.userId)
  }

  // ---- agent action offers ----
  /** Every live offer, keyed by session — replayed onto SessionMeta at boot. A
   *  row with corrupt JSON actions is dropped rather than failing the load. */
  async listOffers(): Promise<OfferMap> {
    const out: OfferMap = {}
    for (const r of await allOffers(this.db).all()) {
      const offer = offerOfRow(r)
      if (offer) out[r.sessionId] = offer
    }
    return out
  }

  /** {@link listOffers} for a known set of sessions (POD-6160): the offers a
   *  set of durable session records carries, one statement per 500 ids. */
  async offersOf(sessionIds: readonly SessionId[]): Promise<OfferMap> {
    const out: OfferMap = {}
    for (const chunk of chunked(sessionIds)) {
      const size = inListSize(chunk.length)
      for (const r of await offersOfIds(this.db, size).all(inListValues(chunk, size))) {
        const offer = offerOfRow(r)
        if (offer) out[r.sessionId] = offer
      }
    }
    return out
  }

  /** Set (replace) the live offer for a session. */
  async setOffer(_scope: WriteScope, sessionId: SessionId, offer: OfferRecord): Promise<void> {
    const id = sessionId.trim()
    if (!id) throw new Error('offer session id is empty')
    const values = {
      sessionId: asSessionId(id),
      message: offer.message,
      actions: JSON.stringify(offer.actions),
      artifacts:
        offer.artifacts && offer.artifacts.length > 0 ? JSON.stringify(offer.artifacts) : null,
      createdAt: offer.createdAt,
    }
    await upsertOffer(this.db).run(values)
  }

  /** The stamp of one session's live offer, or undefined when it has none. The
   *  guard a dismissal checks itself against — one row, not the whole table,
   *  because `listOffers` exists to rebuild every session at boot. */
  async offerCreatedAt(sessionId: SessionId): Promise<string | undefined> {
    const row = await offerCreatedAtOf(this.db).get({ sessionId: asSessionId(sessionId.trim()) })
    return row?.createdAt
  }

  /** Remove a session's offer (no-op if none). */
  async clearOffer(_scope: WriteScope, sessionId: SessionId): Promise<void> {
    await deleteOfferOf(this.db).run({ id: asSessionId(sessionId.trim()) })
  }

  // ---- tab order ----
  /** One worktree's manual order, or undefined when it was never reordered. */
  async tabOrder(userId: UserId, worktree: string): Promise<string[] | undefined> {
    const row = await tabOrderOf(this.db).get({ userId, worktree })
    return row === undefined ? undefined : parseTabIds(row.ids)
  }

  /** Every person's tab orders, as the `tabOrder` kind's boot reconcile
   *  publishes them. */
  async allTabOrdersForBootReconcile(): Promise<TabOrderWire[]> {
    // Three columns, named: see `allTabOrders`.
    const rows = await allTabOrders(this.db).all()
    return rows.flatMap((row) => {
      const sessionIds = parseTabIds(row.ids)
      return sessionIds === undefined || sessionIds.length === 0
        ? []
        : [{ userId: row.userId, entityId: row.worktree, sessionIds }]
    })
  }

  async setTabOrder(userId: UserId, worktree: string, sessionIds: string[]): Promise<void> {
    requireUserId(userId)
    const cleanWorktree = worktree.trim()
    if (!cleanWorktree) throw new Error('worktree path is empty')
    if (sessionIds.length === 0) {
      await deleteTabOrder(this.db).run({ userId, worktree: cleanWorktree })
      return
    }
    const ids = JSON.stringify(sessionIds)
    const updatedAt = new Date().toISOString()
    await upsertTabOrder(this.db).run({ userId, worktree: cleanWorktree, ids, updatedAt })
  }

  /**
   * Drop a session id from EVERY user's saved tab order during irreversible
   * purge. Deliberately cross-user: a purge destroys the session itself, so
   * leaving a dangling id in somebody else's saved order would outlive the thing
   * it names. This is §3.1.6 S5's system-writer rule — a system job may act
   * across owners, and it lands in the scope of what it acted on.
   */
  private async scrubTabOrders(sessionId: SessionId): Promise<void> {
    // Three columns, named: see `allTabOrders`.
    const rows = await allTabOrders(this.db).all()
    for (const row of rows) {
      const ids = parseTabIds(row.ids)
      if (ids === undefined || !ids.includes(sessionId)) continue
      await this.setTabOrder(
        row.userId,
        row.worktree,
        ids.filter((id) => id !== sessionId),
      )
    }
  }

  // ---- composer drafts ----
  // The per-session in-progress chat-composer / native-prompt text (issue #34:
  // "input into a text field... should be stored while typing so it's never
  // lost"). Kept in its OWN table, not a column on `sessions`: a draft changes on
  // every keystroke, while a SessionRow is rewritten on every meta change — sharing
  // a row would make either write clobber the other. The registry debounces the
  // writes here (see relay.ts) so SQLite isn't hit per keystroke.
  async loadDrafts(): Promise<Record<SessionId, string>> {
    const rows = await draftTexts(this.db).all()
    const out: Record<string, string> = {}
    for (const r of rows) out[r.sessionId] = r.text
    return out
  }

  /** Draft last-edit times by session — the companion to {@link loadDrafts}, used
   *  to seed `Session.draftUpdatedAt` at boot so a draft lifts its session in the
   *  attention ordering after a restart. */
  async loadDraftTimes(): Promise<Record<string, string>> {
    const rows = await draftTimes(this.db).all()
    const out: Record<string, string> = {}
    for (const r of rows) out[r.sessionId] = r.updatedAt
    return out
  }

  /** {@link loadDraftTimes} for a known set of sessions (POD-6160). */
  async draftTimesOf(sessionIds: readonly SessionId[]): Promise<Map<SessionId, string>> {
    const out = new Map<SessionId, string>()
    for (const chunk of chunked(sessionIds)) {
      const size = inListSize(chunk.length)
      for (const r of await draftTimesOfIds(this.db, size).all(inListValues(chunk, size))) {
        out.set(r.sessionId as SessionId, r.updatedAt)
      }
    }
    return out
  }

  /** Set (non-empty) or clear (empty/whitespace-only persists as a deleted row) a
   *  session's draft. Returns the new updated_at when set, or undefined when cleared
   *  — the registry mirrors it onto `Session.draftUpdatedAt`. */
  async setDraft(sessionId: SessionId, text: string): Promise<string | undefined> {
    const id = sessionId.trim()
    if (!id) return undefined
    if (text) {
      const updatedAt = new Date().toISOString()
      await upsertDraftText(this.db).run({ sessionId: asSessionId(id), text, updatedAt })
      return updatedAt
    }
    await deleteDraftOf(this.db).run({ id: asSessionId(id) })
    return undefined
  }

  // ---- versioned drafts (POD-859, Draft Sync v2) ----
  // The same `session_drafts` row, read/written with its versioning columns
  // (`rev`, `origin`, `history`). Used only by the flag-on versioned path; the
  // legacy `loadDrafts`/`setDraft` above stay byte-for-byte for the flag-off path.
  // `updatedAt` doubles as the doc's `editedAt`.
  //
  // THESE COLUMNS ARE ASSUMED PRESENT, and until POD-3246 they were not: a
  // `PRAGMA table_info` probe degraded to the legacy shape if `rev` was missing,
  // guarding `loadDraftDocs()` (which runs at boot regardless of the flag)
  // against a `no such column` crash-loop on a DB whose migration had not
  // applied. There is no such DB. `SessionStore` runs the whole migration chain
  // on this connection before it constructs a repository, drizzle applies by
  // NAME so `20260718093018_session-drafts-versioned` cannot be skipped, and a
  // database that claims it applied while lacking the columns is corruption —
  // which is worth a loud failure, not a silent fallback to a shape that drops
  // every rev and history on write.

  /** All persisted draft docs, keyed by session. A row written before the
   *  versioning columns existed reads back with `rev: 0`, `origin: null`, and an
   *  empty history. */
  async loadDraftDocs(): Promise<Record<SessionId, StoredDraftDoc>> {
    const rows = await allDraftRows(this.db).all()
    const out: Record<string, StoredDraftDoc> = {}
    for (const r of rows) out[r.sessionId] = storedDraftDoc(r)
    return out
  }

  /** One session's draft document, or undefined when it has none (POD-6160). */
  async draftDocOf(sessionId: SessionId): Promise<StoredDraftDoc | undefined> {
    const row = (await draftRowOf(this.db).all({ sessionId }))[0]
    return row ? storedDraftDoc(row) : undefined
  }

  /** Upsert (non-empty) or delete (empty text) a versioned draft doc. Empty text
   *  removes the row just like {@link setDraft}, so a cleared draft never lingers. */
  async setDraftDoc(sessionId: SessionId, doc: StoredDraftDoc): Promise<void> {
    // `.trim()` returns a plain `string` — a normalizing method STRIPS the brand.
    // Re-applied because trimming an id yields the same id, not a different one.
    const id = asSessionId(sessionId.trim())
    if (!id) return
    if (!doc.text) {
      await deleteDraftOf(this.db).run({ id })
      return
    }
    const values = {
      sessionId: id,
      text: doc.text,
      updatedAt: doc.updatedAt,
      rev: doc.rev,
      origin: doc.origin,
      history: JSON.stringify(doc.history),
    }
    await upsertDraftDoc(this.db).run(values)
  }
}

/** The 500-row chunks every batched id reader here shares. They stay below
 *  SQLite's variable limit while keeping one repository call per pass. */
function storedDraftDoc(r: typeof sessionDrafts.$inferSelect): StoredDraftDoc {
  return {
    text: r.text,
    updatedAt: r.updatedAt,
    rev: r.rev ?? 0,
    origin: r.origin ?? null,
    history: parseHistory(r.history ?? null),
  }
}

/** One stored offer, or undefined for a row with corrupt JSON actions, which is
 *  dropped rather than failing the read. */
function offerOfRow(r: typeof offersTable.$inferSelect): OfferMap[string] | undefined {
  try {
    const actions = JSON.parse(r.actions)
    if (!Array.isArray(actions)) return undefined
    // A corrupt artifacts column degrades to "no artifacts", not "no offer".
    let artifacts: string[] | undefined
    if (r.artifacts != null) {
      try {
        const parsed = JSON.parse(r.artifacts)
        if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
          artifacts = parsed
        }
      } catch {}
    }
    return {
      message: r.message,
      actions,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
      createdAt: r.createdAt,
    }
  } catch {
    return undefined
  }
}

function* chunked<T>(values: readonly T[]): Generator<T[]> {
  const unique = [...new Set(values)]
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) {
    yield unique.slice(i, i + CHUNK)
  }
}

/**
 * The lifecycle columns as stored (POD-6356). An unknown `desired` value (a
 * newer build's) reads as no intent rather than as one this build would act on.
 */
function lifecycleOfRow(r: SessionSelect): SessionLifecycleRow | undefined {
  const desired = SessionDesired.safeParse(r.desired)
  const lifecycle: SessionLifecycleRow = {
    desired: desired.success ? desired.data : null,
    force: r.desiredForce === true,
    revision: r.revision,
    observedRevision: r.observedRevision,
    failure: decodeLifecycleFailure(r.lifecycleFailure),
    byUser: r.desiredByUser ?? null,
    byAgent: r.desiredByAgent ?? null,
  }
  // ABSENT when nothing was ever recorded, so a row from before the columns
  // (and every session nobody has edited) decodes exactly as it did.
  const recorded =
    lifecycle.desired !== null ||
    lifecycle.force ||
    lifecycle.revision !== NO_LIFECYCLE.revision ||
    lifecycle.observedRevision !== NO_LIFECYCLE.observedRevision ||
    lifecycle.failure !== null ||
    lifecycle.byUser !== null
  return recorded ? lifecycle : undefined
}

const optionalLifecycle = (lifecycle: SessionLifecycleRow | undefined) =>
  lifecycle === undefined ? {} : { lifecycle }

/** The failure column is plain text: a corrupt blob reads as no failure. */
function encodeLifecycleFailure(failure: SessionLifecycleRow['failure']): string | null {
  return failure === null ? null : JSON.stringify(failure)
}

function decodeLifecycleFailure(raw: string | null): SessionLifecycleRow['failure'] {
  if (raw == null) return null
  try {
    const parsed = SessionLifecycleFailure.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const driverCapabilities = SessionMeta.pick({ configureFields: true, attachKinds: true })

/** A corrupt capability report is unknown, never an invented empty answer. */
/** The JSON a column holds, or undefined when there is none or it does not parse. */
function parsedJson(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** What the harness last reported; absent when nothing parses as one. */
function decodeEffectiveAuth(raw: string | null): { effectiveAuth?: EffectiveAuth } {
  const parsed = EffectiveAuth.safeParse(parsedJson(raw))
  return parsed.success ? { effectiveAuth: parsed.data } : {}
}

/** The open mismatch; absent when nothing parses as one. */
function decodeCredentialMismatch(raw: string | null): {
  credentialMismatch?: CredentialMismatch
} {
  const parsed = CredentialMismatch.safeParse(parsedJson(raw))
  return parsed.success ? { credentialMismatch: parsed.data } : {}
}

function decodeDriverCapabilities(raw: string | null): SessionDriverCapabilities | null {
  if (raw === null) return null
  try {
    const parsed = driverCapabilities.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * SERIALIZATION EDGE — the one place a `sessions` row becomes a `SessionRow`.
 *
 * WHAT IS LEFT HERE IS DECISIONS. The brand casts and the `?? null` decodes are
 * gone: the schema carries `$type<>()` on the id columns and drizzle's own
 * execution path maps physical names back, so those lines existed only because
 * the driver returned `unknown` (spec §6 rule 6). Every line that remains is a
 * refusal, a whitelist, or a spelling choice, and each says which.
 */
function mapSession(r: SessionSelect): SessionRow {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    agentKind: r.agentKind,
    ...(r.model != null ? { model: r.model } : {}),
    ...(r.effort != null ? { effort: r.effort } : {}),
    // ABSENT, NOT NULL, when nobody has changed it — the same spelling as the
    // launch pair above. `requestedModel: null` and an absent key read the
    // same at every consumer here, but the absent form keeps "never
    // configured" from looking like a recorded decision to clear it.
    ...(r.requestedModel != null ? { requestedModel: r.requestedModel } : {}),
    ...(r.requestedEffort != null ? { requestedEffort: r.requestedEffort } : {}),
    ...(r.accountId != null ? { accountId: r.accountId } : {}),
    ...(r.credentialId != null ? { credentialId: r.credentialId } : {}),
    // A value that does not parse reads as "not reported" rather than as a
    // claim about which login a session ran on.
    ...decodeEffectiveAuth(r.effectiveAuth),
    ...decodeCredentialMismatch(r.credentialMismatch),
    ...(r.loginHarness != null
      ? { loginHarness: AgentKind.exclude(['shell']).parse(r.loginHarness) }
      : {}),
    cwd: r.cwd,
    title: r.title,
    name: r.name ?? null,
    // Anything else on disk (an old/rogue value) reads as "nobody named it" rather
    // than as a source that could out-rank the user (#490).
    nameSource: r.nameSource === 'user' || r.nameSource === 'agent' ? r.nameSource : null,
    originKind: r.originKind as 'spawn' | 'resume',
    conversationId: r.conversationId ?? null,
    resumeKind: r.resumeKind ?? null,
    resumeValue: r.resumeValue ?? null,
    selectedDriverId: r.selectedDriverId ?? null,
    requestedDriverId: r.requestedDriverId ?? null,
    boundDriverId: r.boundDriverId ?? null,
    boundDriverCapabilities: decodeDriverCapabilities(r.boundDriverCapabilities),
    agentState: parseAgentState(r.agentStateJson),
    agentColor: r.agentColor ?? null,
    observedModel: r.observedModel ?? null,
    observedEffort: r.observedEffort ?? null,
    observedMode: r.observedMode ?? null,
    launchPosture: parseLaunchPosture(r.launchPostureJson),
    handoffTargetMachineId: r.handoffTargetMachineId ?? null,
    // Anything else on disk (an old/rogue value) reads as "no claim recorded"
    // rather than as proof — the same conservative decode as `name_source`,
    // and here it is the safety property itself: only a literal 'never'
    // authorizes discarding a launch and starting it again.
    conversationBinding:
      r.conversationBinding === 'never' || r.conversationBinding === 'bound'
        ? r.conversationBinding
        : null,
    status: r.status as SessionStatusPersisted,
    exitCode: r.exitCode ?? null,
    spawnFailure: r.spawnFailure ?? null,
    durableLabel: r.durableLabel,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    publishedLastActiveAt: r.publishedLastActiveAt,
    geometry: {
      cols: Number.isInteger(r.terminalCols) && r.terminalCols > 0 ? r.terminalCols : 80,
      rows: Number.isInteger(r.terminalRows) && r.terminalRows > 0 ? r.terminalRows : 24,
    },
    ...(r.workingMsTotal != null ? { workingMsTotal: r.workingMsTotal } : {}),
    ...(r.inputCount > 0 ? { inputCount: r.inputCount } : {}),
    ...(r.outputCount > 0 ? { outputCount: r.outputCount } : {}),
    ...(r.activityCount > 0 ? { activityCount: r.activityCount } : {}),
    archived: r.archived,
    ...(r.concertmaster ? { concertmaster: true } : {}),
    workState: r.workState ?? null,
    machineId: r.machineId,
    lastOutputAt: r.lastOutputAt ?? null,
    lastInputAt: r.lastInputAt ?? null,
    lastResumedAt: r.lastResumedAt ?? null,
    spawnedBy: r.spawnedBy ?? null,
    // THE ATTRIBUTION PAIR (POD-1516). BOTH id columns must be present for a
    // pair to exist — a kind with no id is a half-written row, and decoding it
    // would mint an actor with an empty id that compares equal to every other
    // empty one. `null` here is the honest "no pair recorded"; it is NEVER
    // filled in from `owner_user_id` or `spawned_by`, which answer different
    // questions (see the migration).
    // ABSENT, not `null`, when no pair was recorded. One spelling for one fact:
    // a row carrying `createdBy: null` beside rows that simply omit the key
    // would be two encodings of "nobody recorded this", and the whole point of
    // this field is that its absence has a single unambiguous meaning.
    ...(r.delegation ? { delegation: r.delegation } : {}),
    ...(r.createdByActorKind != null && r.createdByActorId != null
      ? {
          createdBy: {
            actor: actorFromColumns(r.createdByActorKind as ActorKind, r.createdByActorId),
            // The INNER null stays: it is the representable "no human behind
            // this" for the machine and system arms, which is a different fact
            // from the pair being absent altogether.
            onBehalfOf: r.createdByOnBehalfOf ?? null,
          },
        }
      : {}),
    headless: r.headless,
    issueId: r.issueId ?? null,
    refIssueId: r.refIssueId ?? null,
    refLetter: r.refLetter ?? null,
    refDraft: r.refDraft ?? null,
    stoppedAt: r.stoppedAt ?? null,
    stopReason:
      r.stopReason === 'self' ||
      r.stopReason === 'parent' ||
      r.stopReason === 'forced' ||
      r.stopReason === 'exited'
        ? r.stopReason
        : null,
    oomKilledAt: r.oomKilledAt ?? null,
    ...optionalLifecycle(lifecycleOfRow(r)),
    workflowRunId: r.workflowRunId ?? null,
    workflowStepId: r.workflowStepId ?? null,
    agentProfileId: r.agentProfileId ?? null,
    deletedAt: r.deletedAt ?? null,
    deletionSource: (r.deletionSource as SessionDeletionSource | null) ?? null,
    deletedByIssueId: r.deletedByIssueId ?? null,
  }
}

/** A persisted versioned draft, as stored in `session_drafts`. */
export interface StoredDraftDoc {
  text: string
  /** ISO-8601; the doc's `editedAt`. */
  updatedAt: string
  rev: number
  origin: string | null
  history: string[]
}

function parseHistory(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** A launch report that no longer parses is absent: the next launch reports again. */
function parseLaunchPosture(value: string | null): SessionRow['launchPosture'] {
  if (value === null) return null
  try {
    const parsed = LaunchPostureReport.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A corrupt legacy report is absent, as a corrupt runtime checkpoint is. */
function parseAgentState(value: string | null): SessionRow['agentState'] {
  if (value === null) return null
  try {
    const parsed = AgentRuntimeState.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
