import { createHash, timingSafeEqual } from 'node:crypto'
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
  /** Last PTY output frame (ISO); null = none recorded. Hibernation signal only — not recency. */
  lastOutputAt: string | null
  /** Last controller input — any keys/mouse/paste (ISO); null = none. Hibernation signal only. */
  lastInputAt: string | null
  /** Last resume/resurrect (ISO); null = never. Hibernation signal only. */
  lastResumedAt: string | null
  archived: boolean
  /** Kanban column on the home board; null = unsorted. */
  workState: string | null
  /** The machine this session runs on. Optional during build-out (Task 5 always emits it). */
  machineId?: string
}

/** One row of the machines table (token_hash is internal — not included here). */
export interface MachineRecord {
  id: string
  name: string
  hostname: string
  createdAt: string
  lastSeenAt: string
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
  priority: number
  type: string
  assignee: string | null
  parentId: string | null
  design: string | null
  acceptance: string | null
  notes: string | null
  dueAt: string | null
  deferUntil: string | null
  closedReason: string | null
  supersededBy: string | null
  duplicateOf: string | null
  pinned: boolean
  estimateMin: number | null
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
  /** Which machine owns this conversation; '__local__' for pre-multi-machine rows. */
  machineId?: string
  /** Set when this conversation is a subagent (sidechain) of another — the resume
   *  picker filters these out so only top-level sessions are offered. */
  parentConversationId?: string
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

  /** Full repo rows including machineId and originUrl (multi-machine schema). */
  listRepos(machineId?: string): { machineId: string; path: string; originUrl: string | null }[] {
    const rows = (
      machineId
        ? this.db
            .prepare(
              'SELECT machine_id, path, origin_url FROM repos WHERE machine_id = ? ORDER BY rowid ASC',
            )
            .all(machineId)
        : this.db.prepare('SELECT machine_id, path, origin_url FROM repos ORDER BY rowid ASC').all()
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      machineId: r.machine_id as string,
      path: r.path as string,
      originUrl: (r.origin_url as string | null) ?? null,
    }))
  }

  /** Back-compat: flat list of paths across all machines. RepoRegistry.list() uses this. */
  listRepoPaths(machineId?: string): string[] {
    return this.listRepos(machineId).map((r) => r.path)
  }

  // No path validation here by design — RepoRegistry (the caller) rejects empty/non-absolute paths.
  addRepo(path: string, machineId = '__local__', originUrl?: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, added_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        machineId,
        path,
        originUrl ?? null,
        path.split('/').pop() ?? null,
        new Date().toISOString(),
      )
  }

  removeRepo(path: string, machineId = '__local__'): void {
    this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?').run(machineId, path)
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
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at
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
      machineId: (r.machine_id as string | null) ?? '__local__',
      lastOutputAt: (r.last_output_at as string | null) ?? null,
      lastInputAt: (r.last_input_at as string | null) ?? null,
      lastResumedAt: (r.last_resumed_at as string | null) ?? null,
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
            archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           work_state = excluded.work_state,
           machine_id = excluded.machine_id,
           last_output_at = excluded.last_output_at,
           last_input_at = excluded.last_input_at,
           last_resumed_at = excluded.last_resumed_at`,
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
        row.machineId ?? '__local__',
        row.lastOutputAt ?? null,
        row.lastInputAt ?? null,
        row.lastResumedAt ?? null,
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

  /** Draft last-edit times by session — the companion to {@link loadDrafts}, used
   *  to seed `Session.draftUpdatedAt` at boot so a draft lifts its session in the
   *  attention ordering after a restart. */
  loadDraftTimes(): Record<string, string> {
    const rows = this.db.prepare('SELECT session_id, updated_at FROM session_drafts').all() as {
      session_id: string
      updated_at: string
    }[]
    const out: Record<string, string> = {}
    for (const r of rows) out[r.session_id] = r.updated_at
    return out
  }

  /** Set (non-empty) or clear (empty/whitespace-only persists as a deleted row) a
   *  session's draft. Returns the new updated_at when set, or undefined when cleared
   *  — the registry mirrors it onto `Session.draftUpdatedAt`. */
  setDraft(sessionId: string, text: string): string | undefined {
    const id = sessionId.trim()
    if (!id) return undefined
    if (text) {
      const updatedAt = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        )
        .run(id, text, updatedAt)
      return updatedAt
    }
    this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
    return undefined
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
  upsertConversations(rows: (ConversationIndexRow & { machineId?: string })[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO conversations
         (id, agent_kind, title, project_path, provider_id, resume_kind, resume_value,
          created_at, updated_at, message_count, machine_id, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_kind = excluded.agent_kind,
         provider_id = excluded.provider_id,
         machine_id = excluded.machine_id,
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
         message_count = COALESCE(excluded.message_count, conversations.message_count),
         parent_conversation_id =
           COALESCE(excluded.parent_conversation_id, conversations.parent_conversation_id)`,
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
          r.machineId ?? '__local__',
          r.parentConversationId ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Drop conversations the daemon no longer sees (an incremental-discovery delta's
   * `removed` set). Transactional like {@link upsertConversations}: one BEGIN
   * IMMEDIATE / COMMIT, ROLLBACK + rethrow on error, so a mid-batch failure never
   * leaves the index half-pruned. The external-content FTS index stays consistent
   * automatically — the `conversations_ad` AFTER DELETE trigger (see migrate)
   * issues the FTS5 'delete' command per affected rowid, so a plain DELETE here is
   * enough; no manual FTS bookkeeping.
   */
  deleteConversations(ids: string[]): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('DELETE FROM conversations WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) stmt.run(id)
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
    // The resume picker offers top-level sessions only — never a subagent
    // (sidechain) conversation, mirroring `claude --resume`, which lists the
    // parent conversation, not the Task subagents it spawned.
    const topLevel = ' AND c.parent_conversation_id IS NULL'
    const q = opts.query?.trim() ?? ''
    let rows: Record<string, unknown>[]
    if (!q) {
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c WHERE 1=1${pathFilter}${topLevel}
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
          // Recency-ordered even while searching — the resume picker mirrors
          // `claude --resume`, which lists newest-active first regardless of the
          // query. FTS only narrows the set (the MATCH); it does not reorder it,
          // so a relevant-but-ancient conversation never jumps above a recent one.
          `SELECT c.* FROM conversations_fts f
           JOIN conversations c ON c.rowid = f.rowid
           WHERE conversations_fts MATCH ?${pathFilter}${topLevel}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(ftsQuery, ...pathArgs, limit) as Record<string, unknown>[]
    } else {
      const like = `%${q}%`
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c
           WHERE (c.title LIKE ? OR c.name LIKE ? OR c.summary LIKE ? OR c.project_path LIKE ?)${pathFilter}${topLevel}
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
      machineId: (r.machine_id as string | null) ?? undefined,
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
      toolCalls: parseJsonColumn<ToolCallRow[]>(
        r.tool_calls,
        `superagent msg ${String(r.id)} tool_calls`,
      ),
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

  // ---- machines ----

  upsertMachine(m: { id: string; name: string; hostname: string; tokenHash: string }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           token_hash = excluded.token_hash,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(m.id, m.name, m.hostname, m.tokenHash, now, now)
  }

  listMachines(): MachineRecord[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, hostname, created_at, last_seen_at FROM machines ORDER BY created_at ASC',
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      hostname: r.hostname as string,
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at as string,
    }))
  }

  getMachine(id: string): MachineRecord | undefined {
    const r = this.db
      .prepare('SELECT id, name, hostname, created_at, last_seen_at FROM machines WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      id: r.id as string,
      name: r.name as string,
      hostname: r.hostname as string,
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at as string,
    }
  }

  /** Constant-time token comparison using sha-256 hex. */
  getMachineByToken(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT token_hash FROM machines WHERE id = ?').get(id) as
      | { token_hash: string }
      | undefined
    if (!row) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.token_hash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  renameMachine(id: string, name: string): void {
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id)
  }

  deleteMachine(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id)
  }

  touchMachine(id: string, hostname: string): void {
    this.db
      .prepare('UPDATE machines SET last_seen_at = ?, hostname = ? WHERE id = ?')
      .run(new Date().toISOString(), hostname, id)
  }

  /**
   * Rewrite all rows carrying the placeholder `'__local__'` machine_id to the
   * real machineId. Idempotent: re-running after adoption is a no-op (no rows
   * will match `__local__` any more).
   */
  adoptLocalRows(machineId: string): void {
    for (const t of ['sessions', 'repos', 'conversations']) {
      this.db
        .prepare(`UPDATE ${t} SET machine_id = ? WHERE machine_id = '__local__'`)
        .run(machineId)
    }
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
            priority, type, assignee, parent_id, design, acceptance, notes, due_at,
            defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
            created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, description = excluded.description, stage = excluded.stage,
           worktree_path = excluded.worktree_path, branch = excluded.branch,
           parent_branch = excluded.parent_branch, default_agent = excluded.default_agent,
           linear_id = excluded.linear_id, linear_identifier = excluded.linear_identifier,
           linear_url = excluded.linear_url, activity_notes = excluded.activity_notes,
           notes_updated_at = excluded.notes_updated_at, suggested_stage = excluded.suggested_stage,
           suggested_reason = excluded.suggested_reason, blocked_by = excluded.blocked_by,
           dependency_note = excluded.dependency_note, pr_url = excluded.pr_url,
           priority = excluded.priority, type = excluded.type, assignee = excluded.assignee,
           parent_id = excluded.parent_id, design = excluded.design,
           acceptance = excluded.acceptance, notes = excluded.notes, due_at = excluded.due_at,
           defer_until = excluded.defer_until, closed_reason = excluded.closed_reason,
           superseded_by = excluded.superseded_by, duplicate_of = excluded.duplicate_of,
           pinned = excluded.pinned, estimate_min = excluded.estimate_min,
           updated_at = excluded.updated_at, archived = excluded.archived`,
      )
      .run(
        row.id,
        row.repoPath,
        row.seq,
        row.title,
        row.description,
        row.stage,
        row.worktreePath,
        row.branch,
        row.parentBranch,
        row.defaultAgent,
        row.linearId,
        row.linearIdentifier,
        row.linearUrl,
        row.activityNotes,
        row.notesUpdatedAt,
        row.suggestedStage,
        row.suggestedReason,
        JSON.stringify(blockedBy),
        row.dependencyNote,
        row.prUrl,
        row.priority,
        row.type,
        row.assignee,
        row.parentId,
        row.design,
        row.acceptance,
        row.notes,
        row.dueAt,
        row.deferUntil,
        row.closedReason,
        row.supersededBy,
        row.duplicateOf,
        row.pinned ? 1 : 0,
        row.estimateMin,
        row.createdAt,
        row.updatedAt,
        row.archived ? 1 : 0,
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
      priority: (r.priority as number) ?? 2,
      type: (r.type as string) ?? 'task',
      assignee: (r.assignee as string | null) ?? null,
      parentId: (r.parent_id as string | null) ?? null,
      design: (r.design as string | null) ?? null,
      acceptance: (r.acceptance as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      dueAt: (r.due_at as string | null) ?? null,
      deferUntil: (r.defer_until as string | null) ?? null,
      closedReason: (r.closed_reason as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      duplicateOf: (r.duplicate_of as string | null) ?? null,
      pinned: r.pinned === 1,
      estimateMin: (r.estimate_min as number | null) ?? null,
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
    const rows = (
      repoPath
        ? this.db.prepare('SELECT * FROM issues WHERE repo_path = ? ORDER BY seq ASC').all(repoPath)
        : this.db.prepare('SELECT * FROM issues ORDER BY repo_path ASC, seq ASC').all()
    ) as Record<string, unknown>[]
    return rows.map((r) => this.mapIssueRow(r))
  }

  deleteIssue(id: string): void {
    this.deleteIssueChildRows(id)
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }

  setIssueLabels(issueId: string, labels: string[]): void {
    const clean = [...new Set(labels.filter((l) => typeof l === 'string' && l.trim()))].map((l) =>
      l.trim(),
    )
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    const ins = this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)')
    for (const l of clean) ins.run(issueId, l)
  }

  getIssueLabels(issueId: string): string[] {
    return (
      this.db
        .prepare('SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label ASC')
        .all(issueId) as { label: string }[]
    ).map((r) => r.label)
  }

  listAllLabels(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT label FROM issue_labels ORDER BY label ASC').all() as {
        label: string
      }[]
    ).map((r) => r.label)
  }

  addIssueDep(fromId: string, toId: string, type = 'blocks'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, ?)')
      .run(fromId, toId, type)
  }

  removeIssueDep(fromId: string, toId: string, type?: string): void {
    if (type) {
      this.db
        .prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ? AND type = ?')
        .run(fromId, toId, type)
    } else {
      this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ?').run(fromId, toId)
    }
  }

  listIssueDeps(fromId: string): { toId: string; type: string }[] {
    return (
      this.db
        .prepare('SELECT to_id, type FROM issue_deps WHERE from_id = ? ORDER BY to_id ASC, type ASC')
        .all(fromId) as { to_id: string; type: string }[]
    ).map((r) => ({ toId: r.to_id, type: r.type }))
  }

  listDependents(toId: string): { fromId: string; type: string }[] {
    return (
      this.db
        .prepare('SELECT from_id, type FROM issue_deps WHERE to_id = ? ORDER BY from_id ASC, type ASC')
        .all(toId) as { from_id: string; type: string }[]
    ).map((r) => ({ fromId: r.from_id, type: r.type }))
  }

  deleteIssueChildRows(issueId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? OR to_id = ?').run(issueId, issueId)
    this.db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(issueId)
  }

  nextIssueSeq(repoPath: string): number {
    const r = this.db
      .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?')
      .get(repoPath) as { m: number | null }
    return (r.m ?? 0) + 1
  }

  /** One-time, idempotent: mirror legacy issues.blocked_by arrays into issue_deps. */
  private backfillIssueDeps(): void {
    const rows = this.db.prepare("SELECT id, blocked_by FROM issues WHERE blocked_by != '[]'").all() as {
      id: string
      blocked_by: string
    }[]
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, 'blocks')",
    )
    for (const r of rows) {
      let ids: unknown
      try {
        ids = JSON.parse(r.blocked_by)
      } catch {
        ids = []
      }
      if (Array.isArray(ids)) {
        for (const to of ids) if (typeof to === 'string' && to) ins.run(r.id, to)
      }
    }
  }

  close(): void {
    this.db.close()
  }

  // ---- schema ----
  private migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS repos (
         machine_id TEXT NOT NULL DEFAULT '__local__',
         path TEXT NOT NULL,
         origin_url TEXT,
         repo_name TEXT,
         added_at TEXT NOT NULL,
         PRIMARY KEY (machine_id, path)
       )`,
    )
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
         work_state TEXT,
         last_output_at TEXT,
         last_input_at TEXT,
         last_resumed_at TEXT
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
         message_count INTEGER,
         parent_conversation_id TEXT
       )`,
    )
    // v: parent_conversation_id added so the resume picker can exclude subagent
    // (sidechain) conversations — only top-level sessions are resumable targets.
    // ALTER for pre-existing DBs (CREATE above no-ops there).
    if (
      !(this.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).some(
        (c) => c.name === 'parent_conversation_id',
      )
    ) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT')
    }
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
         priority INTEGER NOT NULL DEFAULT 2,
         type TEXT NOT NULL DEFAULT 'task',
         assignee TEXT,
         parent_id TEXT,
         design TEXT,
         acceptance TEXT,
         notes TEXT,
         due_at TEXT,
         defer_until TEXT,
         closed_reason TEXT,
         superseded_by TEXT,
         duplicate_of TEXT,
         pinned INTEGER NOT NULL DEFAULT 0,
         estimate_min INTEGER,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')
    // Additive rich-tracker columns (structural guard — no version marker bump). Fresh
    // DBs already have them from the CREATE above; live DBs gain them in place.
    const issueCols = new Set(
      (this.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
    )
    const addIssueCol = (name: string, ddl: string): void => {
      if (!issueCols.has(name)) this.db.exec(`ALTER TABLE issues ADD COLUMN ${ddl}`)
    }
    addIssueCol('priority', 'priority INTEGER NOT NULL DEFAULT 2')
    addIssueCol('type', "type TEXT NOT NULL DEFAULT 'task'")
    addIssueCol('assignee', 'assignee TEXT')
    addIssueCol('parent_id', 'parent_id TEXT')
    addIssueCol('design', 'design TEXT')
    addIssueCol('acceptance', 'acceptance TEXT')
    addIssueCol('notes', 'notes TEXT')
    addIssueCol('due_at', 'due_at TEXT')
    addIssueCol('defer_until', 'defer_until TEXT')
    addIssueCol('closed_reason', 'closed_reason TEXT')
    addIssueCol('superseded_by', 'superseded_by TEXT')
    addIssueCol('duplicate_of', 'duplicate_of TEXT')
    addIssueCol('pinned', 'pinned INTEGER NOT NULL DEFAULT 0')
    addIssueCol('estimate_min', 'estimate_min INTEGER')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_labels (
         issue_id TEXT NOT NULL,
         label    TEXT NOT NULL,
         PRIMARY KEY (issue_id, label)
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_deps (
         from_id TEXT NOT NULL,
         to_id   TEXT NOT NULL,
         type    TEXT NOT NULL DEFAULT 'blocks',
         PRIMARY KEY (from_id, to_id, type)
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_from ON issue_deps(from_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_to ON issue_deps(to_id)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_comments (
         id         TEXT PRIMARY KEY,
         issue_id   TEXT NOT NULL,
         author     TEXT NOT NULL,
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)')
    this.backfillIssueDeps()
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
    // Additive activity-timestamp columns (no version-gate bump): durable hibernation
    // signals; old rows read NULL and behave as before until first live activity.
    // Structural guard (column-presence), no version marker change.
    if (!colNames.has('last_output_at'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN last_output_at TEXT')
    if (!colNames.has('last_input_at'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN last_input_at TEXT')
    if (!colNames.has('last_resumed_at'))
      this.db.exec('ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT')
    // v3 -> v4: per-session composer drafts (issue #34). A brand-new standalone
    // table created by the CREATE IF NOT EXISTS above — pre-v4 DBs gain it with no
    // ALTER, so the bump is just the recorded version marker.
    // v4 -> v5: machines table + machine attribution on sessions, conversations, repos.
    // All DDL steps run inside one transaction so a mid-rebuild crash leaves the DB
    // fully pre-v5 and the next boot retries cleanly. SQLite DDL is transactional.
    // The guard (`needsMachineMigration`) is STRUCTURAL — it inspects the actual
    // schema (machines table + machine_id columns) rather than the version marker —
    // so it is correct regardless of how the version number was previously bumped.
    const sessionCols = new Set(
      (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    const convCols = new Set(
      (this.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    // repos re-key: (path) PRIMARY KEY -> (machine_id, path) + origin_url.
    // Guard: only rebuild if the old single-column schema exists (no machine_id column).
    const repoCols = new Set(
      (this.db.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((c) => c.name),
    )
    const needsMachineMigration =
      !this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='machines'")
        .get() ||
      !sessionCols.has('machine_id') ||
      !convCols.has('machine_id') ||
      !repoCols.has('machine_id')
    if (needsMachineMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // The machines table is safe to CREATE IF NOT EXISTS on every boot.
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS machines (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             hostname TEXT NOT NULL,
             token_hash TEXT NOT NULL,
             created_at TEXT NOT NULL,
             last_seen_at TEXT NOT NULL
           )`,
        )
        if (!sessionCols.has('machine_id')) {
          this.db.exec(
            "ALTER TABLE sessions ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'",
          )
        }
        if (!convCols.has('machine_id')) {
          this.db.exec(
            "ALTER TABLE conversations ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'",
          )
        }
        if (!repoCols.has('machine_id')) {
          this.db.exec(
            `CREATE TABLE repos_v5 (
               machine_id TEXT NOT NULL DEFAULT '__local__',
               path TEXT NOT NULL,
               origin_url TEXT,
               repo_name TEXT,
               added_at TEXT NOT NULL,
               PRIMARY KEY (machine_id, path)
             )`,
          )
          this.db.exec(
            "INSERT INTO repos_v5 (machine_id, path, added_at) SELECT '__local__', path, added_at FROM repos",
          )
          this.db.exec('DROP TABLE repos')
          this.db.exec('ALTER TABLE repos_v5 RENAME TO repos')
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    }
    // Combined version marker. Two independent v5 lineages were merged: main's
    // conversation_id/issues schema and multi-machine's machines table + machine_id
    // attribution. Either alone recorded '5'; the merged schema is coherent only with
    // BOTH applied, so the unified marker is bumped to 6. Crucially this write lands
    // AFTER the structural machine migration above — a DB sitting at a main-only '5'
    // (conversation_id present, machines table absent) still triggers the STRUCTURAL
    // guard, gains the machines table + machine_id columns, and only then is recorded
    // as 6. The version number is never the migration gate (the guards are structural);
    // it is just an at-a-glance coherence marker.
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!v || Number(v.value) < 6)
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', '6')
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
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, added_at) VALUES ('__local__', ?, NULL, ?, ?)",
    )
    const now = new Date().toISOString()
    for (const p of parsed)
      if (typeof p === 'string') insert.run(p, p.split('/').pop() ?? null, now)
  }
}
