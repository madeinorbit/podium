import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import type { ConversationIndexRow } from '../types'

/** Durable discovered-conversation summaries and their searchable curation. */
export class ConversationIndexRepository {
  private ftsAvailable = false
  constructor(
    private readonly db: SqlDatabase,
    /** This host's minted machine id — the machine a row this repository has to
     *  CONJURE belongs to. See {@link setMeta}. */
    private readonly hostMachineId: string,
  ) {}

  ensureFts(): void {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title, name, summary, project_path, content='conversations', content_rowid='rowid')`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END;
        CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path); END;
        CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts,rowid,title,name,summary,project_path)
        VALUES('delete',old.rowid,old.title,old.name,old.summary,old.project_path);
        INSERT INTO conversations_fts(rowid,title,name,summary,project_path)
        VALUES(new.rowid,new.title,new.name,new.summary,new.project_path); END;`)
      this.db.exec("INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')")
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false
    }
  }

  upsert(rows: (ConversationIndexRow & { machineId: string })[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(`INSERT INTO conversations
      (id,agent_kind,title,project_path,provider_id,resume_kind,resume_value,created_at,
       updated_at,message_count,machine_id,parent_conversation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      agent_kind=excluded.agent_kind, provider_id=excluded.provider_id,
      machine_id=excluded.machine_id, title=COALESCE(excluded.title,conversations.title),
      project_path=COALESCE(excluded.project_path,conversations.project_path),
      resume_kind=COALESCE(excluded.resume_kind,conversations.resume_kind),
      resume_value=COALESCE(excluded.resume_value,conversations.resume_value),
      created_at=COALESCE(excluded.created_at,conversations.created_at),
      updated_at=COALESCE(excluded.updated_at,conversations.updated_at),
      message_count=COALESCE(excluded.message_count,conversations.message_count),
      parent_conversation_id=COALESCE(excluded.parent_conversation_id,conversations.parent_conversation_id)`)
    transaction(this.db, () => {
      for (const row of rows)
        stmt.run(
          row.id,
          row.agentKind,
          row.title ?? null,
          row.projectPath ?? null,
          row.providerId,
          row.resumeKind ?? null,
          row.resumeValue ?? null,
          row.createdAt ?? null,
          row.updatedAt ?? null,
          row.messageCount ?? null,
          row.machineId,
          row.parentConversationId ?? null,
        )
    })
  }

  delete(ids: string[]): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('DELETE FROM conversations WHERE id = ?')
    transaction(this.db, () => {
      for (const id of ids) stmt.run(id)
    })
  }

  curatedMeta(): Map<string, { name?: string; summary?: string }> {
    const rows = this.db
      .prepare(
        'SELECT id,name,summary FROM conversations WHERE name IS NOT NULL OR summary IS NOT NULL',
      )
      .all() as { id: string; name: string | null; summary: string | null }[]
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
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) {
      // Curating a conversation nobody has discovered yet CREATES the row, and
      // since POD-318 the machine column has no default to manufacture one — so
      // this names the host, which is where a local curation act happens. It used
      // to lean on the `'__local__'` default, silently.
      this.db
        .prepare(
          `INSERT INTO conversations (id,agent_kind,provider_id,machine_id)
             VALUES (?,'claude-code','unknown',?)`,
        )
        .run(id, this.hostMachineId)
    }
    if (meta.name !== undefined)
      this.db.prepare('UPDATE conversations SET name=? WHERE id=?').run(meta.name, id)
    if (meta.summary !== undefined)
      this.db.prepare('UPDATE conversations SET summary=? WHERE id=?').run(meta.summary, id)
  }

  /** Complete candidates: memory filters before scoring and limiting. */
  searchCandidates(opts: { query?: string; projectPath?: string }): ConversationIndexRow[] {
    const pathFilter = opts.projectPath ? ' AND (c.project_path=? OR c.project_path LIKE ?)' : ''
    const pathArgs = opts.projectPath ? [opts.projectPath, `${opts.projectPath}/%`] : []
    const topLevel = ' AND c.parent_conversation_id IS NULL'
    const query = opts.query?.trim() ?? ''
    let rows: Record<string, unknown>[]
    if (!query) {
      rows = this.db
        .prepare(`SELECT c.* FROM conversations c WHERE 1=1${pathFilter}${topLevel}
        ORDER BY c.updated_at DESC NULLS LAST`)
        .all(...pathArgs) as Record<string, unknown>[]
    } else if (this.ftsAvailable) {
      const fts = query
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => `"${token.replace(/"/g, '""')}"*`)
        .join(' ')
      rows = this.db
        .prepare(`SELECT c.* FROM conversations_fts f JOIN conversations c ON c.rowid=f.rowid
        WHERE conversations_fts MATCH ?${pathFilter}${topLevel}
        ORDER BY c.updated_at DESC NULLS LAST`)
        .all(fts, ...pathArgs) as Record<string, unknown>[]
    } else {
      const like = `%${query}%`
      rows = this.db
        .prepare(`SELECT c.* FROM conversations c WHERE
        (c.title LIKE ? OR c.name LIKE ? OR c.summary LIKE ? OR c.project_path LIKE ?)
        ${pathFilter}${topLevel} ORDER BY c.updated_at DESC NULLS LAST`)
        .all(like, like, like, like, ...pathArgs) as Record<string, unknown>[]
    }
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
      machineId: (row.machine_id as string | null) ?? undefined,
    }))
  }

  search(opts: { query?: string; projectPath?: string; limit?: number }): ConversationIndexRow[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    return this.searchCandidates(opts).slice(0, limit)
  }
}
