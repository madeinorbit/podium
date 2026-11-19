// workspace-scoped (POD-6959)
import {
  asMachineId,
  ConversationRecordWire,
  type MachineId,
  machinePathKey,
  machinePathSeparator,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  or,
  type Placeholder,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { conversations } from '../../migrations/schema'
import { captureWrite } from '../../sync/capture-pg'
import { dialectOf } from '../executor/dialect-prepared'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from '../executor/sync-drizzle'
import {
  executeRaw,
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from '../executor/sync-drizzle'
import { withoutNul } from '../messages'
import type { ConversationIndexRow } from '../types'
import { conversationMatches, onSqliteOnly, tsqueryOf } from './search-pg'

const recordColumns = (t: StoreTables) => ({
  ...getTableColumns(t.conversations),
  podiumId: t.conversationSegments.podiumId,
})
/** The segment of a conversation row, in the conversation's workspace. */
const segmentOf = (t: StoreTables) =>
  and(
    sameWorkspace(t.conversationSegments, t.conversations),
    eq(t.conversationSegments.machineId, t.conversations.machineId),
    eq(t.conversationSegments.nativeId, t.conversations.id),
  )
const recordRows = preparedFamily((db, t, size: number) =>
  db
    .select(recordColumns(t))
    .from(t.conversations)
    .leftJoin(t.conversationSegments, segmentOf(t))
    .where(inWorkspace(t.conversations, inListOf(t.conversations.id, size)))
    .prepare(),
)
const recordPage = preparedFamily((db, t, phase: 'start' | 'after') =>
  db
    .select(recordColumns(t))
    .from(t.conversations)
    .leftJoin(t.conversationSegments, segmentOf(t))
    .where(
      inWorkspace(
        t.conversations,
        phase === 'after' ? gt(t.conversations.id, param(t.conversations.id, 'after')) : undefined,
      ),
    )
    .orderBy(asc(t.conversations.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)
/** The synced record of one index row. `updatedAt` and `messageCount` stay in
 *  the index for recency and search, never on the record (POD-6768). */
function conversationRecordOf(
  row: typeof conversations.$inferSelect & { podiumId: string | null },
): ConversationRecordWire {
  const {
    resumeKind,
    resumeValue,
    // The workspace is the repository's, never a record field.
    workspaceId: _workspaceId,
    updatedAt: _updatedAt,
    messageCount: _messageCount,
    ...fields
  } = row
  return ConversationRecordWire.parse({
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)),
    ...(resumeKind !== null && resumeValue !== null
      ? { resume: { kind: resumeKind, value: resumeValue } }
      : {}),
  })
}

/**
 * The workspace as an INSERT ... SELECT item, BARE: the insert names its columns
 * by the select's keys, so the item needs no alias, and the workspace-scope audit
 * reads a bare placeholder as the workspace (it does not read through
 * `? AS "workspace_id"`). Drizzle's types ask every select item for an alias;
 * the cast says this one needs none.
 */
const workspaceItem = sql`${WORKSPACE}` as unknown as SQL.Aliased<unknown>

// Every query this repository runs, prepared once per store [POD-6147].

/**
 * Upsert every conversation of the bound JSON array `rows` in one statement
 * [POD-6227]: a discovery re-offers a machine's whole corpus, and one upsert
 * per row ran one statement per conversation.
 *
 * ON POSTGRES the array is read with `json_array_elements`, and each field
 * with `->>`, which gives text there (SQLite's gives the JSON value's own
 * type), so a number or timestamp field is cast to its column's type. A
 * comparison of a value that may be NULL is `IS DISTINCT FROM`, Postgres's
 * spelling of SQLite's `IS NOT`. A row offered twice in one array is folded
 * into one before the statement on Postgres ({@link foldOffers}), which
 * refuses an upsert that reaches the same row twice.
 */
const upsertConversations = prepared((db, t) => {
  const pg = dialectOf(db) === 'pg'
  const field = (name: string, type?: 'bigint' | 'timestamptz') =>
    sql.raw(
      !pg
        ? `value ->> '$.${name}'`
        : type === undefined
          ? `(value ->> '${name}')`
          : `CAST(value ->> '${name}' AS ${type})`,
    )
  const offered = pg
    ? sql`json_array_elements(CAST(${sql.placeholder('rows')} AS json)) AS r(value)`
    : sql`json_each(${sql.placeholder('rows')})`
  const isNot = sql.raw(pg ? 'IS DISTINCT FROM' : 'IS NOT')
  return captureWrite(
    db
      .insert(t.conversations)
      .select(
        db
          .select({
            workspaceId: workspaceItem,
            id: sql`${field('id')}`.as('id'),
            agentKind: sql`${field('agentKind')}`.as('agent_kind'),
            title: sql`${field('title')}`.as('title'),
            projectPath: sql`${field('projectPath')}`.as('project_path'),
            providerId: sql`${field('providerId')}`.as('provider_id'),
            resumeKind: sql`${field('resumeKind')}`.as('resume_kind'),
            resumeValue: sql`${field('resumeValue')}`.as('resume_value'),
            createdAt: sql`${field('createdAt', 'timestamptz')}`.as('created_at'),
            updatedAt: sql`${field('updatedAt', 'timestamptz')}`.as('updated_at'),
            messageCount: sql`${field('messageCount', 'bigint')}`.as('message_count'),
            machineId: sql`${field('machineId')}`.as('machine_id'),
            parentConversationId: sql`${field('parentConversationId')}`.as(
              'parent_conversation_id',
            ),
          })
          .from(offered)
          // An INSERT ... SELECT with an upsert clause needs a WHERE, or SQLite
          // reads ON CONFLICT as a join constraint of the SELECT.
          .where(sql`true`),
      )
      .onConflictDoUpdate({
        target: [t.conversations.workspaceId, t.conversations.id],
        set: {
          agentKind: sql`excluded.agent_kind`,
          providerId: sql`excluded.provider_id`,
          machineId: sql`excluded.machine_id`,
          title: sql`COALESCE(excluded.title,${t.conversations.title})`,
          projectPath: sql`COALESCE(excluded.project_path,${t.conversations.projectPath})`,
          resumeKind: sql`COALESCE(excluded.resume_kind,${t.conversations.resumeKind})`,
          resumeValue: sql`COALESCE(excluded.resume_value,${t.conversations.resumeValue})`,
          createdAt: sql`COALESCE(excluded.created_at,${t.conversations.createdAt})`,
          updatedAt: sql`COALESCE(excluded.updated_at,${t.conversations.updatedAt})`,
          messageCount: sql`COALESCE(excluded.message_count,${t.conversations.messageCount})`,
          parentConversationId: sql`COALESCE(excluded.parent_conversation_id,${t.conversations.parentConversationId})`,
        },
        // THE GUARD IS THE EXACT NEGATION OF THE SET LIST — each column
        // compared against the effective value the SET would assign, `IS NOT`
        // so NULL compares like any other value. A row that would change
        // still changes; only a write with nothing to say is skipped.
        setWhere: sql`${t.conversations.agentKind} ${isNot} excluded.agent_kind
         OR ${t.conversations.providerId} ${isNot} excluded.provider_id
         OR ${t.conversations.machineId} ${isNot} excluded.machine_id
         OR ${t.conversations.title} ${isNot} COALESCE(excluded.title,${t.conversations.title})
         OR ${t.conversations.projectPath} ${isNot} COALESCE(excluded.project_path,${t.conversations.projectPath})
         OR ${t.conversations.resumeKind} ${isNot} COALESCE(excluded.resume_kind,${t.conversations.resumeKind})
         OR ${t.conversations.resumeValue} ${isNot} COALESCE(excluded.resume_value,${t.conversations.resumeValue})
         OR ${t.conversations.createdAt} ${isNot} COALESCE(excluded.created_at,${t.conversations.createdAt})
         OR ${t.conversations.updatedAt} ${isNot} COALESCE(excluded.updated_at,${t.conversations.updatedAt})
         OR ${t.conversations.messageCount} ${isNot} COALESCE(excluded.message_count,${t.conversations.messageCount})
         OR ${t.conversations.parentConversationId} ${isNot} COALESCE(excluded.parent_conversation_id,${t.conversations.parentConversationId})`,
      }),
  ).prepare()
})

// The FTS5 index and the three triggers that keep it fed, in the order the
// original script had (see `enableFts`). SQLite only: on Postgres each is the
// check that the GIN index the baseline made is there (`onSqliteOnly`),
// and `enableFts` runs only the first.
const SEARCH_INDEX = 'idx_conversations_search'
const sqliteOnly = (db: StoreDrizzle, statement: SQL): SQL =>
  onSqliteOnly(db, SEARCH_INDEX, statement)
const createFtsTable = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title, name, summary, project_path, content='conversations', content_rowid='rowid')`,
    ),
  ),
)
const createFtsInsertTrigger = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`,
    ),
  ),
)
const createFtsDeleteTrigger = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path); END`,
    ),
  ),
)
const createFtsUpdateTrigger = prepared((db) =>
  db.run(
    sqliteOnly(
      db,
      sql`CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path);
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`,
    ),
  ),
)
const rebuildFts = prepared((db) =>
  db.run(sqliteOnly(db, sql`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`)),
)
const dropFtsInsertTrigger = prepared((db) =>
  db.run(sqliteOnly(db, sql`DROP TRIGGER IF EXISTS conversations_ai`)),
)
const dropFtsDeleteTrigger = prepared((db) =>
  db.run(sqliteOnly(db, sql`DROP TRIGGER IF EXISTS conversations_ad`)),
)
const dropFtsUpdateTrigger = prepared((db) =>
  db.run(sqliteOnly(db, sql`DROP TRIGGER IF EXISTS conversations_au`)),
)

/**
 * The ids are ONE bound JSON array parameter, `ids`, so the statement has one
 * shape: read with json_each on SQLite, json_array_elements_text on Postgres.
 */
const deleteMachineConversations = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.conversations)
      .where(
        inWorkspace(
          t.conversations,
          eq(t.conversations.machineId, param(t.conversations.machineId, 'machineId')),
          dialectOf(db) === 'pg'
            ? sql`${t.conversations.id} IN (SELECT j.value COLLATE "C" FROM json_array_elements_text(CAST(${sql.placeholder('ids')} AS json)) AS j(value))`
            : sql`${t.conversations.id} in (select value from json_each(${sql.placeholder('ids')}))`,
        ),
      )
      .returning({ id: t.conversations.id }),
  ).prepare(),
)

/** The curated names and summaries of the conversations asked for, by primary key (POD-6172). */
const curatedConversationsOf = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.conversations.id,
      name: t.conversations.name,
      summary: t.conversations.summary,
    })
    .from(t.conversations)
    .where(
      inWorkspace(
        t.conversations,
        inListOf(t.conversations.id, size),
        or(isNotNull(t.conversations.name), isNotNull(t.conversations.summary)),
      ),
    )
    .prepare(),
)

const conversationPresent = prepared((db, t) =>
  db
    .select({ one: sql<number>`1` })
    .from(t.conversations)
    .where(inWorkspace(t.conversations, eq(t.conversations.id, param(t.conversations.id, 'id'))))
    .prepare(),
)

const setConversationName = prepared((db, t) =>
  captureWrite(
    db
      .update(t.conversations)
      .set({ name: sql.placeholder('name') })
      .where(inWorkspace(t.conversations, eq(t.conversations.id, param(t.conversations.id, 'id')))),
  ).prepare(),
)

const setConversationSummary = prepared((db, t) =>
  captureWrite(
    db
      .update(t.conversations)
      .set({ summary: sql.placeholder('summary') })
      .where(inWorkspace(t.conversations, eq(t.conversations.id, param(t.conversations.id, 'id')))),
  ).prepare(),
)

/** How a conversation read filters the project path. */
type PathShape = 'any' | 'posix' | 'windows'

/** How a search matches and how it filters the project path. */
type SearchShape = `${'fts' | 'like'}|${PathShape}`

/**
 * The project path filter. Every value is a bound placeholder: `projectPath` /
 * `projectPathPrefix` for posix, `machineKey` / `prefixLength` / `prefix` for
 * windows.
 *
 * ON POSTGRES the lowered path is compared in byte order (`COLLATE "C"`, design
 * 2.3 rule 13), and `lower()` of the `COLLATE "C"` column folds ASCII only, as
 * SQLite's does. SQLite's LIKE ignores ASCII case and has no escape character;
 * Postgres's LIKE does neither, so there it is `ILIKE ... ESCAPE ''`, which under
 * `COLLATE "C"` folds ASCII only too ({@link likeOf}).
 */
const machinePathFilter = (db: StoreDrizzle, path: string): SQL => {
  const pg = dialectOf(db) === 'pg'
  const collateC = sql.raw(pg ? ' COLLATE "C"' : '')
  const comparablePath = sql`lower(replace(c.project_path, '/', ${'\\'}))${collateC}`
  return path === 'windows'
    ? sql` AND (${comparablePath} = ${sql.placeholder('machineKey')} OR substr(${comparablePath}, 1, ${sql.placeholder('prefixLength')})${collateC} = ${sql.placeholder('prefix')})`
    : path === 'posix'
      ? sql` AND (c.project_path=${sql.placeholder('projectPath')} OR ${likeOf(db, sql`c.project_path`, sql.placeholder('projectPathPrefix'))})`
      : sql``
}

/** `text LIKE pattern` as SQLite reads it: ASCII case ignored, no escape character. */
const likeOf = (db: StoreDrizzle, text: SQL, pattern: SQL | Placeholder): SQL =>
  dialectOf(db) === 'pg' ? sql`${text} ILIKE ${pattern} ESCAPE ''` : sql`${text} LIKE ${pattern}`

/** The bound values of {@link machinePathFilter} for a requested project path. */
function pathFilterOf(projectPath: string | undefined): {
  path: PathShape
  values: Record<string, unknown>
} {
  const machineKey = projectPath ? machinePathKey(projectPath) : undefined
  if (machineKey && machinePathSeparator(machineKey) === '\\') {
    const prefix = machineKey + (machineKey.endsWith('\\') ? '' : '\\')
    return { path: 'windows', values: { machineKey, prefixLength: prefix.length, prefix } }
  }
  return projectPath
    ? { path: 'posix', values: { projectPath, projectPathPrefix: `${projectPath}/%` } }
    : { path: 'any', values: {} }
}

const topLevel = sql` AND c.parent_conversation_id IS NULL`

/** How a page of the recent conversations reads: the ones with an `updated_at`
 *  (newest first), or, after them, the ones without. */
type RecentShape = `${'dated' | 'undated'}|${PathShape}`

/**
 * One keyset page of the top-level conversations, newest first, through
 * `idx_conversations_top_level_updated` (POD-6209). `dated` reads the rows
 * before the cursor's `(updated_at, id)`; `undated` reads the rows with no
 * `updated_at` (which sort last) before the cursor's `id`.
 */
const recentConversations = preparedFamily((db, _t, shape: RecentShape) => {
  const [phase, path] = shape.split('|')
  const filter = machinePathFilter(db, path!)
  const limit = sql` LIMIT ${sql.placeholder('limit')}`
  return phase === 'dated'
    ? db.all<Record<string, unknown>>(
        sql`SELECT c.* FROM conversations c
          WHERE c.workspace_id = ${WORKSPACE} AND (c.updated_at, c.id) < (${sql.placeholder('beforeUpdatedAt')}, ${sql.placeholder('beforeId')})${filter}${topLevel}
          ORDER BY c.updated_at DESC, c.id DESC${limit}`,
      )
    : db.all<Record<string, unknown>>(
        sql`SELECT c.* FROM conversations c
          WHERE c.workspace_id = ${WORKSPACE} AND c.updated_at IS NULL AND c.id < ${sql.placeholder('beforeId')}${filter}${topLevel}
          ORDER BY c.id DESC${limit}`,
      )
})

/** Sorts after every stored `updated_at` and id, so a first page starts at the
 *  newest conversation. */
const RECENT_START = '\uffff'

/**
 * The term search statements, one per {@link SearchShape}: the path filter's
 * values and `fts` or `like` for the match. `fts` is the engine's own query
 * text: an FTS5 MATCH expression on SQLite, a `tsquery` on Postgres, where the
 * match reads the conversation's GIN index (`search-pg.ts`).
 */
const searchConversations = preparedFamily((db, _t, shape: SearchShape) => {
  const [match, path] = shape.split('|')
  const filter = machinePathFilter(db, path!)
  const order = sql` ORDER BY c.updated_at DESC NULLS LAST`
  if (match === 'fts') {
    if (dialectOf(db) === 'pg') {
      return db.all<Record<string, unknown>>(
        sql`SELECT c.* FROM conversations c
        WHERE c.workspace_id = ${WORKSPACE} AND ${conversationMatches()}${filter}${topLevel}${order}`,
      )
    }
    return db.all<Record<string, unknown>>(
      sql`SELECT c.* FROM conversations_fts f JOIN conversations c ON c.rowid=f.rowid
        WHERE c.workspace_id = ${WORKSPACE} AND conversations_fts MATCH ${sql.placeholder('fts')}${filter}${topLevel}${order}`,
    )
  }
  const like = sql.placeholder('like')
  const likes = ['title', 'name', 'summary', 'project_path'].map((column) =>
    likeOf(db, sql.raw(`c.${column}`), like),
  )
  return db.all<Record<string, unknown>>(
    sql`SELECT c.* FROM conversations c WHERE c.workspace_id = ${WORKSPACE} AND
        (${sql.join(likes, sql` OR `)})
        ${filter}${topLevel}${order}`,
  )
})

/** Durable discovered-conversation summaries and their searchable curation. */
export class ConversationIndexRepository {
  private ftsAvailable = false
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  /** Whether this store is on Postgres, whose search index the baseline made (`search-pg.ts`). */
  private readonly pg: boolean
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    this.pg = dialectOf(queries.db.drizzle) === 'pg'
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]: the
   * workspace's handle, which fills `workspaceId` in every statement and routes
   * each to the current transaction.
   */
  private get db(): WorkspaceDb {
    return this.scope
  }

  async recordEntries(
    ids: readonly string[],
  ): Promise<{ machineId: MachineId; value: ConversationRecordWire }[]> {
    if (ids.length === 0) return []
    const size = inListSize(ids.length)
    return (await recordRows(this.db, size).all(inListValues(ids, size))).map((row) => ({
      machineId: row.machineId,
      value: conversationRecordOf(row),
    }))
  }

  async records(ids: readonly string[]): Promise<ConversationRecordWire[]> {
    return (await this.recordEntries(ids)).map(({ value }) => value)
  }

  async *recordPages(pageSize = 500): AsyncGenerator<ConversationRecordWire[]> {
    let after: string | undefined
    for (;;) {
      const rows = await recordPage(this.db, after === undefined ? 'start' : 'after').all({
        after: after ?? '',
        limit: pageSize,
      })
      if (rows.length) yield rows.map(conversationRecordOf)
      if (rows.length < pageSize) return
      after = rows[rows.length - 1]!.id
    }
  }

  /**
   * Create the FTS5 index and the three triggers that keep it fed, then rebuild
   * it from `conversations`. Called at boot only when the `command-palette` flag
   * is on; a build without FTS5 support falls into the catch and leaves
   * `ftsAvailable` false, which the LIKE fallback in `searchCandidates` covers.
   *
   * On Postgres the index is the baseline's GIN index, which Postgres keeps
   * current itself: there is nothing to make or feed, and this checks it is there.
   */
  async enableFts(): Promise<void> {
    try {
      if (this.pg) {
        await executeRaw(createFtsTable(this.db))
        this.ftsAvailable = true
        return
      }
      // ONE STATEMENT PER CALL, where the raw handle took a whole script: the
      // query layer prepares what it is given, so a multi-statement string would
      // run its first statement and silently drop the rest. The order is the one
      // the script had.
      await executeRaw(createFtsTable(this.db))
      await executeRaw(createFtsInsertTrigger(this.db))
      await executeRaw(createFtsDeleteTrigger(this.db))
      await executeRaw(createFtsUpdateTrigger(this.db))
      await executeRaw(rebuildFts(this.db))
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false
    }
  }

  /**
   * Drop the feeding triggers, leaving the virtual table itself in place.
   *
   * The triggers are what cost something when search is off: every insert,
   * update and delete on `conversations` writes fts5 rows (see the `upsert`
   * comment below for the stall that measured). The table is left alone on
   * purpose — dropping it buys nothing, and `conversations_fts` is rebuilt from
   * scratch whenever the flag comes back on.
   *
   * The triggers MUST go before the table could ever be dropped: a trigger whose
   * `INSERT INTO conversations_fts` has no table fails every write to
   * `conversations`.
   *
   * On Postgres there are no triggers: the GIN index costs each write its update
   * whether search is on or off, and search turns into the LIKE fallback.
   */
  async disableFts(): Promise<void> {
    if (this.pg) {
      this.ftsAvailable = false
      return
    }
    await executeRaw(dropFtsInsertTrigger(this.db))
    await executeRaw(dropFtsDeleteTrigger(this.db))
    await executeRaw(dropFtsUpdateTrigger(this.db))
    this.ftsAvailable = false
  }

  /**
   * Discovery re-offers the WHOLE corpus every sweep, so most rows arrive
   * identical to what is already stored. The `DO UPDATE ... WHERE` guard is what
   * makes an unchanged row cost nothing: without it SQLite rewrites the row and
   * fires the `conversations_au` trigger, which is an fts5 delete AND re-insert
   * per row. Measured on the live server (2026-08-12, POD-1931): 1786 of these
   * per 4 minutes writing zero net change, 1650 of them inside a single 757ms
   * event-loop stall.
   *
   * The guard is the exact negation of the SET list — each column compared
   * against the effective value the SET would assign, `IS NOT` so NULL compares
   * like any other value. A row that would change still changes; only a write
   * with nothing to say is skipped.
   */
  async upsert(
    _scope: WriteScope,
    rows: (ConversationIndexRow & { machineId: MachineId })[],
  ): Promise<void> {
    if (rows.length === 0) return
    // One statement for the whole report, in its order: a conversation offered
    // twice is inserted, then updated by its later offer, as one upsert per row did
    // (on Postgres folded into one offer first, with the same result).
    await upsertConversations(this.db).run({
      rows: JSON.stringify(
        (this.pg ? foldOffers(rows) : rows).map((row) => ({
          id: row.id,
          agentKind: row.agentKind,
          // A daemon's text, without U+0000 (POD-6958 design 2.3 rule 9).
          title: row.title === undefined ? null : withoutNul(row.title),
          projectPath: row.projectPath === undefined ? null : withoutNul(row.projectPath),
          providerId: row.providerId,
          resumeKind: row.resumeKind ?? null,
          resumeValue: row.resumeValue ?? null,
          createdAt: row.createdAt ?? null,
          updatedAt: row.updatedAt ?? null,
          messageCount: row.messageCount ?? null,
          machineId: row.machineId,
          parentConversationId: row.parentConversationId ?? null,
        })),
      ),
    })
  }

  /**
   * Delete the conversations `machineId` reports as gone, and ONLY those
   * [POD-4628]. A daemon's `removed` list is a claim about its own disk, so it
   * can never reach a row indexed under another machine: a fresh machine whose
   * copied discovery cache named the original machine's transcripts once
   * deleted all 1960 of them. One statement, the ids bound as one json_each
   * parameter; returns the ids actually deleted, which is what the change log
   * may remove.
   */
  async delete(_scope: WriteScope, machineId: MachineId, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const rows = await deleteMachineConversations(this.db).all({
      machineId,
      ids: JSON.stringify([...new Set(ids)]),
    })
    return rows.map((row) => row.id)
  }

  /** The curated name and summary of each of these conversations that has one. */
  async curatedMetaOf(
    ids: readonly string[],
  ): Promise<Map<string, { name?: string; summary?: string }>> {
    const unique = [...new Set(ids)]
    const rows: { id: string; name: string | null; summary: string | null }[] = []
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      const size = inListSize(chunk.length)
      rows.push(...(await curatedConversationsOf(this.db, size).all(inListValues(chunk, size))))
    }
    return new Map(
      rows.map((row) => [
        row.id,
        {
          ...(row.name != null ? { name: row.name } : {}),
          ...(row.summary != null ? { summary: row.summary } : {}),
        },
      ]),
    )
  }

  async setMeta(
    _scope: WriteScope,
    id: string,
    meta: { name?: string; summary?: string },
  ): Promise<void> {
    const present = await conversationPresent(this.db).get({ id })
    if (!present) {
      throw new Error(
        `conversation ${id} has not been reported by a daemon; metadata cannot be set before discovery`,
      )
    }
    // A curated name or summary is a person's or an agent's text, stored without
    // U+0000 (POD-6958 design 2.3 rule 9).
    if (meta.name !== undefined)
      await setConversationName(this.db).run({ id, name: withoutNul(meta.name) })
    if (meta.summary !== undefined)
      await setConversationSummary(this.db).run({ id, summary: withoutNul(meta.summary) })
  }

  /**
   * Every conversation matching a search term: memory filters before scoring
   * and limiting.
   *
   * WHOLE RAW STATEMENTS, DELIBERATELY, and this file is one of the two the
   * boundary lint names as the SearchIndex port for exactly this reason: `MATCH`
   * is not a builder construct and `conversations_fts` is a virtual table the
   * schema has no model for. What the conversion changed is the ISSUER — they go
   * through the query layer now, and every value is still a bound parameter, so
   * the projectPath filter is a fragment rather than string concatenation.
   */
  async searchCandidates(opts: {
    query: string
    projectPath?: string
  }): Promise<ConversationIndexRow[]> {
    const { path, values } = pathFilterOf(opts.projectPath)
    const query = opts.query.trim()
    let rows: Record<string, unknown>[]
    if (this.ftsAvailable) {
      const fts = this.pg
        ? tsqueryOf(query)
        : query
            .split(/\s+/)
            .filter(Boolean)
            .map((token) => `"${token.replace(/"/g, '""')}"*`)
            .join(' ')
      // A term with no word in it matches nothing, as FTS5 reads it (`search-pg.ts`).
      if (fts === undefined) return []
      rows = await executeRaw(searchConversations(this.db, `fts|${path}`), { ...values, fts })
    } else {
      rows = await executeRaw(searchConversations(this.db, `like|${path}`), {
        ...values,
        like: `%${query}%`,
      })
    }
    return rows.map(toIndexRow)
  }

  /**
   * One keyset page of the top-level conversations, newest first, with no
   * search term (POD-6209): up to `limit` rows after the cursor, which is the
   * last row of the previous page. Rows with no `updated_at` come last, by id.
   */
  async recentPage(opts: {
    projectPath?: string
    after?: ConversationPageCursor
    limit: number
  }): Promise<ConversationIndexRow[]> {
    const { path, values } = pathFilterOf(opts.projectPath)
    const limit = Math.max(1, Math.trunc(opts.limit))
    const rows: Record<string, unknown>[] = []
    if (opts.after?.updatedAt !== null) {
      rows.push(
        ...(await executeRaw(recentConversations(this.db, `dated|${path}`), {
          ...values,
          beforeUpdatedAt: opts.after?.updatedAt ?? RECENT_START,
          beforeId: opts.after?.id ?? RECENT_START,
          limit,
        })),
      )
    }
    if (rows.length < limit) {
      rows.push(
        ...(await executeRaw(recentConversations(this.db, `undated|${path}`), {
          ...values,
          beforeId: opts.after?.updatedAt === null ? opts.after.id : RECENT_START,
          limit: limit - rows.length,
        })),
      )
    }
    return rows.map(toIndexRow)
  }

  async search(opts: {
    query?: string
    projectPath?: string
    limit?: number
  }): Promise<ConversationIndexRow[]> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    const query = opts.query?.trim() ?? ''
    if (!query)
      return await this.recentPage({
        ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
        limit,
      })
    return (await this.searchCandidates({ ...opts, query })).slice(0, limit)
  }
}

/**
 * The rows of one upsert with each id once: a later offer of an id overrides the
 * fields the upsert overwrites and fills the ones it keeps when the offer has
 * none, which is what the upsert does to the row the earlier offer wrote.
 * Postgres refuses an `ON CONFLICT DO UPDATE` that reaches one row twice.
 */
function foldOffers<R extends ConversationIndexRow & { machineId: MachineId }>(
  rows: readonly R[],
): R[] {
  const byId = new Map<string, R>()
  for (const row of rows) {
    const earlier = byId.get(row.id)
    if (earlier === undefined) {
      byId.set(row.id, row)
      continue
    }
    byId.set(row.id, {
      ...earlier,
      agentKind: row.agentKind,
      providerId: row.providerId,
      machineId: row.machineId,
      title: row.title ?? earlier.title,
      projectPath: row.projectPath ?? earlier.projectPath,
      resumeKind: row.resumeKind ?? earlier.resumeKind,
      resumeValue: row.resumeValue ?? earlier.resumeValue,
      createdAt: row.createdAt ?? earlier.createdAt,
      updatedAt: row.updatedAt ?? earlier.updatedAt,
      messageCount: row.messageCount ?? earlier.messageCount,
      parentConversationId: row.parentConversationId ?? earlier.parentConversationId,
    })
  }
  return [...byId.values()]
}

/** A recent-conversations page's keyset cursor: the last row of the previous
 *  page, with `updatedAt` null when that row has none. */
export interface ConversationPageCursor {
  updatedAt: string | null
  id: string
}

// A raw statement returns PHYSICAL column names, so this mapper stays where
// the builder-converted repositories lost theirs. That is the cost of the
// port exemption and it is paid here rather than spread over the file.
function toIndexRow(row: Record<string, unknown>): ConversationIndexRow {
  return {
    id: row.id as string,
    agentKind: row.agent_kind as string,
    providerId: row.provider_id as string,
    title: (row.title as string | null) ?? undefined,
    name: (row.name as string | null) ?? undefined,
    summary: (row.summary as string | null) ?? undefined,
    projectPath: (row.project_path as string | null) ?? undefined,
    resumeKind: (row.resume_kind as string | null) ?? undefined,
    resumeValue: (row.resume_value as string | null) ?? undefined,
    createdAt: (row.created_at as string | null) ?? undefined,
    updatedAt: (row.updated_at as string | null) ?? undefined,
    messageCount: (row.message_count as number | null) ?? undefined,
    // EXTERNAL ROW BRAND DECODE: this search-port statement returns
    // Record<string, unknown>; machine_id is not a schema-inferred value.
    machineId: row.machine_id ? asMachineId(row.machine_id as string) : undefined,
  }
}
