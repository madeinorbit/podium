import { asMachineId, type MachineId, machinePathKey, machinePathSeparator } from '@podium/model'
import { and, eq, isNotNull, or, type SQL, sql } from 'drizzle-orm'
import { conversations } from '../../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from '../executor/sync-drizzle'
import { executeRaw, inListOf, inListSize, inListValues, param, prepared, preparedFamily } from '../executor/sync-drizzle'
import type { ConversationIndexRow } from '../types'

// Every query this repository runs, prepared once per store [POD-6147].

/**
 * Upsert every conversation of the bound JSON array `rows` in one statement
 * [POD-6227]: a discovery re-offers a machine's whole corpus, and one upsert
 * per row ran one statement per conversation.
 */
const upsertConversations = prepared((db: StoreDrizzle) => {
  const field = (name: string) => sql.raw(`value ->> '$.${name}'`)
  return db
    .insert(conversations)
    .select(
      db
        .select({
          id: sql`${field('id')}`.as('id'),
          agentKind: sql`${field('agentKind')}`.as('agent_kind'),
          title: sql`${field('title')}`.as('title'),
          projectPath: sql`${field('projectPath')}`.as('project_path'),
          providerId: sql`${field('providerId')}`.as('provider_id'),
          resumeKind: sql`${field('resumeKind')}`.as('resume_kind'),
          resumeValue: sql`${field('resumeValue')}`.as('resume_value'),
          createdAt: sql`${field('createdAt')}`.as('created_at'),
          updatedAt: sql`${field('updatedAt')}`.as('updated_at'),
          messageCount: sql`${field('messageCount')}`.as('message_count'),
          machineId: sql`${field('machineId')}`.as('machine_id'),
          parentConversationId: sql`${field('parentConversationId')}`.as('parent_conversation_id'),
        })
        .from(sql`json_each(${sql.placeholder('rows')})`)
        // An INSERT ... SELECT with an upsert clause needs a WHERE, or SQLite
        // reads ON CONFLICT as a join constraint of the SELECT.
        .where(sql`true`),
    )
    .onConflictDoUpdate({
      target: conversations.id,
      set: {
        agentKind: sql`excluded.agent_kind`,
        providerId: sql`excluded.provider_id`,
        machineId: sql`excluded.machine_id`,
        title: sql`COALESCE(excluded.title,${conversations.title})`,
        projectPath: sql`COALESCE(excluded.project_path,${conversations.projectPath})`,
        resumeKind: sql`COALESCE(excluded.resume_kind,${conversations.resumeKind})`,
        resumeValue: sql`COALESCE(excluded.resume_value,${conversations.resumeValue})`,
        createdAt: sql`COALESCE(excluded.created_at,${conversations.createdAt})`,
        updatedAt: sql`COALESCE(excluded.updated_at,${conversations.updatedAt})`,
        messageCount: sql`COALESCE(excluded.message_count,${conversations.messageCount})`,
        parentConversationId: sql`COALESCE(excluded.parent_conversation_id,${conversations.parentConversationId})`,
      },
      // THE GUARD IS THE EXACT NEGATION OF THE SET LIST — each column
      // compared against the effective value the SET would assign, `IS NOT`
      // so NULL compares like any other value. A row that would change
      // still changes; only a write with nothing to say is skipped.
      setWhere: sql`${conversations.agentKind} IS NOT excluded.agent_kind
         OR ${conversations.providerId} IS NOT excluded.provider_id
         OR ${conversations.machineId} IS NOT excluded.machine_id
         OR ${conversations.title} IS NOT COALESCE(excluded.title,${conversations.title})
         OR ${conversations.projectPath} IS NOT COALESCE(excluded.project_path,${conversations.projectPath})
         OR ${conversations.resumeKind} IS NOT COALESCE(excluded.resume_kind,${conversations.resumeKind})
         OR ${conversations.resumeValue} IS NOT COALESCE(excluded.resume_value,${conversations.resumeValue})
         OR ${conversations.createdAt} IS NOT COALESCE(excluded.created_at,${conversations.createdAt})
         OR ${conversations.updatedAt} IS NOT COALESCE(excluded.updated_at,${conversations.updatedAt})
         OR ${conversations.messageCount} IS NOT COALESCE(excluded.message_count,${conversations.messageCount})
         OR ${conversations.parentConversationId} IS NOT COALESCE(excluded.parent_conversation_id,${conversations.parentConversationId})`,
    })
    .prepare()
})

// The FTS5 index and the three triggers that keep it fed, in the order the
// original script had (see `enableFts`).
const createFtsTable = prepared((db: StoreDrizzle) =>
  db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title, name, summary, project_path, content='conversations', content_rowid='rowid')`),
)
const createFtsInsertTrigger = prepared((db: StoreDrizzle) =>
  db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`),
)
const createFtsDeleteTrigger = prepared((db: StoreDrizzle) =>
  db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path); END`),
)
const createFtsUpdateTrigger = prepared((db: StoreDrizzle) =>
  db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path);
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`),
)
const rebuildFts = prepared((db: StoreDrizzle) =>
  db.run(sql`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`),
)
const dropFtsInsertTrigger = prepared((db: StoreDrizzle) => db.run(sql`DROP TRIGGER IF EXISTS conversations_ai`))
const dropFtsDeleteTrigger = prepared((db: StoreDrizzle) => db.run(sql`DROP TRIGGER IF EXISTS conversations_ad`))
const dropFtsUpdateTrigger = prepared((db: StoreDrizzle) => db.run(sql`DROP TRIGGER IF EXISTS conversations_au`))

/** The ids are ONE bound json_each parameter, `ids`, so the statement has one shape. */
const deleteMachineConversations = prepared((db: StoreDrizzle) =>
  db
    .delete(conversations)
    .where(
      and(
        eq(conversations.machineId, param(conversations.machineId, 'machineId')),
        sql`${conversations.id} in (select value from json_each(${sql.placeholder('ids')}))`,
      ),
    )
    .returning({ id: conversations.id })
    .prepare(),
)

/** The curated names and summaries of the conversations asked for, by primary key (POD-6172). */
const curatedConversationsOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ id: conversations.id, name: conversations.name, summary: conversations.summary })
    .from(conversations)
    .where(and(inListOf(conversations.id, size), or(isNotNull(conversations.name), isNotNull(conversations.summary))))
    .prepare(),
)

const conversationPresent = prepared((db: StoreDrizzle) =>
  db
    .select({ one: sql<number>`1` })
    .from(conversations)
    .where(eq(conversations.id, param(conversations.id, 'id')))
    .prepare(),
)

const setConversationName = prepared((db: StoreDrizzle) =>
  db
    .update(conversations)
    .set({ name: sql.placeholder('name') })
    .where(eq(conversations.id, param(conversations.id, 'id')))
    .prepare(),
)

const setConversationSummary = prepared((db: StoreDrizzle) =>
  db
    .update(conversations)
    .set({ summary: sql.placeholder('summary') })
    .where(eq(conversations.id, param(conversations.id, 'id')))
    .prepare(),
)

/** How a conversation read filters the project path. */
type PathShape = 'any' | 'posix' | 'windows'

/** How a search matches and how it filters the project path. */
type SearchShape = `${'fts' | 'like'}|${PathShape}`

/**
 * The project path filter. Every value is a bound placeholder: `projectPath` /
 * `projectPathPrefix` for posix, `machineKey` / `prefixLength` / `prefix` for
 * windows.
 */
const machinePathFilter = (path: string): SQL => {
  const comparablePath = sql`lower(replace(c.project_path, '/', ${'\\'}))`
  return path === 'windows'
    ? sql` AND (${comparablePath} = ${sql.placeholder('machineKey')} OR substr(${comparablePath}, 1, ${sql.placeholder('prefixLength')}) = ${sql.placeholder('prefix')})`
    : path === 'posix'
      ? sql` AND (c.project_path=${sql.placeholder('projectPath')} OR c.project_path LIKE ${sql.placeholder('projectPathPrefix')})`
      : sql``
}

/** The bound values of {@link machinePathFilter} for a requested project path. */
function pathFilterOf(projectPath: string | undefined): { path: PathShape; values: Record<string, unknown> } {
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
const recentConversations = preparedFamily((db: StoreDrizzle, shape: RecentShape) => {
  const [phase, path] = shape.split('|')
  const filter = machinePathFilter(path!)
  const limit = sql` LIMIT ${sql.placeholder('limit')}`
  return phase === 'dated'
    ? db.all<Record<string, unknown>>(
        sql`SELECT c.* FROM conversations c
          WHERE (c.updated_at, c.id) < (${sql.placeholder('beforeUpdatedAt')}, ${sql.placeholder('beforeId')})${filter}${topLevel}
          ORDER BY c.updated_at DESC, c.id DESC${limit}`,
      )
    : db.all<Record<string, unknown>>(
        sql`SELECT c.* FROM conversations c
          WHERE c.updated_at IS NULL AND c.id < ${sql.placeholder('beforeId')}${filter}${topLevel}
          ORDER BY c.id DESC${limit}`,
      )
})

/** Sorts after every stored `updated_at` and id, so a first page starts at the
 *  newest conversation. */
const RECENT_START = '\uffff'

/**
 * The term search statements, one per {@link SearchShape}: the path filter's
 * values and `fts` or `like` for the match.
 */
const searchConversations = preparedFamily((db: StoreDrizzle, shape: SearchShape) => {
  const [match, path] = shape.split('|')
  const filter = machinePathFilter(path!)
  const order = sql` ORDER BY c.updated_at DESC NULLS LAST`
  if (match === 'fts') {
    return db.all<Record<string, unknown>>(
      sql`SELECT c.* FROM conversations_fts f JOIN conversations c ON c.rowid=f.rowid
        WHERE conversations_fts MATCH ${sql.placeholder('fts')}${filter}${topLevel}${order}`,
    )
  }
  const like = sql.placeholder('like')
  return db.all<Record<string, unknown>>(
    sql`SELECT c.* FROM conversations c WHERE
        (c.title LIKE ${like} OR c.name LIKE ${like} OR c.summary LIKE ${like} OR c.project_path LIKE ${like})
        ${filter}${topLevel}${order}`,
  )
})

/** Durable discovered-conversation summaries and their searchable curation. */
export class ConversationIndexRepository {
  private ftsAvailable = false
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner
  constructor(
    queries: StoreQueries,
  ) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]: the
   * store's one drizzle instance, whose executor routes each statement to the
   * current transaction.
   */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  /**
   * Create the FTS5 index and the three triggers that keep it fed, then rebuild
   * it from `conversations`. Called at boot only when the `command-palette` flag
   * is on; a build without FTS5 support falls into the catch and leaves
   * `ftsAvailable` false, which the LIKE fallback in `searchCandidates` covers.
   */
  async enableFts(): Promise<void> {
    try {
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
   */
  async disableFts(): Promise<void> {
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
  async upsert(rows: (ConversationIndexRow & { machineId: MachineId })[]): Promise<void> {
    if (rows.length === 0) return
    // One statement for the whole report, in its order: a conversation offered
    // twice is inserted, then updated by its later offer, as one upsert per row did.
    await upsertConversations(this.db).run({
      rows: JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          agentKind: row.agentKind,
          title: row.title ?? null,
          projectPath: row.projectPath ?? null,
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
  async delete(machineId: MachineId, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const rows = await deleteMachineConversations(this.db).all({
      machineId,
      ids: JSON.stringify([...new Set(ids)]),
    })
    return rows.map((row) => row.id)
  }

  /** The curated name and summary of each of these conversations that has one. */
  async curatedMetaOf(ids: readonly string[]): Promise<Map<string, { name?: string; summary?: string }>> {
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

  async setMeta(id: string, meta: { name?: string; summary?: string }): Promise<void> {
    const present = await conversationPresent(this.db).get({ id })
    if (!present) {
      throw new Error(`conversation ${id} has not been reported by a daemon; metadata cannot be set before discovery`)
    }
    if (meta.name !== undefined) await setConversationName(this.db).run({ id, name: meta.name })
    if (meta.summary !== undefined) await setConversationSummary(this.db).run({ id, summary: meta.summary })
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
  async searchCandidates(opts: { query: string; projectPath?: string }): Promise<ConversationIndexRow[]> {
    const { path, values } = pathFilterOf(opts.projectPath)
    const query = opts.query.trim()
    let rows: Record<string, unknown>[]
    if (this.ftsAvailable) {
      const fts = query
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => `"${token.replace(/"/g, '""')}"*`)
        .join(' ')
      rows = await executeRaw(searchConversations(this.db, `fts|${path}`), { ...values, fts })
    } else {
      rows = await executeRaw(searchConversations(this.db, `like|${path}`), { ...values, like: `%${query}%` })
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

  async search(opts: { query?: string; projectPath?: string; limit?: number }): Promise<ConversationIndexRow[]> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    const query = opts.query?.trim() ?? ''
    if (!query) return await this.recentPage({ ...(opts.projectPath ? { projectPath: opts.projectPath } : {}), limit })
    return (await this.searchCandidates({ ...opts, query })).slice(0, limit)
  }
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
