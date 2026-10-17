/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import {
  type ActorKind,
  AgentKind,
  actorColumns,
  actorFromColumns,
  asSessionId,
  type IssueId,
  type MachineId,
  machinePathSeparator,
  type SessionId,
  type UserId,
  type SessionUserStateWire,
} from '@podium/model'
import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, or, type Placeholder, type SQL, sql } from 'drizzle-orm'
import {
  issues as issuesTable,
  offers as offersTable,
  pins as pinsTable,
  runtimeEventCheckpoints,
  sessionDrafts,
  sessions as sessionsTable,
  sessionUserState,
  snoozes as snoozesTable,
  tabOrder,
} from '../migrations/schema'
import { applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
} from './executor/sync-drizzle'
import { requireUserId } from './helpers'
import { prefixUpperBound } from './prefix-range'
import type { RepoPlaces } from './repos'
import type {
  OfferMap,
  OfferRecord,
  PinKind,
  PinState,
  SessionDeletionSource,
  SessionRow,
  SessionStatusPersisted,
  SnoozeMap,
} from './types'

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo'])

/** RETAINED EXTERNAL-INPUT BRAND CASTS: compatibility helpers accept and trim
 * raw session ids before queries or writes. Selected session ids flow from the
 * schema without re-entry casts. */
/** The one row shape every session read returns, before mapping. */
type SessionSelect = typeof sessionsTable.$inferSelect

// Every query this repository runs, prepared once per store [POD-6147].

const bindingOwnersOnMachine = prepared((db: StoreDrizzle) =>
  db
    .select({ id: sessionsTable.id, owner: sessionsTable.ownerUserId })
    .from(sessionsTable)
    .where(eq(sessionsTable.machineId, param(sessionsTable.machineId, 'machineId')))
    .prepare(),
)

const bindingOwnersOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ id: sessionsTable.id, owner: sessionsTable.ownerUserId })
    .from(sessionsTable)
    .where(inListOf(sessionsTable.id, size))
    .prepare(),
)

const bindingFactsOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      id: sessionsTable.id,
      owner: sessionsTable.ownerUserId,
      machineId: sessionsTable.machineId,
      deletedAt: sessionsTable.deletedAt,
      delegation: sessionsTable.delegation,
    })
    .from(sessionsTable)
    .where(inListOf(sessionsTable.id, size))
    .prepare(),
)

/**
 * THE ONE SESSION READ. Every reader supplies a predicate and inherits this
 * ordering; three of them depend on it meaning the same thing, so it is
 * declared once (see `findSessionByResumeValue`).
 */
function sessionsWhere(db: StoreDrizzle, where: SQL | undefined) {
  return db
    .select()
    .from(sessionsTable)
    .where(where)
    .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
    .prepare()
}

/**
 * The selections the durable session records ask (POD-6160): a predicate and
 * NO ordering. Their caller merges them with the resident sessions and orders
 * the few rows itself, so an ORDER BY here would only add a sort to an index
 * read.
 */
function sessionsMatching(db: StoreDrizzle, where: SQL | undefined) {
  return db.select().from(sessionsTable).where(where).prepare()
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
const sessionById = prepared((db: StoreDrizzle) =>
  sessionsWhere(db, eq(sessionsTable.id, param(sessionsTable.id, 'id'))),
)

const liveSessionByResumeValue = prepared((db: StoreDrizzle) =>
  sessionsWhere(
    db,
    and(
      eq(sessionsTable.resumeValue, param(sessionsTable.resumeValue, 'resumeValue')),
      isNull(sessionsTable.deletedAt),
    ),
  ),
)

const sessionsOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsWhere(db, inListOf(sessionsTable.id, size)),
)

/** The predicate the two plural resume readers share, so they cannot drift. */
const liveSessionsOfResumeValues = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsWhere(db, and(inListOf(sessionsTable.resumeValue, size), isNull(sessionsTable.deletedAt))),
)

const liveSessionsOfIssueIds = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsWhere(db, and(inListOf(sessionsTable.issueId, size), isNull(sessionsTable.deletedAt))),
)

/** The folded cwd `idx_sessions_cwd_folded` indexes; repeat it exactly. */
const foldedCwd = sql`lower(replace(${sessionsTable.cwd}, '/', '\\'))`

/** Live sessions whose literal cwd lies in the key range [lo, hi) (POD-6160). */
const liveSessionsInCwdRange = prepared((db: StoreDrizzle) =>
  sessionsMatching(
    db,
    and(
      gte(sessionsTable.cwd, param(sessionsTable.cwd, 'lo')),
      lt(sessionsTable.cwd, param(sessionsTable.cwd, 'hi')),
      isNull(sessionsTable.deletedAt),
    ),
  ),
)

/** The same over the folded cwd, for Windows-style roots (POD-6160). */
const liveSessionsInFoldedCwdRange = prepared((db: StoreDrizzle) =>
  sessionsMatching(
    db,
    and(
      sql`${foldedCwd} >= ${sql.placeholder('lo')}`,
      sql`${foldedCwd} < ${sql.placeholder('hi')}`,
      isNull(sessionsTable.deletedAt),
    ),
  ),
)

/** Live sessions in one of these statuses (POD-6160). */
const liveSessionsOfStatuses = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsMatching(db, and(inListOf(sessionsTable.status, size), isNull(sessionsTable.deletedAt))),
)

/** Live headless sessions (POD-6160): resident while their row exists. */
const liveHeadlessSessions = prepared((db: StoreDrizzle) =>
  sessionsMatching(db, and(sql`${sessionsTable.headless} = 1`, isNull(sessionsTable.deletedAt))),
)

/** Live sessions whose id lies in the key range [lo, hi): a short-id prefix (POD-6160). */
const liveSessionsInIdRange = prepared((db: StoreDrizzle) =>
  sessionsMatching(
    db,
    and(
      gte(sessionsTable.id, param(sessionsTable.id, 'lo')),
      lt(sessionsTable.id, param(sessionsTable.id, 'hi')),
      isNull(sessionsTable.deletedAt),
    ),
  ),
)

/** Live sessions born on one of these issues with this letter (POD-6160). */
const liveSessionsOfBirthLetter = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsMatching(
    db,
    and(
      inListOf(sessionsTable.refIssueId, size),
      eq(sessionsTable.refLetter, param(sessionsTable.refLetter, 'letter')),
      isNull(sessionsTable.deletedAt),
    ),
  ),
)

/** Live sessions whose birth ref names one of these issues (POD-6160 D2g).
 *  `IS NOT NULL` lets the partial `idx_sessions_ref_issue` serve the IN list. */
const liveSessionsReferencingIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsMatching(
    db,
    and(inListOf(sessionsTable.refIssueId, size), isNotNull(sessionsTable.refIssueId), isNull(sessionsTable.deletedAt)),
  ),
)

/** Live sessions with this draft ordinal, in any repository (POD-6160). */
const liveSessionsOfDraft = prepared((db: StoreDrizzle) =>
  sessionsMatching(
    db,
    and(eq(sessionsTable.refDraft, param(sessionsTable.refDraft, 'draft')), isNull(sessionsTable.deletedAt)),
  ),
)

/** Live sessions spawned by one of these parents (`spawned_by` values) (POD-6160). */
const liveSessionsSpawnedBy = preparedFamily((db: StoreDrizzle, size: number) =>
  sessionsMatching(db, and(inListOf(sessionsTable.spawnedBy, size), isNull(sessionsTable.deletedAt))),
)

/** The issues with this sequence number, in any repository: the issue half of
 *  a birth ref (`POD-13-A`), before its prefix is checked (POD-6160). */
const issueIdsOfSeq = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issuesTable.id })
    .from(issuesTable)
    .where(eq(issuesTable.seq, param(issuesTable.seq, 'seq')))
    .prepare(),
)

/** A machine's live sessions (POD-6160). */
const liveSessionsOnMachine = prepared((db: StoreDrizzle) =>
  sessionsMatching(
    db,
    and(eq(sessionsTable.machineId, param(sessionsTable.machineId, 'machineId')), isNull(sessionsTable.deletedAt)),
  ),
)

const liveSessions = prepared((db: StoreDrizzle) =>
  sessionsWhere(db, isNull(sessionsTable.deletedAt)),
)

/**
 * ONE PAGE OF THE LIVE SESSIONS, in id order after `after` (POD-6160 D2g): the
 * boot's ledger baseline reads every session this way, a page at a time, so no
 * statement returns the whole table and nothing is made resident.
 */
const liveSessionsPage = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(sessionsTable)
    .where(and(isNull(sessionsTable.deletedAt), sql`${sessionsTable.id} > ${sql.placeholder('after')}`))
    .orderBy(asc(sessionsTable.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** Live sessions with no birth ref yet, in the boot ref backfill's order
 *  (#474): created_at, then id. */
const liveSessionsWithoutRef = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(sessionsTable)
    .where(and(isNull(sessionsTable.refIssueId), isNull(sessionsTable.refDraft), isNull(sessionsTable.deletedAt)))
    .orderBy(asc(sessionsTable.createdAt), asc(sessionsTable.id))
    .prepare(),
)

/** The ref-less live terms, spelled as `idx_sessions_refless_*` declare them so
 *  the planner can use those partial indexes. */
const REFLESS = sql.raw('s.ref_issue_id IS NULL AND s.ref_draft IS NULL AND s.deleted_at IS NULL')

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
const refBackfillCandidates = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(sessionsTable)
    .where(sql`${sessionsTable}.rowid IN (
      SELECT s.rowid FROM json_each(${sql.placeholder('bounded')}) AS b CROSS JOIN ${sessionsTable} AS s
        WHERE ${REFLESS} AND s.machine_id = json_extract(b.value, '$[0]')
          AND s.cwd >= json_extract(b.value, '$[1]') AND s.cwd < json_extract(b.value, '$[2]')
      UNION ALL
      SELECT s.rowid FROM json_each(${sql.placeholder('open')}) AS o CROSS JOIN ${sessionsTable} AS s
        WHERE ${REFLESS} AND s.machine_id = json_extract(o.value, '$[0]') AND s.cwd >= json_extract(o.value, '$[1]')
      UNION ALL
      SELECT s.rowid FROM ${sessionsTable} AS s INDEXED BY idx_sessions_refless_issue
        WHERE ${REFLESS} AND s.issue_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ${issuesTable} AS i WHERE i.id = s.issue_id)
    )`)
    .orderBy(asc(sessionsTable.createdAt), asc(sessionsTable.id))
    .prepare(),
)

const deletedSessions = prepared((db: StoreDrizzle) =>
  sessionsWhere(db, isNotNull(sessionsTable.deletedAt)),
)

const deletedByIssue = (): SQL | undefined =>
  and(
    isNotNull(sessionsTable.deletedAt),
    eq(sessionsTable.deletionSource, 'issue'),
    eq(sessionsTable.deletedByIssueId, param(sessionsTable.deletedByIssueId, 'issueId')),
  )

const deletedSessionsForIssue = prepared((db: StoreDrizzle) => sessionsWhere(db, deletedByIssue()))

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
 * The ON CONFLICT set both session upserts share, so the one-row and the
 * many-row forms cannot drift apart. `value(key)` names the incoming value of a
 * column: its placeholder in the one-row form, `excluded."column"` in the
 * many-row form. `id`, `ownerUserId`, `agentKind`, `createdAt` and `headless`
 * are written on insert only.
 */
function sessionUpsertSet(value: (key: SessionColumnKey) => Placeholder | SQL | undefined) {
  return {
    cwd: value('cwd'),
    model: value('model'),
    effort: value('effort'),
    requestedModel: value('requestedModel'),
    requestedEffort: value('requestedEffort'),
    accountId: value('accountId'),
    loginHarness: sql`COALESCE(${sessionsTable.loginHarness}, excluded."login_harness")`,
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
    // BINDING IS ONE-WAY (POD-2392): once a launch is known to have had a
    // native conversation, no later write may say it never did. The rule
    // lives here rather than in the caller because it is the premise the
    // fresh-relaunch path depends on — a caller that reconstructs a stale
    // Session and persists it must not be able to un-prove a conversation.
    conversationBinding: sql`CASE
         WHEN ${sessionsTable.conversationBinding} = 'bound' THEN 'bound'
         ELSE excluded."conversation_binding"
       END`,
    status: value('status'),
    exitCode: value('exitCode'),
    spawnFailure: value('spawnFailure'),
    durableLabel: value('durableLabel'),
    lastActiveAt: value('lastActiveAt'),
    terminalCols: value('terminalCols'),
    terminalRows: value('terminalRows'),
    workingMsTotal: value('workingMsTotal'),
    inputCount: value('inputCount'),
    outputCount: value('outputCount'),
    activityCount: value('activityCount'),
    archived: value('archived'),
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
    deletedAt: value('deletedAt'),
    deletionSource: value('deletionSource'),
    deletedByIssueId: value('deletedByIssueId'),
    workflowRunId: value('workflowRunId'),
    workflowStepId: value('workflowStepId'),
    agentProfileId: value('agentProfileId'),
    // Birth name is PERMANENT (#474): once allocated it never changes, even
    // when the session re-attaches to a different issue. COALESCE keeps the
    // first non-null allocation.
    refIssueId: sql`COALESCE(${sessionsTable.refIssueId}, excluded."ref_issue_id")`,
    refLetter: sql`COALESCE(${sessionsTable.refLetter}, excluded."ref_letter")`,
    refDraft: sql`COALESCE(${sessionsTable.refDraft}, excluded."ref_draft")`,
    // ATTRIBUTION IS IMMUTABLE AFTER CREATE (POD-365's
    // SESSION_IMMUTABLE_AFTER_CREATE lists `createdBy`). COALESCE keeps the
    // pair stamped at birth: an upsert from a later code path — a status
    // change, a rename, a reattach — must not be able to re-attribute the
    // session to whoever happened to trigger it. It can only FILL a pair
    // that was never recorded, never overwrite one that was.
    delegation: sql`COALESCE(${sessionsTable.delegation}, excluded."delegation")`,
    createdByActorKind: sql`COALESCE(${sessionsTable.createdByActorKind}, excluded."created_by_actor_kind")`,
    createdByActorId: sql`COALESCE(${sessionsTable.createdByActorId}, excluded."created_by_actor_id")`,
    createdByOnBehalfOf: sql`COALESCE(${sessionsTable.createdByOnBehalfOf}, excluded."created_by_on_behalf_of")`,
  }
}

const upsertSessionOfShape = preparedFamily((db: StoreDrizzle, shape: string) => {
  const p = placeholdersFor(shape) as SessionPlaceholders
  return db
    .insert(sessionsTable)
    .values(p as unknown as SessionInsert)
    .onConflictDoUpdate({ target: sessionsTable.id, set: sessionUpsertSet((key) => p[key]) })
    .prepare()
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
 * keyed `${size}|${shape}`. `size` comes from {@link inListSize}, so there are
 * at most log2(256) + 2 sizes per shape; a shorter batch repeats its last row,
 * and an upsert of the same row twice leaves it as once (the set is the
 * incoming values, and every COALESCE and CASE in it keeps a value it already
 * wrote).
 */
const upsertSessionsOfShape = preparedFamily((db: StoreDrizzle, key: string) => {
  const bar = key.indexOf('|')
  const size = Number(key.slice(0, bar))
  const shape = key.slice(bar + 1)
  const keys = shape === '' ? [] : shape.split(',')
  const present = new Set<string>(keys)
  const columns = getTableColumns(sessionsTable)
  const rows = Array.from({ length: size }, (_, index) =>
    Object.fromEntries(keys.map((name) => [name, sql.placeholder(rowParam(index, name))])),
  )
  return db
    .insert(sessionsTable)
    .values(rows as unknown as SessionInsert[])
    .onConflictDoUpdate({
      target: sessionsTable.id,
      set: sessionUpsertSet((name) =>
        present.has(name) ? sql`excluded.${sql.identifier(columns[name].name)}` : undefined,
      ),
    })
    .prepare()
})

/** The column values of one session row, refused before any write when the row
 *  is one no client could read. */
function sessionUpsertValues(row: SessionRow) {
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
    conversationBinding: row.conversationBinding ?? null,
    status: row.status,
    exitCode: row.exitCode,
    spawnFailure: row.spawnFailure ?? null,
    durableLabel: row.durableLabel,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    terminalCols: row.geometry?.cols ?? 80,
    terminalRows: row.geometry?.rows ?? 24,
    workingMsTotal: row.workingMsTotal ?? null,
    inputCount: row.inputCount ?? 0,
    outputCount: row.outputCount ?? 0,
    activityCount: row.activityCount ?? 0,
    archived: row.archived,
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

const untombstonedById = (): SQL | undefined =>
  and(eq(sessionsTable.id, param(sessionsTable.id, 'id')), isNull(sessionsTable.deletedAt))

const stopRunningForTombstone = prepared((db: StoreDrizzle) =>
  db
    .update(sessionsTable)
    .set({ status: 'exited', stoppedAt: sql.placeholder('deletedAt'), stopReason: 'forced' })
    .where(
      and(untombstonedById(), inArray(sessionsTable.status, ['starting', 'live', 'reconnecting'])),
    )
    .prepare(),
)

const tombstoneSession = prepared((db: StoreDrizzle) =>
  db
    .update(sessionsTable)
    .set({
      deletedAt: sql.placeholder('deletedAt'),
      deletionSource: sql.placeholder('source'),
      deletedByIssueId: sql.placeholder('deletedByIssueId'),
    })
    .where(untombstonedById())
    .prepare(),
)

const restoreSessionsOfIssue = prepared((db: StoreDrizzle) =>
  db
    .update(sessionsTable)
    .set({
      deletedAt: null,
      deletionSource: null,
      deletedByIssueId: null,
      status: 'exited',
      exitCode: null,
    })
    .where(deletedByIssue())
    .prepare(),
)

const detachTombstones = prepared((db: StoreDrizzle) => {
  const issueId = sql.placeholder('issueId')
  return db
    .update(sessionsTable)
    .set({
      issueId: sql`CASE WHEN ${sessionsTable.issueId} = ${issueId} THEN NULL ELSE ${sessionsTable.issueId} END`,
      refIssueId: sql`CASE WHEN ${sessionsTable.refIssueId} = ${issueId} THEN NULL ELSE ${sessionsTable.refIssueId} END`,
      refLetter: sql`CASE WHEN ${sessionsTable.refIssueId} = ${issueId} THEN NULL ELSE ${sessionsTable.refLetter} END`,
    })
    .where(
      and(
        isNotNull(sessionsTable.deletedAt),
        or(
          eq(sessionsTable.issueId, param(sessionsTable.issueId, 'issueId')),
          eq(sessionsTable.refIssueId, param(sessionsTable.refIssueId, 'issueId')),
        ),
      ),
    )
    .prepare()
})

const detachDanglingReferences = prepared((db: StoreDrizzle) => {
  // The subquery's own column is unqualified and resolves inside `issues`,
  // which is what it must do; the OUTER columns are the `sessions` ones the
  // builder qualifies for us here because they are named as columns rather
  // than interpolated into the fragment.
  const danglingIssue = sql`${sessionsTable.issueId} IS NOT NULL AND ${sessionsTable.issueId} NOT IN (SELECT ${issuesTable.id} FROM ${issuesTable})`
  const danglingRef = sql`${sessionsTable.refIssueId} IS NOT NULL AND ${sessionsTable.refIssueId} NOT IN (SELECT ${issuesTable.id} FROM ${issuesTable})`
  return db
    .update(sessionsTable)
    .set({
      issueId: sql`CASE WHEN ${danglingIssue} THEN NULL ELSE ${sessionsTable.issueId} END`,
      refLetter: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${sessionsTable.refLetter} END`,
      refIssueId: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${sessionsTable.refIssueId} END`,
    })
    .where(or(danglingIssue, danglingRef))
    .prepare()
})

const deleteCheckpointsOfSession = prepared((db: StoreDrizzle) =>
  db
    .delete(runtimeEventCheckpoints)
    .where(eq(runtimeEventCheckpoints.sessionId, param(runtimeEventCheckpoints.sessionId, 'id')))
    .prepare(),
)

const deleteSessionRow = prepared((db: StoreDrizzle) =>
  db.delete(sessionsTable).where(eq(sessionsTable.id, param(sessionsTable.id, 'id'))).prepare(),
)

const deletePanelPinsOf = prepared((db: StoreDrizzle) =>
  db
    .delete(pinsTable)
    .where(and(eq(pinsTable.kind, 'panel'), eq(pinsTable.id, param(pinsTable.id, 'id'))))
    .prepare(),
)

const deleteDraftOf = prepared((db: StoreDrizzle) =>
  db
    .delete(sessionDrafts)
    .where(eq(sessionDrafts.sessionId, param(sessionDrafts.sessionId, 'id')))
    .prepare(),
)

const deleteSnoozesOf = prepared((db: StoreDrizzle) =>
  db
    .delete(snoozesTable)
    .where(eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'id')))
    .prepare(),
)

const deleteUserStateOf = prepared((db: StoreDrizzle) =>
  db
    .delete(sessionUserState)
    .where(eq(sessionUserState.sessionId, param(sessionUserState.sessionId, 'id')))
    .prepare(),
)

const deleteOfferOf = prepared((db: StoreDrizzle) =>
  db
    .delete(offersTable)
    .where(eq(offersTable.sessionId, param(offersTable.sessionId, 'id')))
    .prepare(),
)

const pinsOfUser = prepared((db: StoreDrizzle) =>
  db
    .select({ kind: pinsTable.kind, id: pinsTable.id })
    .from(pinsTable)
    .where(eq(pinsTable.userId, param(pinsTable.userId, 'userId')))
    .orderBy(asc(sql`rowid`))
    .prepare(),
)

const insertPin = prepared((db: StoreDrizzle) =>
  db
    .insert(pinsTable)
    .values({
      userId: sql.placeholder('userId'),
      kind: sql.placeholder('kind'),
      id: sql.placeholder('id'),
      pinnedAt: sql.placeholder('pinnedAt'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deletePin = prepared((db: StoreDrizzle) =>
  db
    .delete(pinsTable)
    .where(
      and(
        eq(pinsTable.userId, param(pinsTable.userId, 'userId')),
        eq(pinsTable.kind, param(pinsTable.kind, 'kind')),
        eq(pinsTable.id, param(pinsTable.id, 'id')),
      ),
    )
    .prepare(),
)

const allUserStateRows = prepared((db: StoreDrizzle) =>
  db.select().from(sessionUserState).where(undefined).prepare(),
)

const userStateRowsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(sessionUserState)
    .where(eq(sessionUserState.sessionId, param(sessionUserState.sessionId, 'sessionId')))
    .prepare(),
)

const allSnoozeRows = prepared((db: StoreDrizzle) =>
  db.select().from(snoozesTable).where(undefined).prepare(),
)

const snoozeRowsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(snoozesTable)
    .where(eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'sessionId')))
    .prepare(),
)

const userSessionSnooze = prepared((db: StoreDrizzle) =>
  db
    .select({ until: snoozesTable.snoozedUntil })
    .from(snoozesTable)
    .where(
      and(
        eq(snoozesTable.userId, param(snoozesTable.userId, 'userId')),
        eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const readAtOfUser = prepared((db: StoreDrizzle) =>
  db
    .select({ sessionId: sessionUserState.sessionId, readAt: sessionUserState.readAt })
    .from(sessionUserState)
    .where(eq(sessionUserState.userId, param(sessionUserState.userId, 'userId')))
    .prepare(),
)

const userSessionState = (): SQL | undefined =>
  and(
    eq(sessionUserState.userId, param(sessionUserState.userId, 'userId')),
    eq(sessionUserState.sessionId, param(sessionUserState.sessionId, 'sessionId')),
  )

const readAtOfUserSession = prepared((db: StoreDrizzle) =>
  db
    .select({ readAt: sessionUserState.readAt })
    .from(sessionUserState)
    .where(userSessionState())
    .prepare(),
)

const upsertReadAt = prepared((db: StoreDrizzle) =>
  db
    .insert(sessionUserState)
    .values({
      userId: sql.placeholder('userId'),
      sessionId: sql.placeholder('sessionId'),
      readAt: sql.placeholder('readAt'),
    })
    .onConflictDoUpdate({
      target: [sessionUserState.userId, sessionUserState.sessionId],
      set: { readAt: sql.placeholder('readAt') },
    })
    .prepare(),
)

const deleteReadAt = prepared((db: StoreDrizzle) =>
  db.delete(sessionUserState).where(userSessionState()).prepare(),
)

const deleteAllReadAtOf = prepared((db: StoreDrizzle) =>
  db
    .delete(sessionUserState)
    .where(eq(sessionUserState.sessionId, param(sessionUserState.sessionId, 'sessionId')))
    .returning({ userId: sessionUserState.userId })
    .prepare(),
)

/** One user's read markers for a set of sessions (POD-6160). */
const readAtOfUserSessions = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ sessionId: sessionUserState.sessionId, readAt: sessionUserState.readAt })
    .from(sessionUserState)
    .where(
      and(
        eq(sessionUserState.userId, param(sessionUserState.userId, 'userId')),
        inListOf(sessionUserState.sessionId, size),
      ),
    )
    .prepare(),
)

/** One user's snoozes for a set of sessions (POD-6160). */
const snoozesOfUserSessions = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ sessionId: snoozesTable.sessionId, snoozedUntil: snoozesTable.snoozedUntil })
    .from(snoozesTable)
    .where(
      and(eq(snoozesTable.userId, param(snoozesTable.userId, 'userId')), inListOf(snoozesTable.sessionId, size)),
    )
    .prepare(),
)

const snoozesOfUser = prepared((db: StoreDrizzle) =>
  db
    .select({ sessionId: snoozesTable.sessionId, snoozedUntil: snoozesTable.snoozedUntil })
    .from(snoozesTable)
    .where(eq(snoozesTable.userId, param(snoozesTable.userId, 'userId')))
    .prepare(),
)

const deleteUserSnooze = prepared((db: StoreDrizzle) =>
  db
    .delete(snoozesTable)
    .where(
      and(
        eq(snoozesTable.userId, param(snoozesTable.userId, 'userId')),
        eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const upsertSnooze = prepared((db: StoreDrizzle) =>
  db
    .insert(snoozesTable)
    .values({
      userId: sql.placeholder('userId'),
      sessionId: sql.placeholder('sessionId'),
      snoozedUntil: sql.placeholder('snoozedUntil'),
      createdAt: sql.placeholder('createdAt'),
    })
    .onConflictDoUpdate({
      target: [snoozesTable.userId, snoozesTable.sessionId],
      set: { snoozedUntil: sql.placeholder('snoozedUntil') },
    })
    .prepare(),
)

const anySnoozeOf = prepared((db: StoreDrizzle) =>
  db
    .select({ present: sql<number>`1` })
    .from(snoozesTable)
    .where(eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'sessionId')))
    .limit(1)
    .prepare(),
)

const deleteAllSnoozesOf = prepared((db: StoreDrizzle) =>
  db
    .delete(snoozesTable)
    .where(eq(snoozesTable.sessionId, param(snoozesTable.sessionId, 'sessionId')))
    .returning({ userId: snoozesTable.userId })
    .prepare(),
)

const allOffers = prepared((db: StoreDrizzle) => db.select().from(offersTable).prepare())

const offersOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select().from(offersTable).where(inListOf(offersTable.sessionId, size)).prepare(),
)

const upsertOffer = prepared((db: StoreDrizzle) =>
  db
    .insert(offersTable)
    .values({
      sessionId: sql.placeholder('sessionId'),
      message: sql.placeholder('message'),
      actions: sql.placeholder('actions'),
      artifacts: sql.placeholder('artifacts'),
      createdAt: sql.placeholder('createdAt'),
    })
    .onConflictDoUpdate({
      target: offersTable.sessionId,
      set: {
        message: sql.placeholder('message'),
        actions: sql.placeholder('actions'),
        artifacts: sql.placeholder('artifacts'),
        createdAt: sql.placeholder('createdAt'),
      },
    })
    .prepare(),
)

const offerCreatedAtOf = prepared((db: StoreDrizzle) =>
  db
    .select({ createdAt: offersTable.createdAt })
    .from(offersTable)
    .where(eq(offersTable.sessionId, param(offersTable.sessionId, 'sessionId')))
    .prepare(),
)

const tabOrdersOfUser = prepared((db: StoreDrizzle) =>
  db
    .select({ worktree: tabOrder.worktree, ids: tabOrder.ids })
    .from(tabOrder)
    .where(eq(tabOrder.userId, param(tabOrder.userId, 'userId')))
    .prepare(),
)

const deleteTabOrder = prepared((db: StoreDrizzle) =>
  db
    .delete(tabOrder)
    .where(
      and(
        eq(tabOrder.userId, param(tabOrder.userId, 'userId')),
        eq(tabOrder.worktree, param(tabOrder.worktree, 'worktree')),
      ),
    )
    .prepare(),
)

const upsertTabOrder = prepared((db: StoreDrizzle) =>
  db
    .insert(tabOrder)
    .values({
      userId: sql.placeholder('userId'),
      worktree: sql.placeholder('worktree'),
      ids: sql.placeholder('ids'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [tabOrder.userId, tabOrder.worktree],
      set: { ids: sql.placeholder('ids'), updatedAt: sql.placeholder('updatedAt') },
    })
    .prepare(),
)

// THREE COLUMNS, NAMED, because the statement this replaces named three
// [spec rule 39]. `tab_order` has four; spreading the table here would read
// `updated_at` on every row of every purge and hand it to a reader that
// builds its object from `user_id`, `worktree` and `ids` — right rows, right
// values, and an extra column over the wire on a remote driver, which is
// this epic's whole criterion. No test could have seen it.
const allTabOrders = prepared((db: StoreDrizzle) =>
  db
    .select({ userId: tabOrder.userId, worktree: tabOrder.worktree, ids: tabOrder.ids })
    .from(tabOrder)
    .prepare(),
)

const draftTexts = prepared((db: StoreDrizzle) =>
  db
    .select({ sessionId: sessionDrafts.sessionId, text: sessionDrafts.text })
    .from(sessionDrafts)
    .prepare(),
)

const draftTimes = prepared((db: StoreDrizzle) =>
  db
    .select({ sessionId: sessionDrafts.sessionId, updatedAt: sessionDrafts.updatedAt })
    .from(sessionDrafts)
    .prepare(),
)

const draftTimesOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ sessionId: sessionDrafts.sessionId, updatedAt: sessionDrafts.updatedAt })
    .from(sessionDrafts)
    .where(inListOf(sessionDrafts.sessionId, size))
    .prepare(),
)

const upsertDraftText = prepared((db: StoreDrizzle) =>
  db
    .insert(sessionDrafts)
    .values({
      sessionId: sql.placeholder('sessionId'),
      text: sql.placeholder('text'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: sessionDrafts.sessionId,
      set: { text: sql.placeholder('text'), updatedAt: sql.placeholder('updatedAt') },
    })
    .prepare(),
)

const allDraftRows = prepared((db: StoreDrizzle) => db.select().from(sessionDrafts).prepare())

/** One session's versioned draft document (POD-6160: drafts load on use). */
const draftRowOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(sessionDrafts)
    .where(eq(sessionDrafts.sessionId, param(sessionDrafts.sessionId, 'sessionId')))
    .prepare(),
)

const upsertDraftDoc = prepared((db: StoreDrizzle) =>
  db
    .insert(sessionDrafts)
    .values({
      sessionId: sql.placeholder('sessionId'),
      text: sql.placeholder('text'),
      updatedAt: sql.placeholder('updatedAt'),
      rev: sql.placeholder('rev'),
      origin: sql.placeholder('origin'),
      history: sql.placeholder('history'),
    })
    .onConflictDoUpdate({
      target: sessionDrafts.sessionId,
      set: {
        text: sql.placeholder('text'),
        updatedAt: sql.placeholder('updatedAt'),
        rev: sql.placeholder('rev'),
        origin: sql.placeholder('origin'),
        history: sql.placeholder('history'),
      },
    })
    .prepare(),
)

export class SessionsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * This aggregate opens no span today — `purgeSession` runs inside its caller —
   * but both members are retained so adding one later does not change constructor
   * arity or the composition root.
   */
  constructor(
    queries: StoreQueries,
    private readonly purgeObservationCheckpoint: (sessionId: SessionId) => void = () => {},
  ) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line rather than 39 fields.
   */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  // ---- sessions ----
  /** Legacy peers receive their machine map; inventory peers receive every requested id.
   * Single-member disclosure only; Track B must authorize cross-member inventory. */
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

  /** Single-member Track A: disclose requested placement facts across machines.
   * Track B must authorize this inventory before multi-member deployment. */
  async bindingConfirmations(
    ids: readonly string[],
  ): Promise<import('@podium/protocol').BindingConfirmations> {
    const result: import('@podium/protocol').BindingConfirmations = Object.fromEntries(
      ids.map((id) => [id, { owner: null, machineId: null, closed: false }]),
    )
    if (ids.length === 0) return result
    const size = inListSize(ids.length)
    const rows = await bindingFactsOfIds(this.db, size).all(inListValues(ids.map(asSessionId), size))
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
    const row = (await sessionById(this.db).all({ id: sessionId }))[0]
    return row === undefined ? undefined : mapSession(row)
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
   * `created_at ASC, rowid ASC` order, so taking `[0]` here picks exactly the
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
      const rows = await sessionsOfIds(this.db, size).all(inListValues(chunk, size))
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
    for (const row of await liveSessionsInCwdRange(this.db).all({ lo: root, hi: prefixUpperBound(root) })) {
      byId.set(row.id, row)
    }
    if (machinePathSeparator(root) === '\\') {
      const folded = root.replace(/\//g, '\\').replace(/[A-Z]/g, (char) => char.toLowerCase())
      for (const row of await liveSessionsInFoldedCwdRange(this.db).all({ lo: folded, hi: prefixUpperBound(folded) })) {
        byId.set(row.id, row)
      }
    }
    return [...byId.values()].map(mapSession)
  }

  /** Live sessions whose id starts with `prefix` (a short id), by a range on the
   *  primary key (POD-6160). */
  async sessionsWithIdPrefix(prefix: string): Promise<SessionRow[]> {
    if (!prefix) return []
    return (await liveSessionsInIdRange(this.db).all({ lo: prefix, hi: prefixUpperBound(prefix) })).map(mapSession)
  }

  /** Live sessions in one of these statuses, unordered (POD-6160). */
  async sessionsWithStatuses(statuses: readonly SessionStatusPersisted[]): Promise<SessionRow[]> {
    const unique = [...new Set(statuses)]
    if (unique.length === 0) return []
    const size = inListSize(unique.length)
    return (await liveSessionsOfStatuses(this.db, size).all(inListValues(unique, size))).map(mapSession)
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
      const rows = await liveSessionsOfBirthLetter(this.db, size).all({ letter, ...inListValues(chunk, size) })
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
      out.push(...(await liveSessionsSpawnedBy(this.db, size).all(inListValues(chunk, size))).map(mapSession))
    }
    return out
  }

  /** A machine's live sessions, unordered (POD-6160). */
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

  async upsertSession(row: SessionRow): Promise<void> {
    const values = sessionUpsertValues(row)
    await upsertSessionOfShape(this.db, shapeOf(values)).run(values)
    this.rowsWritten()
  }

  /**
   * {@link upsertSession} for many rows in one statement per 256 rows of one
   * key shape [POD-6175], for the activity flush that persists every busy
   * session on one tick. Every row is checked before the first is written.
   * Rows are written in the order given; pass each session once.
   */
  async upsertSessions(rows: readonly SessionRow[]): Promise<void> {
    if (rows.length === 0) return
    const byShape = new Map<string, ReturnType<typeof sessionUpsertValues>[]>()
    for (const row of rows) {
      const values = sessionUpsertValues(row)
      const shape = shapeOf(values)
      const group = byShape.get(shape)
      if (group) group.push(values)
      else byShape.set(shape, [values])
    }
    for (const [shape, group] of byShape) {
      const keys = shape === '' ? [] : shape.split(',')
      for (let start = 0; start < group.length; start += UPSERT_ROWS_PER_STATEMENT) {
        const chunk = group.slice(start, start + UPSERT_ROWS_PER_STATEMENT)
        const size = inListSize(chunk.length)
        const params: Record<string, unknown> = {}
        for (let index = 0; index < size; index++) {
          const values = chunk[Math.min(index, chunk.length - 1)] as Record<string, unknown>
          for (const key of keys) params[rowParam(index, key)] = values[key]
        }
        await upsertSessionsOfShape(this.db, `${size}|${shape}`).run(params)
      }
    }
    this.rowsWritten()
  }

  /** Tombstone sessions without destroying their metadata or UI satellites.
   *
   *  A tombstone KILLS a running process, and it records that exit in the same
   *  write (POD-4634). Nothing else can: the session leaves the live map at the
   *  commit, so the daemon's `agentExit` finds no session to stamp, and the row
   *  kept `status='live'` with no stop reason for as long as it existed. Only a
   *  RUNNING row changes; a hibernated or exited one already says how it stopped. */
  async softDeleteSessions(
    ids: string[],
    deletedAt: string,
    source: SessionDeletionSource,
    deletedByIssueId: IssueId | null = null,
  ): Promise<void> {
    for (const id of ids) {
      await stopRunningForTombstone(this.db).run({ id, deletedAt })
      await tombstoneSession(this.db).run({ id, deletedAt, source, deletedByIssueId })
    }
    this.rowsWritten()
  }

  /** Mark sessions as deleted by an issue so restoring that issue can recover them. */
  async softDeleteForIssue(ids: string[], issueId: IssueId, deletedAt: string): Promise<void> {
    await this.softDeleteSessions(ids, deletedAt, 'issue', issueId)
  }

  /** Re-expose an issue's tombstoned sessions as honestly exited runtime records. */
  async restoreDeletedForIssue(issueId: IssueId): Promise<void> {
    await restoreSessionsOfIssue(this.db).run({ issueId })
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
  async detachTombstonesFromIssue(issueId: IssueId): Promise<void> {
    await detachTombstones(this.db).run({ issueId })
    this.rowsWritten()
  }

  /**
   * Per-boot heal for references left behind by a purge that predates
   * {@link detachTombstonesFromIssue} (POD-1926). Idempotent, and unscoped by
   * `deleted_at` on purpose: it runs from the store facade's constructor, ahead
   * of every reader in the process, so no in-memory `Session` exists yet to
   * desync. Returns the number of rows healed.
   */
  async detachDanglingIssueReferences(): Promise<number> {
    const result = await detachDanglingReferences(this.db).run()
    this.rowsWritten()
    return Number(result.changes)
  }

  /** Irreversibly remove a session and its satellites. Internal maintenance only. */
  async purgeSession(id: SessionId): Promise<void> {
    await deleteCheckpointsOfSession(this.db).run({ id })
    this.purgeObservationCheckpoint(id)
    await deleteSessionRow(this.db).run({ id })
    this.rowsWritten()
    await deletePanelPinsOf(this.db).run({ id })
    await deleteDraftOf(this.db).run({ id })
    await deleteSnoozesOf(this.db).run({ id })
    await deleteUserStateOf(this.db).run({ id })
    await deleteOfferOf(this.db).run({ id }) // [spec:SP-c7f1]
    await this.scrubTabOrders(id)
  }

  // ---- pins (PER-USER STATE, POD-380) ----
  //
  // Keyed (user_id, kind, id). `userId` is REQUIRED and leading on every method
  // here rather than optional-with-a-default: a defaulted user id is how one
  // person ends up reading another's rows, and the point of the re-key is that the
  // caller must say whose state it is touching. Server-internal paths that have no
  // principal pass SOLE_USER_ID explicitly, which makes them greppable for
  // POD-1077 (the scoped feed that finally makes the broadcast per-principal).
  async listPins(userId: UserId): Promise<PinState> {
    const rows = await pinsOfUser(this.db).all({ userId })
    const pins: PinState = { panels: [], worktrees: [], repos: [] }
    for (const row of rows) {
      if (row.kind === 'panel') pins.panels.push(row.id)
      else if (row.kind === 'worktree') pins.worktrees.push(row.id)
      else if (row.kind === 'repo') pins.repos.push(row.id)
    }
    return pins
  }

  async setPin(userId: UserId, kind: PinKind, id: string, pinned: boolean): Promise<void> {
    if (!PIN_KINDS.has(kind)) throw new Error(`invalid pin kind: ${kind}`)
    requireUserId(userId)
    const cleanId = id.trim()
    if (!cleanId) throw new Error('pin id is empty')
    if (pinned) {
      // `INSERT OR IGNORE` CONVERTS HERE, and the enumeration is why (spec rule
      // 31, POD-3403). The two forms differ in general: `OR IGNORE` suppresses
      // UNIQUE, PRIMARY KEY, NOT NULL and CHECK, while `onConflictDoNothing`
      // suppresses uniqueness conflicts only. (Neither suppresses FOREIGN KEY,
      // so foreign keys are not part of this comparison.) They are therefore
      // equivalent at a site exactly when no NOT NULL and no CHECK violation is
      // reachable — and at this one, neither is:
      //
      //   CHECK       none. `PRAGMA index_list(pins)` on the SHIPPED table
      //               returns one index, `sqlite_autoindex_pins_1`, unique,
      //               origin `pk`; the table SQL carries no CHECK clause.
      //   NOT NULL    all four columns are notnull=1 with no default, and every
      //               one is refused above before this line is reached:
      //               `user_id` by `requireUserId` (throws on blank), `kind` by
      //               the `PIN_KINDS` membership throw, `id` by the empty-string
      //               throw on the trimmed value, and `pinned_at` is a freshly
      //               built ISO string.
      await insertPin(this.db).run({ userId, kind, id: cleanId, pinnedAt: new Date().toISOString() })
    } else {
      await deletePin(this.db).run({ userId, kind, id: cleanId })
    }
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

  async markSessionRead(userId: UserId, sessionId: SessionId, readAt: string): Promise<void> {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('read-state session id is empty')
    await upsertReadAt(this.db).run({ userId, sessionId: asSessionId(id), readAt })
  }

  /** DELETES the row rather than writing a null. Absence and `read_at IS NULL`
   *  would be two spellings of "never opened", and a table with two spellings of
   *  one fact acquires a second meaning nobody documented. */
  async markSessionUnread(userId: UserId, sessionId: SessionId): Promise<void> {
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
  async clearAllReadAt(sessionId: SessionId): Promise<UserId[]> {
    const cleared = await deleteAllReadAtOf(this.db).all({
      sessionId: asSessionId(sessionId.trim()),
    })
    return cleared.map((row) => row.userId)
  }

  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time. */
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
    for (const id of expired) {
      await deleteUserSnooze(this.db).run({ userId, sessionId: id })
    }
    return out
  }

  /** Snooze a session for one user. `until` = null → until next message; ISO
   *  string → timed. PER-USER STATE (POD-380) — see the note on {@link listPins}. */
  async setSnooze(userId: UserId, sessionId: SessionId, until: string | null): Promise<void> {
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
  async clearSnooze(userId: UserId, sessionId: SessionId): Promise<void> {
    await deleteUserSnooze(this.db).run({ userId, sessionId: asSessionId(sessionId.trim()) })
  }

  async hasAnySnooze(sessionId: SessionId): Promise<boolean> {
    return (
      (await anySnoozeOf(this.db).get({ sessionId: asSessionId(sessionId.trim()) })) !== undefined
    )
  }

  /** Clear every viewer's independent snooze after a shared session event. */
  async clearAllSnoozes(sessionId: SessionId): Promise<UserId[]> {
    const cleared = await deleteAllSnoozesOf(this.db).all({
      sessionId: asSessionId(sessionId.trim()),
    })
    return cleared.map((row) => row.userId)
  }

  // ---- agent action offers [spec:SP-c7f1] ----
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
  async setOffer(sessionId: SessionId, offer: OfferRecord): Promise<void> {
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
  async clearOffer(sessionId: SessionId): Promise<void> {
    await deleteOfferOf(this.db).run({ id: asSessionId(sessionId.trim()) })
  }

  // ---- tab order ----
  /** Manual tab order per worktree path. Worktrees never reordered are absent. */
  async listTabOrders(userId: UserId): Promise<Record<string, string[]>> {
    const rows = await tabOrdersOfUser(this.db).all({ userId })
    const out: Record<string, string[]> = {}
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.ids)
        if (Array.isArray(parsed)) out[row.worktree] = parsed.filter((x) => typeof x === 'string')
      } catch {
        // corrupt row -> treat as no saved order
      }
    }
    return out
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
      let ids: string[]
      try {
        const parsed = JSON.parse(row.ids)
        if (!Array.isArray(parsed)) continue
        ids = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        continue // corrupt row -> nothing to scrub
      }
      if (!ids.includes(sessionId)) continue
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
    geometry: {
      cols: Number.isInteger(r.terminalCols) && r.terminalCols > 0 ? r.terminalCols : 80,
      rows: Number.isInteger(r.terminalRows) && r.terminalRows > 0 ? r.terminalRows : 24,
    },
    ...(r.workingMsTotal != null ? { workingMsTotal: r.workingMsTotal } : {}),
    ...(r.inputCount > 0 ? { inputCount: r.inputCount } : {}),
    ...(r.outputCount > 0 ? { outputCount: r.outputCount } : {}),
    ...(r.activityCount > 0 ? { activityCount: r.activityCount } : {}),
    archived: r.archived,
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
