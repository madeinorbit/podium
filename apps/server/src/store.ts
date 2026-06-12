import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type PinKind = 'panel' | 'worktree' | 'repo'

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo'])

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
  originKind: 'spawn' | 'resume'
  conversationId: string | null
  resumeKind: string | null
  resumeValue: string | null
  status: SessionStatusPersisted
  exitCode: number | null
  durableLabel: string
  createdAt: string
  lastActiveAt: string
}

/** Durable server-side store: repos + sessions registry. Single writer (the server). */
export class SessionStore {
  private readonly db: DatabaseSync

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
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
        `SELECT id, agent_kind, cwd, title, origin_kind, conversation_id, resume_kind,
                resume_value, status, exit_code, durable_label, created_at, last_active_at
         FROM sessions ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      agentKind: r.agent_kind as string,
      cwd: r.cwd as string,
      title: r.title as string,
      originKind: r.origin_kind as 'spawn' | 'resume',
      conversationId: (r.conversation_id as string | null) ?? null,
      resumeKind: (r.resume_kind as string | null) ?? null,
      resumeValue: (r.resume_value as string | null) ?? null,
      status: r.status as SessionStatusPersisted,
      exitCode: (r.exit_code as number | null) ?? null,
      durableLabel: r.durable_label as string,
      createdAt: r.created_at as string,
      lastActiveAt: r.last_active_at as string,
    }))
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, agent_kind, cwd, title, origin_kind, conversation_id, resume_kind,
            resume_value, status, exit_code, durable_label, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           origin_kind = excluded.origin_kind,
           conversation_id = excluded.conversation_id,
           resume_kind = excluded.resume_kind,
           resume_value = excluded.resume_value,
           status = excluded.status,
           exit_code = excluded.exit_code,
           durable_label = excluded.durable_label,
           last_active_at = excluded.last_active_at`,
      )
      .run(
        row.id,
        row.agentKind,
        row.cwd,
        row.title,
        row.originKind,
        row.conversationId,
        row.resumeKind,
        row.resumeValue,
        row.status,
        row.exitCode,
        row.durableLabel,
        row.createdAt,
        row.lastActiveAt,
      )
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM pins WHERE kind = ? AND id = ?').run('panel', id)
    this.scrubTabOrders(id)
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
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         cwd TEXT NOT NULL,
         title TEXT NOT NULL,
         origin_kind TEXT NOT NULL,
         conversation_id TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         status TEXT NOT NULL,
         exit_code INTEGER,
         durable_label TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tab_order (
         worktree TEXT PRIMARY KEY,
         ids TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    )
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    // v1 -> v2: tmux_label -> durable_label (the label now names an abduco OR tmux
    // session; see the durable-backend selection in the daemon). For a pre-rename db
    // the CREATE above no-ops, so the old column is still there — rename it in place.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'tmux_label')) {
      this.db.exec('ALTER TABLE sessions RENAME COLUMN tmux_label TO durable_label')
    }
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!v || v.value === '1')
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', '2')
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
