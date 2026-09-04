import { asMachineId, type MachineId } from '@podium/model'
import { eq, isNotNull, or, sql } from 'drizzle-orm'
import { conversations } from '../../migrations/schema'
import type { SyncDrizzle, SyncQueries } from '../executor/sync-drizzle'
import type { ConversationIndexRow } from '../types'

/** Durable discovered-conversation summaries and their searchable curation. */
export class ConversationIndexRepository {
  private ftsAvailable = false
  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]. B1
   * fills this same slot with the asynchronous pair, so the flip is `async`,
   * `await` and the return type and no query body moves.
   */
  private readonly db: SyncDrizzle
  private readonly transact: SyncQueries['transact']

  constructor(
    queries: SyncQueries,
    /** This host's minted machine id — the machine a row this repository has to
     *  CONJURE belongs to. See {@link setMeta}. */
    private readonly hostMachineId: MachineId,
  ) {
    this.db = queries.db
    this.transact = queries.transact
  }

  /**
   * Create the FTS5 index and the three triggers that keep it fed, then rebuild
   * it from `conversations`. Called at boot only when the `command-palette` flag
   * is on; a build without FTS5 support falls into the catch and leaves
   * `ftsAvailable` false, which the LIKE fallback in `searchCandidates` covers.
   */
  enableFts(): void {
    try {
      // ONE STATEMENT PER CALL, where the raw handle took a whole script: the
      // query layer prepares what it is given, so a multi-statement string would
      // run its first statement and silently drop the rest. The order is the one
      // the script had.
      this.db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title, name, summary, project_path, content='conversations', content_rowid='rowid')`)
      this.db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`)
      this.db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path); END`)
      this.db.run(sql`CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path);
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END`)
      this.db.run(sql`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`)
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
  disableFts(): void {
    this.db.run(sql`DROP TRIGGER IF EXISTS conversations_ai`)
    this.db.run(sql`DROP TRIGGER IF EXISTS conversations_ad`)
    this.db.run(sql`DROP TRIGGER IF EXISTS conversations_au`)
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
  upsert(rows: (ConversationIndexRow & { machineId: MachineId })[]): void {
    if (rows.length === 0) return
    this.transact(() => {
      for (const row of rows) {
        this.db
          .insert(conversations)
          .values({
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
          })
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
          .run()
      }
    })
  }

  delete(ids: string[]): void {
    if (ids.length === 0) return
    this.transact(() => {
      for (const id of ids) this.db.delete(conversations).where(eq(conversations.id, id)).run()
    })
  }

  curatedMeta(): Map<string, { name?: string; summary?: string }> {
    const rows = this.db
      .select({ id: conversations.id, name: conversations.name, summary: conversations.summary })
      .from(conversations)
      .where(or(isNotNull(conversations.name), isNotNull(conversations.summary)))
      .all()
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

  setMeta(id: string, meta: { name?: string; summary?: string }): void {
    const present = this.db
      .select({ one: sql<number>`1` })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get()
    if (!present) {
      // Curating a conversation nobody has discovered yet CREATES the row, and
      // since POD-318 the machine column has no default to manufacture one — so
      // this names the host, which is where a local curation act happens. It used
      // to lean on the `'__local__'` default, silently.
      this.db
        .insert(conversations)
        .values({
          id,
          agentKind: 'claude-code',
          providerId: 'unknown',
          machineId: this.hostMachineId,
        })
        .run()
    }
    if (meta.name !== undefined)
      this.db.update(conversations).set({ name: meta.name }).where(eq(conversations.id, id)).run()
    if (meta.summary !== undefined)
      this.db
        .update(conversations)
        .set({ summary: meta.summary })
        .where(eq(conversations.id, id))
        .run()
  }

  /**
   * Complete candidates: memory filters before scoring and limiting.
   *
   * WHOLE RAW STATEMENTS, DELIBERATELY, and this file is one of the two the
   * boundary lint names as the SearchIndex port for exactly this reason: `MATCH`
   * is not a builder construct and `conversations_fts` is a virtual table the
   * schema has no model for. What the conversion changed is the ISSUER — they go
   * through the query layer now, and every value is still a bound parameter, so
   * the projectPath filter is a fragment rather than string concatenation.
   */
  searchCandidates(opts: { query?: string; projectPath?: string }): ConversationIndexRow[] {
    const pathFilter = opts.projectPath
      ? sql` AND (c.project_path=${opts.projectPath} OR c.project_path LIKE ${`${opts.projectPath}/%`})`
      : sql``
    const topLevel = sql` AND c.parent_conversation_id IS NULL`
    const order = sql` ORDER BY c.updated_at DESC NULLS LAST`
    const query = opts.query?.trim() ?? ''
    let rows: Record<string, unknown>[]
    if (!query) {
      rows = this.db.all(
        sql`SELECT c.* FROM conversations c WHERE 1=1${pathFilter}${topLevel}${order}`,
      )
    } else if (this.ftsAvailable) {
      const fts = query
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => `"${token.replace(/"/g, '""')}"*`)
        .join(' ')
      rows = this.db.all(
        sql`SELECT c.* FROM conversations_fts f JOIN conversations c ON c.rowid=f.rowid
        WHERE conversations_fts MATCH ${fts}${pathFilter}${topLevel}${order}`,
      )
    } else {
      const like = `%${query}%`
      rows = this.db.all(
        sql`SELECT c.* FROM conversations c WHERE
        (c.title LIKE ${like} OR c.name LIKE ${like} OR c.summary LIKE ${like} OR c.project_path LIKE ${like})
        ${pathFilter}${topLevel}${order}`,
      )
    }
    // A raw statement returns PHYSICAL column names, so this mapper stays where
    // the builder-converted repositories lost theirs. That is the cost of the
    // port exemption and it is paid here rather than spread over the file.
    return rows.map((row) => ({
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
      machineId: row.machine_id ? asMachineId(row.machine_id as string) : undefined,
    }))
  }

  search(opts: { query?: string; projectPath?: string; limit?: number }): ConversationIndexRow[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    return this.searchCandidates(opts).slice(0, limit)
  }
}
