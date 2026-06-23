import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeSettings, type PodiumSettings } from '@podium/core'
import { openDatabase, type SqlDatabase } from '@podium/core/sqlite'
import { AgentKind, IssueStage } from '@podium/protocol'

export type PinKind = 'panel' | 'worktree' | 'repo'

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

/** sessionId → snooze deadline. `null` = until next message; ISO = timed. */
export type SnoozeMap = Record<string, string | null>

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo'])

/**
 * Parse a JSON text column that should hold `string[]`, tolerating corruption.
 * A single malformed value (bad JSON, or valid JSON of the wrong shape) must not
 * throw out of a row mapper — that would abort the whole table load (and, for the
 * issues table, crash-loop the server at boot, since IssueService loads in its
 * constructor). Quarantine the bad value to `[]` and warn so it stays observable.
 */
function parseStringArray(raw: unknown, label: string): string[] {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw as string)
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    console.warn(`[podium] ${label}: expected string[], got ${typeof v} — quarantined to []`)
    return []
  } catch (err) {
    console.warn(`[podium] ${label}: unparseable JSON — quarantined to [] (${String(err)})`)
    return []
  }
}

/**
 * Parse a JSON text column to `T | undefined`, tolerating corruption (see
 * {@link parseStringArray}). Returns `undefined` for a null column or any parse
 * failure, so one corrupt blob can't abort the rest of the load.
 */
function parseJsonColumn<T>(raw: unknown, label: string): T | undefined {
  if (raw == null) return undefined
  try {
    return JSON.parse(raw as string) as T
  } catch (err) {
    console.warn(`[podium] ${label}: unparseable JSON — quarantined (${String(err)})`)
    return undefined
  }
}

/** Default DB file: $PODIUM_STATE_DIR/podium.db, else ~/.podium/podium.db. */
export function defaultDbPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'podium.db')
}

export type SessionStatusPersisted = 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'

/** One persisted session row. camelCase mirror of the snake_case `sessions` table. */
export interface SessionRow {
  id: string
  agentKind: string
  cwd: string
  title: string
  /** User-set display name; null = derive from title. */
  name: string | null
  originKind: 'spawn' | 'resume'
  conversationId: string | null
  resumeKind: string | null
  resumeValue: string | null
  status: SessionStatusPersisted
  exitCode: number | null
  durableLabel: string
  createdAt: string
  lastActiveAt: string
  archived: boolean
  /** Kanban column on the home board; null = unsorted. */
  workState: string | null
}

/** One row of the `issues` table (camelCase mirror; `blockedBy` stored as JSON text). */
export interface IssueRow {
  id: string
  repoPath: string
  seq: number
  title: string
  description: string
  stage: string
  worktreePath: string | null
  branch: string | null
  parentBranch: string
  defaultAgent: string
  linearId: string | null
  linearIdentifier: string | null
  linearUrl: string | null
  activityNotes: string | null
  notesUpdatedAt: string | null
  suggestedStage: string | null
  suggestedReason: string | null
  blockedBy: string[]
  dependencyNote: string | null
  prUrl: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
}

/** One row of the conversation index (camelCase mirror of `conversations`). */
export interface ConversationIndexRow {
  id: string
  agentKind: string
  providerId: string
  title?: string
  /** Command-center-set display name (curation; survives re-discovery). */
  name?: string
  /** Work-LLM state summary (curation; survives re-discovery). */
  summary?: string
  projectPath?: string
  resumeKind?: string
  resumeValue?: string
  createdAt?: string
  updatedAt?: string
  messageCount?: number
}

export interface ToolCallRow {
  id: string
  name: string
  arguments: string
}

/** One message of a superagent thread (the 'global' orchestrator, or a 'btw_<id>' thread). */
export interface SuperagentMessageRow {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCalls?: ToolCallRow[]
  toolCallId?: string
  toolName?: string
  createdAt: string
}

/** A superagent conversation: the always-there 'global' thread, or a per-session 'btw' thread. */
export interface SuperagentThreadRow {
  id: string
  kind: 'global' | 'btw'
  originSessionId?: string
  title?: string
  /** High-water mark into the origin session's transcript (btw threads only). */
  watermarkItemId?: string
  watermarkTs?: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

/** Durable server-side store: repos + sessions registry. Single writer (the server). */
export class SessionStore {
  private readonly db: SqlDatabase
  /** FTS5 is compiled into the bundled SQLite normally; LIKE fallback if not. */
  private ftsAvailable = false

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    this.migrate()
  }

  // ---- repos ----
  listRepos(): string[] {
    const rows = this.db.prepare('SELECT path FROM repos ORDER BY rowid ASC').all() as {
      path: string
    }[]
    return rows.map((r) => r.path)
  }

  // No path validation here by design — RepoRegistry (the caller) rejects empty/non-absolute paths.
  addRepo(path: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO repos (path, added_at) VALUES (?, ?)')
      .run(path, new Date().toISOString())
  }

  removeRepo(path: string): void {
    this.db.prepare('DELETE FROM repos WHERE path = ?').run(path)
  }

  // ---- pins ----
  listPins(): PinState {
    const rows = this.db.prepare('SELECT kind, id FROM pins ORDER BY rowid ASC').all() as {
      kind: PinKind
      id: string
    }[]
    const pins: PinState = { panels: [], worktrees: [], repos: [] }
    for (const row of rows) {
      if (row.kind === 'panel') pins.panels.push(row.id)
      else if (row.kind === 'worktree') pins.worktrees.push(row.id)
      else if (row.kind === 'repo') pins.repos.push(row.id)
    }
    return pins
  }

  setPin(kind: PinKind, id: string, pinned: boolean): void {
    if (!PIN_KINDS.has(kind)) throw new Error(`invalid pin kind: ${kind}`)
    const cleanId = id.trim()
    if (!cleanId) throw new Error('pin id is empty')
    if (pinned) {
      this.db
        .prepare('INSERT OR IGNORE INTO pins (kind, id, pinned_at) VALUES (?, ?, ?)')
        .run(kind, cleanId, new Date().toISOString())
    } else {
      this.db.prepare('DELETE FROM pins WHERE kind = ? AND id = ?').run(kind, cleanId)
    }
  }

  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time. */
  listSnoozes(now: number = Date.now()): SnoozeMap {
    const rows = this.db.prepare('SELECT session_id, snoozed_until FROM snoozes').all() as {
      session_id: string
      snoozed_until: string | null
    }[]
    const out: SnoozeMap = {}
    const expired: string[] = []
    for (const r of rows) {
      if (r.snoozed_until !== null && Date.parse(r.snoozed_until) <= now) {
        expired.push(r.session_id)
        continue
      }
      out[r.session_id] = r.snoozed_until
    }
    for (const id of expired) this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
    return out
  }

  /** Snooze a session. `until` = null → until next message; ISO string → timed. */
  setSnooze(sessionId: string, until: string | null): void {
    const id = sessionId.trim()
    if (!id) throw new Error('snooze session id is empty')
    this.db
      .prepare(
        `INSERT INTO snoozes (session_id, snoozed_until, created_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
      )
      .run(id, until, new Date().toISOString())
  }

  /** Un-snooze a session (no-op if not snoozed). */
  clearSnooze(sessionId: string): void {
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(sessionId.trim())
  }

  // ---- tab order ----
  /** Manual tab order per worktree path. Worktrees never reordered are absent. */
  listTabOrders(): Record<string, string[]> {
    const rows = this.db.prepare('SELECT worktree, ids FROM tab_order').all() as {
      worktree: string
      ids: string
    }[]
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

  setTabOrder(worktree: string, sessionIds: string[]): void {
    const cleanWorktree = worktree.trim()
    if (!cleanWorktree) throw new Error('worktree path is empty')
    if (sessionIds.length === 0) {
      this.db.prepare('DELETE FROM tab_order WHERE worktree = ?').run(cleanWorktree)
      return
    }
    this.db
      .prepare(
        `INSERT INTO tab_order (worktree, ids, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(worktree) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at`,
      )
      .run(cleanWorktree, JSON.stringify(sessionIds), new Date().toISOString())
  }

  /** Drop a session id from every saved tab order (called when the session dies). */
  private scrubTabOrders(sessionId: string): void {
    for (const [worktree, ids] of Object.entries(this.listTabOrders())) {
      if (!ids.includes(sessionId)) continue
      this.setTabOrder(
        worktree,
        ids.filter((id) => id !== sessionId),
      )
    }
  }

  // ---- sessions ----
  loadSessions(): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_kind, cwd, title, name, origin_kind, conversation_id, resume_kind,
                resume_value, status, exit_code, durable_label, created_at, last_active_at,
                archived, work_state
         FROM sessions ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      agentKind: r.agent_kind as string,
      cwd: r.cwd as string,
      title: r.title as string,
      name: (r.name as string | null) ?? null,
      originKind: r.origin_kind as 'spawn' | 'resume',
      conversationId: (r.conversation_id as string | null) ?? null,
      resumeKind: (r.resume_kind as string | null) ?? null,
      resumeValue: (r.resume_value as string | null) ?? null,
      status: r.status as SessionStatusPersisted,
      exitCode: (r.exit_code as number | null) ?? null,
      durableLabel: r.durable_label as string,
      createdAt: r.created_at as string,
      lastActiveAt: r.last_active_at as string,
      archived: r.archived === 1,
      workState: (r.work_state as string | null) ?? null,
    }))
  }

  upsertSession(row: SessionRow): void {
    // Strict on write: never persist an out-of-enum agentKind. That value later fails
    // the sessionsChanged zod-parse on every client and silently blanks the whole list
    // (see relay.createSession, which resolves the 'auto' sentinel before it gets here).
    if (!AgentKind.safeParse(row.agentKind).success) {
      throw new Error(
        `upsertSession: refusing to persist invalid agentKind ${JSON.stringify(row.agentKind)} for ${row.id}`,
      )
    }
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, agent_kind, cwd, title, name, origin_kind, conversation_id, resume_kind,
            resume_value, status, exit_code, durable_label, created_at, last_active_at,
            archived, work_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           name = excluded.name,
           origin_kind = excluded.origin_kind,
           conversation_id = excluded.conversation_id,
           resume_kind = excluded.resume_kind,
           resume_value = excluded.resume_value,
           status = excluded.status,
           exit_code = excluded.exit_code,
           durable_label = excluded.durable_label,
           last_active_at = excluded.last_active_at,
           archived = excluded.archived,
           work_state = excluded.work_state`,
      )
      .run(
        row.id,
        row.agentKind,
        row.cwd,
        row.title,
        row.name,
        row.originKind,
        row.conversationId,
        row.resumeKind,
        row.resumeValue,
        row.status,
        row.exitCode,
        row.durableLabel,
        row.createdAt,
        row.lastActiveAt,
        row.archived ? 1 : 0,
        row.workState,
      )
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM pins WHERE kind = ? AND id = ?').run('panel', id)
    this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
    this.scrubTabOrders(id)
  }

  // ---- composer drafts ----
  // The per-session in-progress chat-composer / native-prompt text (issue #34:
  // "input into a text field... should be stored while typing so it's never
  // lost"). Kept in its OWN table, not a column on `sessions`: a draft changes on
  // every keystroke, while a SessionRow is rewritten on every meta change — sharing
  // a row would make either write clobber the other. The registry debounces the
  // writes here (see relay.ts) so SQLite isn't hit per keystroke.
  loadDrafts(): Record<string, string> {
    const rows = this.db.prepare('SELECT session_id, text FROM session_drafts').all() as {
      session_id: string
      text: string
    }[]
    const out: Record<string, string> = {}
    for (const r of rows) out[r.session_id] = r.text
    return out
  }

  /** Set (non-empty) or clear (empty/whitespace-only persists as a deleted row) a session's draft. */
  setDraft(sessionId: string, text: string): void {
    const id = sessionId.trim()
    if (!id) return
    if (text) {
      this.db
        .prepare(
          `INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        )
        .run(id, text, new Date().toISOString())
    } else {
      this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
    }
  }

  // ---- settings ----
  /** The whole settings blob, defaults filled in. A corrupt row reads as defaults. */
  getSettings(): PodiumSettings {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('settings') as
      | { value: string }
      | undefined
    if (!row) return normalizeSettings(undefined)
    try {
      return normalizeSettings(JSON.parse(row.value))
    } catch {
      return normalizeSettings(undefined)
    }
  }

  setSettings(settings: PodiumSettings): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('settings', JSON.stringify(settings))
  }

  // ---- conversation index ----
  /**
   * Upsert discovered conversations (daemon pushes summaries). User-set name and
   * work-LLM summary survive re-discovery — discovery never overwrites curation.
   */
  upsertConversations(rows: ConversationIndexRow[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO conversations
         (id, agent_kind, title, project_path, provider_id, resume_kind, resume_value,
          created_at, updated_at, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_kind = excluded.agent_kind,
         provider_id = excluded.provider_id,
         -- COALESCE the optional columns: a later discovery push that omits a
         -- field (ConversationSummaryWire marks title/resume optional) must not
         -- null out what an earlier richer push recorded, or search stops
         -- matching and the hibernate→resume ref is lost.
         title = COALESCE(excluded.title, conversations.title),
         project_path = COALESCE(excluded.project_path, conversations.project_path),
         resume_kind = COALESCE(excluded.resume_kind, conversations.resume_kind),
         resume_value = COALESCE(excluded.resume_value, conversations.resume_value),
         created_at = COALESCE(excluded.created_at, conversations.created_at),
         updated_at = COALESCE(excluded.updated_at, conversations.updated_at),
         message_count = COALESCE(excluded.message_count, conversations.message_count)`,
    )
    // One transaction, not N autocommits: the daemon pushes its full conversation
    // list (potentially thousands) every ~15s, and a commit-per-row turned that
    // into thousands of WAL syncs on the synchronous main thread. The FTS index
    // stays current via triggers (see migrate), so no rebuild here.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        stmt.run(
          r.id,
          r.agentKind,
          r.title ?? null,
          r.projectPath ?? null,
          r.providerId,
          r.resumeKind ?? null,
          r.resumeValue ?? null,
          r.createdAt ?? null,
          r.updatedAt ?? null,
          r.messageCount ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Persist command-center-generated curation: a good name and/or a state summary. */
  setConversationMeta(id: string, meta: { name?: string; summary?: string }): void {
    const exists = this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO conversations (id, agent_kind, provider_id) VALUES (?, 'claude-code', 'unknown')`,
        )
        .run(id)
    }
    if (meta.name !== undefined) {
      this.db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(meta.name, id)
    }
    if (meta.summary !== undefined) {
      this.db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(meta.summary, id)
    }
    // FTS stays current via the UPDATE trigger (see migrate) — no rebuild.
  }

  /**
   * Keyword search over title/name/summary/path. FTS5 (bm25 + recency) where the
   * runtime has it; LIKE fallback elsewhere. `projectPath` filters to one
   * worktree/repo subtree. Empty query = recency-ordered browse.
   */
  searchConversations(opts: {
    query?: string
    projectPath?: string
    limit?: number
  }): ConversationIndexRow[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    const pathFilter = opts.projectPath ? ' AND (c.project_path = ? OR c.project_path LIKE ?)' : ''
    const pathArgs = opts.projectPath ? [opts.projectPath, `${opts.projectPath}/%`] : []
    const q = opts.query?.trim() ?? ''
    let rows: Record<string, unknown>[]
    if (!q) {
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c WHERE 1=1${pathFilter}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(...pathArgs, limit) as Record<string, unknown>[]
    } else if (this.ftsAvailable) {
      const ftsQuery = q
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"*`)
        .join(' ')
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations_fts f
           JOIN conversations c ON c.rowid = f.rowid
           WHERE conversations_fts MATCH ?${pathFilter}
           ORDER BY bm25(conversations_fts), c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(ftsQuery, ...pathArgs, limit) as Record<string, unknown>[]
    } else {
      const like = `%${q}%`
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c
           WHERE (c.title LIKE ? OR c.name LIKE ? OR c.summary LIKE ? OR c.project_path LIKE ?)${pathFilter}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(like, like, like, like, ...pathArgs, limit) as Record<string, unknown>[]
    }
    return rows.map((r) => ({
      id: r.id as string,
      agentKind: r.agent_kind as string,
      providerId: r.provider_id as string,
      title: (r.title as string | null) ?? undefined,
      name: (r.name as string | null) ?? undefined,
      summary: (r.summary as string | null) ?? undefined,
      projectPath: (r.project_path as string | null) ?? undefined,
      resumeKind: (r.resume_kind as string | null) ?? undefined,
      resumeValue: (r.resume_value as string | null) ?? undefined,
      createdAt: (r.created_at as string | null) ?? undefined,
      updatedAt: (r.updated_at as string | null) ?? undefined,
      messageCount: (r.message_count as number | null) ?? undefined,
    }))
  }

  // ---- superagent threads ----
  loadSuperagentMessages(threadId = 'global', limit = 200): SuperagentMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, tool_calls, tool_call_id, tool_name, created_at
         FROM superagent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(threadId, limit) as Record<string, unknown>[]
    return rows.reverse().map((r) => ({
      id: r.id as number,
      role: r.role as SuperagentMessageRow['role'],
      content: r.content as string,
      toolCalls: parseJsonColumn<ToolCallRow[]>(r.tool_calls, `superagent msg ${String(r.id)} tool_calls`),
      toolCallId: (r.tool_call_id as string | null) ?? undefined,
      toolName: (r.tool_name as string | null) ?? undefined,
      createdAt: r.created_at as string,
    }))
  }

  appendSuperagentMessage(
    threadId: string,
    m: Omit<SuperagentMessageRow, 'id' | 'createdAt'>,
  ): SuperagentMessageRow {
    const createdAt = new Date().toISOString()
    const result = this.db
      .prepare(
        `INSERT INTO superagent_messages
           (thread_id, role, content, tool_calls, tool_call_id, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        m.role,
        m.content,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.toolName ?? null,
        createdAt,
      )
    this.db
      .prepare('UPDATE superagent_threads SET updated_at = ? WHERE id = ?')
      .run(createdAt, threadId)
    return { ...m, id: Number(result.lastInsertRowid), createdAt }
  }

  clearSuperagentMessages(threadId = 'global'): void {
    this.db.prepare('DELETE FROM superagent_messages WHERE thread_id = ?').run(threadId)
  }

  listSuperagentThreads(): SuperagentThreadRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, origin_session_id, title, watermark_item_id, watermark_ts,
                created_at, updated_at, archived
         FROM superagent_threads WHERE archived = 0 ORDER BY updated_at DESC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.mapSuperagentThread(r))
  }

  getSuperagentThread(id: string): SuperagentThreadRow | undefined {
    const r = this.db.prepare('SELECT * FROM superagent_threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapSuperagentThread(r) : undefined
  }

  upsertSuperagentThread(t: {
    id: string
    kind: 'global' | 'btw'
    originSessionId?: string
    title?: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO superagent_threads (id, kind, origin_session_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, title), archived = 0, updated_at = ?`,
      )
      .run(t.id, t.kind, t.originSessionId ?? null, t.title ?? null, now, now, now)
  }

  setThreadWatermark(id: string, itemId: string, ts: string | undefined): void {
    this.db
      .prepare('UPDATE superagent_threads SET watermark_item_id = ?, watermark_ts = ? WHERE id = ?')
      .run(itemId, ts ?? null, id)
  }

  archiveSuperagentThread(id: string): void {
    this.db.prepare('UPDATE superagent_threads SET archived = 1 WHERE id = ?').run(id)
  }

  private mapSuperagentThread(r: Record<string, unknown>): SuperagentThreadRow {
    return {
      id: r.id as string,
      kind: r.kind as 'global' | 'btw',
      originSessionId: (r.origin_session_id as string | null) ?? undefined,
      title: (r.title as string | null) ?? undefined,
      watermarkItemId: (r.watermark_item_id as string | null) ?? undefined,
      watermarkTs: (r.watermark_ts as string | null) ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: Boolean(r.archived),
    }
  }

  // ---- issues ----

  upsertIssue(row: IssueRow): void {
    // Strict on write: stage is a load-bearing enum (the board column + zod-validated
    // on the wire). defaultAgent is intentionally NOT validated here — 'auto' is a
    // legal stored sentinel resolved to a concrete kind only at spawn time.
    if (!IssueStage.safeParse(row.stage).success) {
      throw new Error(
        `upsertIssue: refusing to persist invalid stage ${JSON.stringify(row.stage)} for ${row.id}`,
      )
    }
    // Normalize blockedBy so the column is always a clean string[] JSON value.
    const blockedBy = Array.isArray(row.blockedBy)
      ? row.blockedBy.filter((x): x is string => typeof x === 'string')
      : []
    this.db
      .prepare(
        `INSERT INTO issues
           (id, repo_path, seq, title, description, stage, worktree_path, branch, parent_branch,
            default_agent, linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
            suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
            created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, description = excluded.description, stage = excluded.stage,
           worktree_path = excluded.worktree_path, branch = excluded.branch,
           parent_branch = excluded.parent_branch, default_agent = excluded.default_agent,
           linear_id = excluded.linear_id, linear_identifier = excluded.linear_identifier,
           linear_url = excluded.linear_url, activity_notes = excluded.activity_notes,
           notes_updated_at = excluded.notes_updated_at, suggested_stage = excluded.suggested_stage,
           suggested_reason = excluded.suggested_reason, blocked_by = excluded.blocked_by,
           dependency_note = excluded.dependency_note, pr_url = excluded.pr_url,
           updated_at = excluded.updated_at, archived = excluded.archived`,
      )
      .run(
        row.id, row.repoPath, row.seq, row.title, row.description, row.stage, row.worktreePath,
        row.branch, row.parentBranch, row.defaultAgent, row.linearId, row.linearIdentifier,
        row.linearUrl, row.activityNotes, row.notesUpdatedAt, row.suggestedStage, row.suggestedReason,
        JSON.stringify(blockedBy), row.dependencyNote, row.prUrl,
        row.createdAt, row.updatedAt, row.archived ? 1 : 0,
      )
  }

  private mapIssueRow(r: Record<string, unknown>): IssueRow {
    return {
      id: r.id as string,
      repoPath: r.repo_path as string,
      seq: r.seq as number,
      title: r.title as string,
      description: (r.description as string) ?? '',
      stage: r.stage as string,
      worktreePath: (r.worktree_path as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      parentBranch: r.parent_branch as string,
      defaultAgent: r.default_agent as string,
      linearId: (r.linear_id as string | null) ?? null,
      linearIdentifier: (r.linear_identifier as string | null) ?? null,
      linearUrl: (r.linear_url as string | null) ?? null,
      activityNotes: (r.activity_notes as string | null) ?? null,
      notesUpdatedAt: (r.notes_updated_at as string | null) ?? null,
      suggestedStage: (r.suggested_stage as string | null) ?? null,
      suggestedReason: (r.suggested_reason as string | null) ?? null,
      blockedBy: parseStringArray(r.blocked_by, `issue ${String(r.id)} blocked_by`),
      dependencyNote: (r.dependency_note as string | null) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: r.archived === 1,
    }
  }

  getIssue(id: string): IssueRow | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapIssueRow(r) : null
  }

  listIssueRows(repoPath?: string): IssueRow[] {
    const rows = (repoPath
      ? this.db.prepare('SELECT * FROM issues WHERE repo_path = ? ORDER BY seq ASC').all(repoPath)
      : this.db
          .prepare('SELECT * FROM issues ORDER BY repo_path ASC, seq ASC')
          .all()) as Record<string, unknown>[]
    return rows.map((r) => this.mapIssueRow(r))
  }

  deleteIssue(id: string): void {
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }

  nextIssueSeq(repoPath: string): number {
    const r = this.db
      .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?')
      .get(repoPath) as { m: number | null }
    return (r.m ?? 0) + 1
  }

  close(): void {
    this.db.close()
  }

  // ---- schema ----
  private migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('CREATE TABLE IF NOT EXISTS repos (path TEXT PRIMARY KEY, added_at TEXT NOT NULL)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS pins (
         kind TEXT NOT NULL,
         id TEXT NOT NULL,
         pinned_at TEXT NOT NULL,
         PRIMARY KEY (kind, id)
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS snoozes (
         session_id TEXT PRIMARY KEY,
         snoozed_until TEXT,
         created_at TEXT NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         cwd TEXT NOT NULL,
         title TEXT NOT NULL,
         name TEXT,
         origin_kind TEXT NOT NULL,
         conversation_id TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         status TEXT NOT NULL,
         exit_code INTEGER,
         durable_label TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0,
         work_state TEXT
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tab_order (
         worktree TEXT PRIMARY KEY,
         ids TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_drafts (
         session_id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    )
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS conversations (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         provider_id TEXT NOT NULL,
         title TEXT,
         name TEXT,
         summary TEXT,
         project_path TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         created_at TEXT,
         updated_at TEXT,
         message_count INTEGER
       )`,
    )
    // Indices for the two hot conversation queries (audit P1-6): the empty-query
    // browse orders by updated_at, and the project filter / LIKE-fallback search
    // filter by project_path — both were full table scans + filesorts before.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)',
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_project_path ON conversations(project_path)',
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS superagent_messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         tool_calls TEXT,
         tool_call_id TEXT,
         tool_name TEXT,
         created_at TEXT NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS superagent_threads (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         origin_session_id TEXT,
         title TEXT,
         watermark_item_id TEXT,
         watermark_ts TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       )`,
    )
    // Scope pre-existing (single-thread) messages under 'global' via the column default.
    const saCols = this.db.prepare('PRAGMA table_info(superagent_messages)').all() as {
      name: string
    }[]
    if (!saCols.some((c) => c.name === 'thread_id')) {
      this.db.exec(
        "ALTER TABLE superagent_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT 'global'",
      )
    }
    const saNow = new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO superagent_threads (id, kind, created_at, updated_at)
         VALUES ('global', 'global', ?, ?)`,
      )
      .run(saNow, saNow)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issues (
         id TEXT PRIMARY KEY,
         repo_path TEXT NOT NULL,
         seq INTEGER NOT NULL,
         title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         stage TEXT NOT NULL,
         worktree_path TEXT,
         branch TEXT,
         parent_branch TEXT NOT NULL DEFAULT 'main',
         default_agent TEXT NOT NULL,
         linear_id TEXT,
         linear_identifier TEXT,
         linear_url TEXT,
         activity_notes TEXT,
         notes_updated_at TEXT,
         suggested_stage TEXT,
         suggested_reason TEXT,
         blocked_by TEXT NOT NULL DEFAULT '[]',
         dependency_note TEXT,
         pr_url TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')
    // External-content FTS over the searchable text columns. Hybrid search note:
    // keyword now; a vector column joins when an embeddings provider is configured.
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
           title, name, summary, project_path,
           content='conversations', content_rowid='rowid'
         )`,
      )
      // Triggers keep the external-content index in sync incrementally — every
      // INSERT/UPDATE/DELETE touches only the affected rowid. This replaces a
      // full 'rebuild' that previously ran on every ~15s discovery push and on
      // every metadata edit (O(all rows) each time, on the main thread).
      this.db.exec(
        `CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
           INSERT INTO conversations_fts(rowid, title, name, summary, project_path)
           VALUES (new.rowid, new.title, new.name, new.summary, new.project_path);
         END;
         CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
           INSERT INTO conversations_fts(conversations_fts, rowid, title, name, summary, project_path)
           VALUES ('delete', old.rowid, old.title, old.name, old.summary, old.project_path);
         END;
         CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
           INSERT INTO conversations_fts(conversations_fts, rowid, title, name, summary, project_path)
           VALUES ('delete', old.rowid, old.title, old.name, old.summary, old.project_path);
           INSERT INTO conversations_fts(rowid, title, name, summary, project_path)
           VALUES (new.rowid, new.title, new.name, new.summary, new.project_path);
         END;`,
      )
      // One-time heal at boot: re-tokenize so rows written before the triggers
      // existed (or any drift) are indexed. O(rows) once per process, not per write.
      this.db.exec("INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')")
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false // LIKE fallback handles search
    }
    // v1 -> v2: tmux_label -> durable_label (the label now names an abduco OR tmux
    // session; see the durable-backend selection in the daemon). For a pre-rename db
    // the CREATE above no-ops, so the old column is still there — rename it in place.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'tmux_label')) {
      this.db.exec('ALTER TABLE sessions RENAME COLUMN tmux_label TO durable_label')
    }
    // v2 -> v3: session curation columns (user name, archive flag, kanban state).
    // Fresh DBs get them from the CREATE above; pre-v3 tables gain them in place.
    const colNames = new Set(cols.map((c) => c.name))
    if (!colNames.has('name')) this.db.exec('ALTER TABLE sessions ADD COLUMN name TEXT')
    if (!colNames.has('archived'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
    if (!colNames.has('work_state')) this.db.exec('ALTER TABLE sessions ADD COLUMN work_state TEXT')
    // v3 -> v4: per-session composer drafts (issue #34). A brand-new standalone
    // table created by the CREATE IF NOT EXISTS above — pre-v4 DBs gain it with no
    // ALTER, so the bump is just the recorded version marker.
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!v || Number(v.value) < 5)
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', '5')
    this.importReposJson()
  }

  /** One-time import of a legacy ~/.podium/repos.json sitting next to the db. */
  private importReposJson(): void {
    if (this.path === ':memory:') return
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM repos').get() as { c: number }).c
    if (count > 0) return
    let raw: string
    try {
      raw = readFileSync(join(dirname(this.path), 'repos.json'), 'utf8')
    } catch {
      return // no legacy file
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // corrupt file -> skip
    }
    if (!Array.isArray(parsed)) return
    const insert = this.db.prepare('INSERT OR IGNORE INTO repos (path, added_at) VALUES (?, ?)')
    const now = new Date().toISOString()
    for (const p of parsed) if (typeof p === 'string') insert.run(p, now)
  }
}
