import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeSettings, type PodiumSettings } from '@podium/core'
import { openDatabase, type SqlDatabase } from '@podium/core/sqlite'
import { AgentKind, IssueStage } from '@podium/protocol'
import { MIGRATIONS, runMigrations } from './migrations/index'
import { deriveRepoId, isPathFallbackRepoId, readLocalOriginUrl } from './repo-id'

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

export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (/^\/+$/u.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/u, '')
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
  /** WHO created the session (issue #60): 'user', 'issue:<id>', 'superagent:<threadId>', …
   *  null/absent = legacy row from before the field existed. Optional (like machineId)
   *  so pre-#60 row literals stay valid. */
  spawnedBy?: string | null
  archived: boolean
  /** Kanban column on the home board; null = unsorted. */
  workState: string | null
  /** The machine this session runs on. Optional during build-out (Task 5 always emits it). */
  machineId?: string
  /** True for a headless harness session (no PTY; superagent-driven turns).
   *  Optional so pre-existing row literals stay valid; absent = false. */
  headless?: boolean
  /** Explicit issue attachment (issue-as-workspace). null/absent = unattached
   *  (legacy / shells) — cwd-derived worktree grouping applies. */
  issueId?: string | null
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  session; null/absent = never opened. Optional so pre-existing row literals stay valid. */
  readAt?: string | null
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
  /** Stable repo identity (#74) — dual-written; reads/filters/seq stay on repoPath. */
  repoId?: string | null
  seq: number
  title: string
  description: string
  stage: string
  worktreePath: string | null
  branch: string | null
  parentBranch: string
  defaultAgent: string
  defaultModel: string
  defaultEffort: string
  /** Machine (daemon) this issue's agents run on; null = pick by repo affinity. */
  machineId?: string | null
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
  needsHuman: boolean
  humanQuestion: string | null
  /** Agent-published human-facing panel, stored as raw JSON (parsed in IssueService).
   *  Optional so pre-existing row literals (tests, ingest) stay valid; absent = none. */
  panel?: string | null
  /** Whose intent this issue captures ('human' | 'agent'). Optional so pre-existing
   *  row literals stay valid; absent = 'human'. */
  origin?: string
  /** Placeholder-titled draft vessel (issue-as-workspace); retitling clears it.
   *  Optional so pre-existing row literals stay valid; absent = false. */
  draft?: boolean
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  issue; null/absent = never opened. Optional so pre-existing row literals stay valid. */
  readAt?: string | null
}

export interface IssueCommentRow {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
}

/** One "agent mail" message addressed to an ISSUE (issue #103). Status lifecycle:
 *  unread → read (inbox listing) → claimed (an agent committing to act on it). */
export interface IssueMessageRow {
  id: string
  issueId: string
  fromAuthor: string
  body: string
  createdAt: string
  status: 'unread' | 'read' | 'claimed'
  claimedBy: string | null
  readAt: string | null
  claimedAt: string | null
}

/** A durable event subscription (event-subscriptions design, Phase B). The steward
 *  matches enabled rows against every polled event; a match resolves `source` to the
 *  event's subject and delivers per `deliverNudge`/`deliverNotify`. */
export interface Subscription {
  id: string
  /** Who is notified: a session (in-session nudge) or an issue (its member sessions). */
  subscriberKind: 'session' | 'issue'
  subscriberId: string
  /** The subscription-event kind matched (e.g. 'issue.closed', 'session.finished'). */
  event: string
  /** What is watched: a dynamic relationship, or an explicit issue / session id. */
  sourceKind: 'relationship' | 'issue' | 'session'
  sourceRef: string
  deliverNudge: boolean
  deliverNotify: boolean
  origin: 'default' | 'custom'
  enabled: boolean
  createdAt: string
}

function rowToSubscription(r: Record<string, unknown>): Subscription {
  return {
    id: r.id as string,
    subscriberKind: r.subscriber_kind as Subscription['subscriberKind'],
    subscriberId: r.subscriber_id as string,
    event: r.event as string,
    sourceKind: r.source_kind as Subscription['sourceKind'],
    sourceRef: r.source_ref as string,
    deliverNudge: Number(r.deliver_nudge) !== 0,
    deliverNotify: Number(r.deliver_notify) !== 0,
    origin: r.origin as Subscription['origin'],
    enabled: Number(r.enabled) !== 0,
    createdAt: r.created_at as string,
  }
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

/** A superagent conversation: the always-there 'global' thread, a per-session 'btw'
 *  thread, or a per-repo 'concierge' intake thread. */
export interface SuperagentThreadRow {
  id: string
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: string
  /** The repo this thread fronts (concierge threads only). */
  repoPath?: string
  title?: string
  /** High-water mark into the origin session's transcript (btw threads), or the
   *  issue event-log id already digested (concierge threads, stringified). */
  watermarkItemId?: string
  watermarkTs?: string
  /** Harness agent frozen onto the thread at its first headless turn — later
   *  turns keep the same agent even if the settings default changes. */
  agentKind?: string
  /** The Podium headless session rendering this thread (concierge unification). */
  podiumSessionId?: string
  /** The harness's own session id — the resume value for every later turn. */
  harnessSessionId?: string
  /** PTY session holding the "open in terminal" one-writer lock; sendTurn
   *  rejects while this session is live (lazily checked, lazily cleared). */
  terminalSessionId?: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

/** Durable server-side store: repos + sessions registry. Single writer (the server). */
export class SessionStore {
  private readonly db: SqlDatabase
  /** FTS5 is compiled into the bundled SQLite normally; LIKE fallback if not. */
  private ftsAvailable = false
  /** transcript_fts created (docs/spec/search-v1.md §2.3). When FTS5 is missing the
   *  transcript index is skipped entirely — transcripts are too big for a LIKE
   *  fallback, and search simply omits the source. */
  private transcriptFtsAvailable = false

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    // Versioned migration runner first (stamps schema_version, refuses to open a
    // DB newer than the code), then the legacy idempotent DDL — Phase 1 converts
    // the latter into numbered migrations (see src/migrations/).
    runMigrations(this.db, MIGRATIONS)
    this.migrate()
  }

  // ---- repos ----

  /** Full repo rows including machineId, originUrl and repoId (multi-machine schema). */
  listRepos(
    machineId?: string,
  ): { machineId: string; path: string; originUrl: string | null; repoId: string | null }[] {
    const rows = (
      machineId
        ? this.db
            .prepare(
              'SELECT machine_id, path, origin_url, repo_id FROM repos WHERE machine_id = ? ORDER BY rowid ASC',
            )
            .all(machineId)
        : this.db
            .prepare('SELECT machine_id, path, origin_url, repo_id FROM repos ORDER BY rowid ASC')
            .all()
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      machineId: r.machine_id as string,
      path: r.path as string,
      originUrl: (r.origin_url as string | null) ?? null,
      repoId: (r.repo_id as string | null) ?? null,
    }))
  }

  /** Back-compat: flat list of paths across all machines. RepoRegistry.list() uses this. */
  listRepoPaths(machineId?: string): string[] {
    return this.listRepos(machineId).map((r) => r.path)
  }

  // No path validation here by design — RepoRegistry (the caller) rejects empty/non-absolute paths.
  addRepo(path: string, machineId = '__local__', originUrl?: string): void {
    // readLocalOriginUrl is a no-op (null) for paths that don't exist on this host,
    // so remote-machine repos simply get the path-fallback id until a scan reports
    // their origin (updateRepoOrigin then upgrades it).
    const normalizedPath = normalizeRepoPath(path)
    const origin = originUrl ?? readLocalOriginUrl(normalizedPath) ?? undefined
    this.db
      .prepare(
        'INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, repo_id, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        machineId,
        normalizedPath,
        origin ?? null,
        normalizedPath.split('/').pop() ?? null,
        deriveRepoId({ originUrl: origin, machineId, path: normalizedPath }),
        new Date().toISOString(),
      )
  }

  /**
   * Record a scan-reported origin URL for a registered repo. Upgrades a
   * path-fallback repo_id to the origin-derived id (and dual-writes the new id
   * onto issues bucketed under that repo) — but never rewrites an id that was
   * already origin-derived, so identities stay stable if the remote moves.
   */
  updateRepoOrigin(machineId: string, path: string, originUrl: string): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db
      .prepare('SELECT path, repo_id FROM repos WHERE machine_id = ?')
      .all(machineId) as { path: string; repo_id: string | null }[]
    const row = rows.find((r) => normalizeRepoPath(r.path) === normalizedPath)
    if (!row) return

    const newId = deriveRepoId({ originUrl, machineId, path: normalizedPath })
    const upgrade =
      isPathFallbackRepoId(row.repo_id, machineId, row.path) ||
      isPathFallbackRepoId(row.repo_id, machineId, normalizedPath)
    const repoId = upgrade ? newId : row.repo_id

    let targetPath = row.path
    if (row.path !== normalizedPath) {
      const result = this.db
        .prepare('UPDATE OR IGNORE repos SET path = ? WHERE machine_id = ? AND path = ?')
        .run(normalizedPath, machineId, row.path) as { changes?: number }
      if ((result.changes ?? 0) > 0) {
        targetPath = normalizedPath
      } else {
        this.db
          .prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
          .run(machineId, row.path)
        targetPath = normalizedPath
      }
    }

    this.db
      .prepare('UPDATE repos SET origin_url = ?, repo_id = ? WHERE machine_id = ? AND path = ?')
      .run(originUrl, repoId, machineId, targetPath)
    for (const duplicate of rows) {
      if (duplicate.path !== targetPath && normalizeRepoPath(duplicate.path) === normalizedPath) {
        this.db
          .prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
          .run(machineId, duplicate.path)
      }
    }
    if (upgrade) {
      const stmt = this.db.prepare(
        "UPDATE issues SET repo_id = ? WHERE repo_path = ? OR repo_path LIKE ? || '/%'",
      )
      for (const repoPath of new Set([row.path, normalizedPath]))
        stmt.run(newId, repoPath, repoPath)
    }
  }

  /** repo_id for an issue's repoPath: the longest registered repo root that contains
   *  it (any machine), else the deterministic '__local__' path-fallback. */
  resolveRepoIdForPath(repoPath: string): string {
    const normalizedRepoPath = normalizeRepoPath(repoPath)
    const match = this.listRepos()
      .map((r) => ({ ...r, path: normalizeRepoPath(r.path) }))
      .filter(
        (r) =>
          normalizedRepoPath === r.path ||
          normalizedRepoPath.startsWith(r.path === '/' ? r.path : `${r.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    return match?.repoId ?? deriveRepoId({ machineId: '__local__', path: normalizedRepoPath })
  }

  removeRepo(path: string, machineId = '__local__'): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db.prepare('SELECT path FROM repos WHERE machine_id = ?').all(machineId) as {
      path: string
    }[]
    const remove = this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
    for (const row of rows) {
      if (normalizeRepoPath(row.path) === normalizedPath) remove.run(machineId, row.path)
    }
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
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
                spawned_by, headless, issue_id, read_at
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
      spawnedBy: (r.spawned_by as string | null) ?? null,
      headless: r.headless === 1,
      issueId: (r.issue_id as string | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
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
            archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
            spawned_by, headless, issue_id, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           last_resumed_at = excluded.last_resumed_at,
           spawned_by = excluded.spawned_by,
           issue_id = excluded.issue_id,
           read_at = excluded.read_at`,
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
        row.spawnedBy ?? null,
        row.headless ? 1 : 0,
        row.issueId ?? null,
        row.readAt ?? null,
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

  // ---- live model catalog (SWR cache, persisted so it survives restarts and the
  //      first picker-open after a redeploy is instant, not a cold ~2s probe) ----
  getModelCatalog(): {
    byAgent: Record<string, Array<{ value: string; label: string; efforts?: string[] }>>
    fetchedAt: number
    version?: number
  } | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('model_catalog') as
      | { value: string }
      | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value)
      return parsed && typeof parsed === 'object' && parsed.byAgent ? parsed : null
    } catch {
      return null
    }
  }

  setModelCatalog(snapshot: {
    byAgent: Record<string, unknown>
    fetchedAt: number
    version?: number
  }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('model_catalog', JSON.stringify(snapshot))
  }

  // ---- node⇄hub upstream sync (docs/spec/node-hub-sync.md) ----
  /** Last hub oplog seq this node applied (meta key). Null until the first catch-up. */
  getUpstreamCursor(): number | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('upstream_sync_cursor') as { value: string } | undefined
    if (!row) return null
    const n = Number(row.value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  setUpstreamCursor(cursor: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('upstream_sync_cursor', String(cursor))
  }

  /**
   * Issues RECEIVED from the hub, stored verbatim as a JSON blob — deliberately NOT
   * merged into this node's IssueService (two issue stores merge in P7b; this is the
   * P7b input, kept durable so nothing received is lost across restarts).
   */
  setUpstreamIssuesJson(json: string): void {
    this.setUpstreamBlob('upstream_issues', json)
  }

  getUpstreamIssuesJson(): string | null {
    return this.getUpstreamBlob('upstream_issues')
  }

  /** Last-known hub sessions/conversations (wire JSON). Durable so a restarted
   *  UpstreamSync resumes from its persisted cursor with a DELTA applied on top
   *  of this base — a delta over an empty replica would silently drop entities. */
  setUpstreamSessionsJson(json: string): void {
    this.setUpstreamBlob('upstream_sessions', json)
  }

  getUpstreamSessionsJson(): string | null {
    return this.getUpstreamBlob('upstream_sessions')
  }

  setUpstreamConversationsJson(json: string): void {
    this.setUpstreamBlob('upstream_conversations', json)
  }

  getUpstreamConversationsJson(): string | null {
    return this.getUpstreamBlob('upstream_conversations')
  }

  private setUpstreamBlob(key: string, json: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, json)
  }

  private getUpstreamBlob(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  // ---- client (human UI) login sessions ----
  /** Record a login session keyed by the SHA-256 of its cookie token. */
  createClientSession(tokenHash: string, expiresAt: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO client_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
      )
      .run(tokenHash, new Date().toISOString(), expiresAt)
  }

  getClientSession(tokenHash: string): { expiresAt: string } | undefined {
    const row = this.db
      .prepare('SELECT expires_at FROM client_sessions WHERE token_hash = ?')
      .get(tokenHash) as { expires_at: string } | undefined
    return row ? { expiresAt: row.expires_at } : undefined
  }

  /** Push out an existing session's expiry (sliding/rolling renewal). No-op if absent. */
  extendClientSession(tokenHash: string, expiresAt: string): void {
    this.db
      .prepare('UPDATE client_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(expiresAt, tokenHash)
  }

  /** True iff the session exists and has not expired as of `nowIso`. */
  isClientSessionValid(tokenHash: string, nowIso: string): boolean {
    const session = this.getClientSession(tokenHash)
    return Boolean(session && session.expiresAt > nowIso)
  }

  deleteClientSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM client_sessions WHERE token_hash = ?').run(tokenHash)
  }

  /** Revoke every client login session ("sign out everywhere"). */
  deleteAllClientSessions(): void {
    this.db.prepare('DELETE FROM client_sessions').run()
  }

  /** Housekeeping: drop sessions whose expiry has passed. */
  deleteExpiredClientSessions(nowIso: string): void {
    this.db.prepare('DELETE FROM client_sessions WHERE expires_at <= ?').run(nowIso)
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
      .prepare(`SELECT * FROM superagent_threads WHERE archived = 0 ORDER BY updated_at DESC`)
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
    kind: 'global' | 'btw' | 'concierge'
    originSessionId?: string
    repoPath?: string
    title?: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO superagent_threads (id, kind, origin_session_id, repo_path, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, title), archived = 0, updated_at = ?`,
      )
      .run(
        t.id,
        t.kind,
        t.originSessionId ?? null,
        t.repoPath ?? null,
        t.title ?? null,
        now,
        now,
        now,
      )
  }

  setThreadWatermark(id: string, itemId: string, ts: string | undefined): void {
    this.db
      .prepare('UPDATE superagent_threads SET watermark_item_id = ?, watermark_ts = ? WHERE id = ?')
      .run(itemId, ts ?? null, id)
  }

  /** Patch the headless-session binding columns on a thread. Only the fields
   *  present in `patch` are written; `terminalSessionId: null` clears the
   *  terminal one-writer lock. */
  updateSuperagentThreadBinding(
    id: string,
    patch: {
      agentKind?: string
      podiumSessionId?: string
      harnessSessionId?: string
      terminalSessionId?: string | null
    },
  ): void {
    const sets: string[] = []
    const args: (string | null)[] = []
    if (patch.agentKind !== undefined) {
      sets.push('agent_kind = ?')
      args.push(patch.agentKind)
    }
    if (patch.podiumSessionId !== undefined) {
      sets.push('podium_session_id = ?')
      args.push(patch.podiumSessionId)
    }
    if (patch.harnessSessionId !== undefined) {
      sets.push('harness_session_id = ?')
      args.push(patch.harnessSessionId)
    }
    if (patch.terminalSessionId !== undefined) {
      sets.push('terminal_session_id = ?')
      args.push(patch.terminalSessionId)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    args.push(new Date().toISOString())
    this.db
      .prepare(`UPDATE superagent_threads SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
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
      kind: r.kind as 'global' | 'btw' | 'concierge',
      originSessionId: (r.origin_session_id as string | null) ?? undefined,
      repoPath: (r.repo_path as string | null) ?? undefined,
      title: (r.title as string | null) ?? undefined,
      watermarkItemId: (r.watermark_item_id as string | null) ?? undefined,
      watermarkTs: (r.watermark_ts as string | null) ?? undefined,
      agentKind: (r.agent_kind as string | null) ?? undefined,
      podiumSessionId: (r.podium_session_id as string | null) ?? undefined,
      harnessSessionId: (r.harness_session_id as string | null) ?? undefined,
      terminalSessionId: (r.terminal_session_id as string | null) ?? undefined,
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
           (id, repo_path, repo_id, seq, title, description, stage, worktree_path, branch, parent_branch,
            default_agent, default_model, default_effort, machine_id,
            linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
            suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
            priority, type, assignee, parent_id, design, acceptance, notes, due_at,
            defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
            needs_human, human_question, panel,
            created_at, updated_at, archived, origin, draft, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repo_id = excluded.repo_id,
           title = excluded.title, description = excluded.description, stage = excluded.stage,
           worktree_path = excluded.worktree_path, branch = excluded.branch,
           parent_branch = excluded.parent_branch, default_agent = excluded.default_agent,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           machine_id = excluded.machine_id,
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
           needs_human = excluded.needs_human, human_question = excluded.human_question,
           panel = excluded.panel,
           updated_at = excluded.updated_at, archived = excluded.archived,
           origin = excluded.origin, draft = excluded.draft, read_at = excluded.read_at`,
      )
      .run(
        row.id,
        row.repoPath,
        row.repoId ?? this.resolveRepoIdForPath(row.repoPath),
        row.seq,
        row.title,
        row.description,
        row.stage,
        row.worktreePath,
        row.branch,
        row.parentBranch,
        row.defaultAgent,
        row.defaultModel,
        row.defaultEffort,
        row.machineId ?? null,
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
        row.needsHuman ? 1 : 0,
        row.humanQuestion,
        row.panel ?? null,
        row.createdAt,
        row.updatedAt,
        row.archived ? 1 : 0,
        row.origin ?? 'human',
        row.draft ? 1 : 0,
        row.readAt ?? null,
      )
  }

  private mapIssueRow(r: Record<string, unknown>): IssueRow {
    return {
      id: r.id as string,
      repoPath: r.repo_path as string,
      repoId: (r.repo_id as string | null) ?? null,
      seq: r.seq as number,
      title: r.title as string,
      description: (r.description as string) ?? '',
      stage: r.stage as string,
      worktreePath: (r.worktree_path as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      parentBranch: r.parent_branch as string,
      defaultAgent: r.default_agent as string,
      defaultModel: (r.default_model as string | null) ?? 'auto',
      defaultEffort: (r.default_effort as string | null) ?? 'auto',
      machineId: (r.machine_id as string | null) ?? null,
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
      needsHuman: r.needs_human === 1,
      humanQuestion: (r.human_question as string | null) ?? null,
      panel: (r.panel as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: r.archived === 1,
      origin: (r.origin as string | null) ?? 'human',
      draft: r.draft === 1,
      readAt: (r.read_at as string | null) ?? null,
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
    // Clear dangling scalar back-references on OTHER rows so a deleted id never
    // lingers as a ghost parent/supersede/duplicate pointer (column-vs-edge
    // divergence P3b fixed). The dep EDGES were already removed above.
    this.db.prepare('UPDATE issues SET parent_id = NULL WHERE parent_id = ?').run(id)
    this.db.prepare('UPDATE issues SET superseded_by = NULL WHERE superseded_by = ?').run(id)
    this.db.prepare('UPDATE issues SET duplicate_of = NULL WHERE duplicate_of = ?').run(id)
  }

  setIssueLabels(issueId: string, labels: string[]): void {
    const clean = [...new Set(labels.filter((l) => typeof l === 'string' && l.trim()))].map((l) =>
      l.trim(),
    )
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)',
    )
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
        .prepare(
          'SELECT to_id, type FROM issue_deps WHERE from_id = ? ORDER BY to_id ASC, type ASC',
        )
        .all(fromId) as { to_id: string; type: string }[]
    ).map((r) => ({ toId: r.to_id, type: r.type }))
  }

  listDependents(toId: string): { fromId: string; type: string }[] {
    return (
      this.db
        .prepare(
          'SELECT from_id, type FROM issue_deps WHERE to_id = ? ORDER BY from_id ASC, type ASC',
        )
        .all(toId) as { from_id: string; type: string }[]
    ).map((r) => ({ fromId: r.from_id, type: r.type }))
  }

  addIssueComment(c: IssueCommentRow): void {
    this.db
      .prepare(
        'INSERT INTO issue_comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(c.id, c.issueId, c.author, c.body, c.createdAt)
  }

  listIssueComments(issueId: string): IssueCommentRow[] {
    return (
      this.db
        .prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC')
        .all(issueId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      author: r.author as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))
  }

  // ---- issue mail (issue #103) ----

  private mapIssueMessage(r: Record<string, unknown>): IssueMessageRow {
    return {
      id: r.id as string,
      issueId: r.issue_id as string,
      fromAuthor: r.from_author as string,
      body: r.body as string,
      createdAt: r.created_at as string,
      status: r.status as IssueMessageRow['status'],
      claimedBy: (r.claimed_by as string | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
      claimedAt: (r.claimed_at as string | null) ?? null,
    }
  }

  addIssueMessage(m: IssueMessageRow): void {
    this.db
      .prepare(
        `INSERT INTO issue_messages
           (id, issue_id, from_author, body, created_at, status, claimed_by, read_at, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.issueId,
        m.fromAuthor,
        m.body,
        m.createdAt,
        m.status,
        m.claimedBy,
        m.readAt,
        m.claimedAt,
      )
  }

  getIssueMessage(id: string): IssueMessageRow | null {
    const r = this.db.prepare('SELECT * FROM issue_messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapIssueMessage(r) : null
  }

  listIssueMessages(
    issueId: string,
    opts?: { status?: IssueMessageRow['status'] },
  ): IssueMessageRow[] {
    const rows = (
      opts?.status
        ? this.db
            .prepare(
              'SELECT * FROM issue_messages WHERE issue_id = ? AND status = ? ORDER BY created_at ASC, id ASC',
            )
            .all(issueId, opts.status)
        : this.db
            .prepare(
              'SELECT * FROM issue_messages WHERE issue_id = ? ORDER BY created_at ASC, id ASC',
            )
            .all(issueId)
    ) as Record<string, unknown>[]
    return rows.map((r) => this.mapIssueMessage(r))
  }

  countUnreadIssueMessages(issueId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM issue_messages WHERE issue_id = ? AND status = 'unread'")
      .get(issueId) as { n: number }
    return r.n
  }

  /** Mark the given messages read. Only flips 'unread' rows (idempotent; never
   *  regresses a 'claimed' message back to 'read'). */
  markIssueMessagesRead(issueId: string, ids: string[], readAt: string): void {
    const upd = this.db.prepare(
      `UPDATE issue_messages SET status = 'read', read_at = ?
       WHERE issue_id = ? AND id = ? AND status = 'unread'`,
    )
    for (const id of ids) upd.run(readAt, issueId, id)
  }

  /** Atomic claim: exactly one caller wins; a second claim on the same message
   *  returns false. Single UPDATE guarded on status, so there is no read-then-write race. */
  claimIssueMessage(id: string, claimedBy: string, claimedAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE issue_messages SET status = 'claimed', claimed_by = ?, claimed_at = ?
         WHERE id = ? AND status != 'claimed'`,
      )
      .run(claimedBy, claimedAt, id)
    return r.changes === 1
  }

  deleteIssueMessagesForIssue(issueId: string): void {
    this.db.prepare('DELETE FROM issue_messages WHERE issue_id = ?').run(issueId)
  }

  deleteIssueChildRows(issueId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? OR to_id = ?').run(issueId, issueId)
    this.db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(issueId)
    this.deleteIssueMessagesForIssue(issueId)
  }

  nextIssueSeq(repoPath: string): number {
    const r = this.db
      .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?')
      .get(repoPath) as { m: number | null }
    return (r.m ?? 0) + 1
  }

  // ---- event log ----

  appendEvent(e: {
    ts: string
    kind: string
    subject: string
    repoPath?: string | null
    payload?: unknown
  }): number {
    const r = this.db
      .prepare(
        'INSERT INTO podium_events (ts, kind, subject, repo_path, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.ts, e.kind, e.subject, e.repoPath ?? null, JSON.stringify(e.payload ?? {}))
    return Number(r.lastInsertRowid)
  }

  listEventsSince(
    sinceId: number,
    opts?: { kinds?: string[]; repoPath?: string; limit?: number },
  ): Array<{
    id: number
    ts: string
    kind: string
    subject: string
    repoPath: string | null
    payload: unknown
  }> {
    const where = ['id > ?']
    const params: unknown[] = [sinceId]
    if (opts?.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`)
      params.push(...opts.kinds)
    }
    if (opts?.repoPath) {
      where.push('repo_path = ?')
      params.push(opts.repoPath)
    }
    params.push(opts?.limit ?? 200)
    const rows = this.db
      .prepare(`SELECT * FROM podium_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map((r) => {
      let payload: unknown = {}
      try {
        payload = JSON.parse(r.payload as string)
      } catch {}
      return {
        id: Number(r.id),
        ts: r.ts as string,
        kind: r.kind as string,
        subject: r.subject as string,
        repoPath: (r.repo_path as string | null) ?? null,
        payload,
      }
    })
  }

  /** The highest event id in the log (0 when empty) — the "now" mark for
   *  seeding a consumer cursor that must not replay history. */
  maxEventId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM podium_events').get() as {
      m: number | null
    }
    return r.m ?? 0
  }

  /**
   * Event-log retention (issue #61): delete rows older than maxAgeDays, and always
   * keep the total row count ≤ maxRows (dropping the oldest beyond the cap even if
   * young). Returns the number of rows deleted.
   *
   * Cursor safety: `id` is AUTOINCREMENT, so ids are never reused after deletion —
   * a consumer cursor (e.g. the steward's persisted `steward_state` cursor) stays
   * valid across pruning: listEventsSince(cursor) simply returns whatever retained
   * rows still lie above it. The one intentional gap: a consumer that was disabled
   * for longer than the retention window will silently miss the pruned events.
   * That is BY DESIGN — first-enable seeds the cursor to MAX(id) ("now") anyway,
   * so replaying deep history was never part of the contract.
   */
  pruneEvents(opts: { maxAgeDays: number; maxRows: number }): number {
    // ts is an ISO-8601 string, so lexicographic comparison == chronological.
    const cutoff = new Date(Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const byAge = this.db.prepare('DELETE FROM podium_events WHERE ts < ?').run(cutoff)
    // Row cap: keep only the newest maxRows rows (highest ids), regardless of age.
    const byCap = this.db
      .prepare(
        'DELETE FROM podium_events WHERE id NOT IN (SELECT id FROM podium_events ORDER BY id DESC LIMIT ?)',
      )
      .run(opts.maxRows)
    return Number(byAge.changes) + Number(byCap.changes)
  }

  // ---- steward state ----

  getStewardState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM steward_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setStewardState(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO steward_state (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  // ---- event subscriptions (event-subscriptions design, Phase B) ----

  addSubscription(sub: Subscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, subscriber_kind, subscriber_id, event, source_kind, source_ref,
            deliver_nudge, deliver_notify, origin, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.id,
        sub.subscriberKind,
        sub.subscriberId,
        sub.event,
        sub.sourceKind,
        sub.sourceRef,
        sub.deliverNudge ? 1 : 0,
        sub.deliverNotify ? 1 : 0,
        sub.origin,
        sub.enabled ? 1 : 0,
        sub.createdAt,
      )
  }

  removeSubscription(id: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
  }

  listSubscriptions(filter?: { subscriberId?: string }): Subscription[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter?.subscriberId) {
      where.push('subscriber_id = ?')
      params.push(filter.subscriberId)
    }
    const sql = `SELECT * FROM subscriptions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
    const rows = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]
    return rows.map(rowToSubscription)
  }

  listEnabledSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY created_at ASC')
      .all() as Record<string, unknown>[]
    return rows.map(rowToSubscription)
  }

  /** Record a (subscription, event) delivery. Returns true only when the pair was
   *  NEWLY inserted — a replay (or a same-poll double-match) returns false so the
   *  steward delivers exactly once. */
  markDelivered(subscriptionId: string, eventId: number): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO subscription_deliveries (subscription_id, event_id) VALUES (?, ?)',
      )
      .run(subscriptionId, eventId)
    return Number(r.changes) > 0
  }

  /** One-time, idempotent: mirror legacy issues.blocked_by arrays into issue_deps. */
  private backfillIssueDeps(): void {
    const rows = this.db
      .prepare("SELECT id, blocked_by FROM issues WHERE blocked_by != '[]'")
      .all() as {
      id: string
      blocked_by: string
    }[]
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, 'blocks')",
    )
    // blocked_by is populated by the AI assistant with branch names (e.g.
    // "issue/3-foo"), NOT issue ids. Only mirror an edge when the target resolves
    // to a real issue id, so phantom branch-name edges never accumulate on
    // every migrate() at server construction.
    const exists = this.db.prepare('SELECT 1 FROM issues WHERE id = ?')
    for (const r of rows) {
      let ids: unknown
      try {
        ids = JSON.parse(r.blocked_by)
      } catch {
        ids = []
      }
      if (Array.isArray(ids)) {
        for (const to of ids) if (typeof to === 'string' && to && exists.get(to)) ins.run(r.id, to)
      }
    }
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — the whole batch commits inside BEGIN IMMEDIATE, so no interleaving).
   * The caller (MetadataOplog) has already diffed; rows arrive only for real changes.
   */
  appendChanges(
    rows: { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }[],
    eventTime: number,
  ): number[] {
    if (rows.length === 0) return []
    const insert = this.db.prepare(
      'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
    )
    const seqs: number[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        insert.run(r.entity, r.entityId, r.op, r.payload, eventTime)
        seqs.push(this.lastInsertSeq())
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return seqs
  }

  private lastInsertSeq(): number {
    return (this.db.prepare('SELECT last_insert_rowid() AS seq').get() as { seq: number }).seq
  }

  /** Highest assigned seq ever (survives head-pruning via sqlite_sequence). 0 = none. */
  maxChangeSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get() as
      | { seq: number }
      | undefined
    return row?.seq ?? 0
  }

  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): number | null {
    const row = this.db.prepare('SELECT MIN(seq) AS seq FROM changes').get() as {
      seq: number | null
    }
    return row.seq
  }

  /**
   * Change rows with seq > cursor, in seq order. The CALLER decides whether the
   * cursor is still within the retained range (see MetadataOplog.changesSince) —
   * this is a plain range read.
   */
  changesSince(
    cursor: number,
    limit = 10_000,
  ): { seq: number; entity: string; entityId: string; op: string; payload: string | null }[] {
    const rows = this.db
      .prepare(
        'SELECT seq, entity, entity_id, op, payload FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(cursor, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      entity: r.entity as string,
      entityId: r.entity_id as string,
      op: r.op as string,
      payload: (r.payload as string | null) ?? null,
    }))
  }

  /**
   * Head-only retention: drop rows beyond the row budget (keep the newest
   * `keepRows`) OR older than the age budget — whichever deletes MORE. The old
   * AND-policy never pruned under sustained write rates (rows aged past 14 days
   * only after the table had grown unboundedly for weeks). Deletion is still
   * head-only: we compute the highest seq that satisfies either budget and delete
   * everything at-or-below it, so the retained seq range stays contiguous (an
   * aged row can never be removed from the middle of the range).
   */
  pruneChanges(opts: { keepRows: number; maxAgeMs: number; now: number }): void {
    const rowCapSeq = this.maxChangeSeq() - opts.keepRows
    const aged = this.db
      .prepare('SELECT MAX(seq) AS seq FROM changes WHERE event_time < ?')
      .get(opts.now - opts.maxAgeMs) as { seq: number | null }
    const thresholdSeq = Math.max(rowCapSeq, aged.seq ?? 0)
    if (thresholdSeq <= 0) return
    this.db.prepare('DELETE FROM changes WHERE seq <= ?').run(thresholdSeq)
  }

  /**
   * Fold the retained log to the latest state per (entity, id) — the boot seed for
   * MetadataOplog's diff baseline, so a restart emits deltas for anything that
   * changed while the server was down instead of silently rebasing.
   */
  latestChangeStates(): { entity: string; entityId: string; op: string; payload: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT c.entity, c.entity_id, c.op, c.payload FROM changes c
         JOIN (SELECT entity, entity_id, MAX(seq) AS seq FROM changes GROUP BY entity, entity_id) m
           ON m.entity = c.entity AND m.entity_id = c.entity_id AND m.seq = c.seq`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      entity: r.entity as string,
      entityId: r.entity_id as string,
      op: r.op as string,
      payload: (r.payload as string | null) ?? null,
    }))
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(mutationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT result FROM applied_mutations WHERE mutation_id = ?')
      .get(mutationId) as { result: string } | undefined
    return row?.result
  }

  recordAppliedMutation(mutationId: string, proc: string, result: string, appliedAt: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO applied_mutations (mutation_id, proc, result, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run(mutationId, proc, result, appliedAt)
  }

  pruneAppliedMutations(opts: { maxAgeMs: number; now: number }): void {
    this.db
      .prepare('DELETE FROM applied_mutations WHERE applied_at < ?')
      .run(opts.now - opts.maxAgeMs)
  }

  /** Enqueue a message; the id IS the mutationId, so a replayed enqueue is a no-op.
   *  Returns false when the id already existed (replay). */
  enqueueMessage(row: { id: string; sessionId: string; text: string; queuedAt: number }): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO queued_messages (id, session_id, text, queued_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.id, row.sessionId, row.text, row.queuedAt)
    return Number(r.changes) > 0
  }

  /** FIFO head-first queue for one session. */
  listQueuedMessages(sessionId: string): { id: string; text: string; attempts: number }[] {
    const rows = this.db
      .prepare(
        'SELECT id, text, attempts FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC, rowid ASC',
      )
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      attempts: r.attempts as number,
    }))
  }

  /** Per-session queued counts — the boot seed for Session.queuedMessageCount. */
  queuedMessageCounts(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) AS n FROM queued_messages GROUP BY session_id')
      .all() as { session_id: string; n: number }[]
    return new Map(rows.map((r) => [r.session_id, r.n]))
  }

  deleteQueuedMessage(id: string): void {
    this.db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id)
  }

  bumpQueuedAttempts(id: string): void {
    this.db.prepare('UPDATE queued_messages SET attempts = attempts + 1 WHERE id = ?').run(id)
  }

  /** Drop a dead session's queue (kill without resume ref, permanent delete). */
  deleteQueuedMessagesForSession(sessionId: string): void {
    this.db.prepare('DELETE FROM queued_messages WHERE session_id = ?').run(sessionId)
  }

  // ---- upstream issue-write outbox (docs/spec/node-hub-issues.md §2.2) ----

  /** Enqueue an issue mutation bound for the hub. The mutationId IS the PK, so a
   *  replayed enqueue is a no-op. Returns false when the id already existed. */
  enqueueUpstreamMutation(row: {
    mutationId: string
    proc: string
    input: string
    queuedAt: number
  }): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO upstream_outbox (mutation_id, proc, input, queued_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.mutationId, row.proc, row.input, row.queuedAt)
    return Number(r.changes) > 0
  }

  /** The full outbox, FIFO (drain order — serial, oldest first). */
  listUpstreamOutbox(): { mutationId: string; proc: string; input: string; attempts: number }[] {
    const rows = this.db
      .prepare(
        'SELECT mutation_id, proc, input, attempts FROM upstream_outbox ORDER BY queued_at ASC, rowid ASC',
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      mutationId: r.mutation_id as string,
      proc: r.proc as string,
      input: r.input as string,
      attempts: r.attempts as number,
    }))
  }

  deleteUpstreamMutation(mutationId: string): void {
    this.db.prepare('DELETE FROM upstream_outbox WHERE mutation_id = ?').run(mutationId)
  }

  bumpUpstreamMutationAttempts(mutationId: string): void {
    this.db
      .prepare('UPDATE upstream_outbox SET attempts = attempts + 1 WHERE mutation_id = ?')
      .run(mutationId)
  }

  // ---- conversation registry (docs/spec/conversation-registry.md) ----

  /** The Podium identity a native conversation maps to, or undefined if unseen. */
  conversationPodiumId(machineId: string, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT podium_id FROM conversation_segments WHERE machine_id = ? AND native_id = ?')
      .get(machineId, nativeId) as { podium_id: string } | undefined
    return row?.podium_id
  }

  /** Recorded transcript-path evidence for a native conversation (absolute path on
   *  its machine), or undefined when never observed. Consumed as the read-path
   *  hint so lookups skip cwd derivation AND the bucket sweep. */
  conversationSegmentPath(machineId: string, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT path FROM conversation_segments WHERE machine_id = ? AND native_id = ?')
      .get(machineId, nativeId) as { path: string | null } | undefined
    return row?.path ?? undefined
  }

  /**
   * Ensure a native conversation has an identity, minting one when it was never
   * seen (`linked_by: 'discovery'`). Idempotent: an existing segment never re-mints
   * (spec: same native id maps to the same identity forever). A parent provided
   * later fills a NULL parent_podium_id but never overwrites a non-null one —
   * mis-parenting is the failure mode to avoid.
   */
  ensureConversationIdentity(opts: {
    machineId: string
    nativeId: string
    providerId: string
    parentPodiumId?: string
    path?: string
    /** Transcript file size at scan time (discovery evidence). Persisted as
     *  `reported_bytes` so attach-time dirty reconciliation can use the LAST
     *  KNOWN size without waiting for a fresh scan (or sweeping everything). */
    sizeBytes?: number
  }): string {
    const existing = this.conversationPodiumId(opts.machineId, opts.nativeId)
    if (existing !== undefined) {
      if (opts.parentPodiumId) {
        this.db
          .prepare(
            'UPDATE conversation_identities SET parent_podium_id = ? WHERE podium_id = ? AND parent_podium_id IS NULL',
          )
          .run(opts.parentPodiumId, existing)
      }
      if (opts.path || opts.sizeBytes !== undefined) {
        // COALESCE keeps whichever evidence this call did NOT bring (a size-less
        // re-observation must not blank a previously reported size, or vice versa).
        this.db
          .prepare(
            'UPDATE conversation_segments SET path = COALESCE(?, path), reported_bytes = COALESCE(?, reported_bytes) WHERE machine_id = ? AND native_id = ?',
          )
          .run(opts.path ?? null, opts.sizeBytes ?? null, opts.machineId, opts.nativeId)
      }
      return existing
    }
    const podiumId = `conv_${randomUUID()}`
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO conversation_identities (podium_id, parent_podium_id, created_at) VALUES (?, ?, ?)',
      )
      .run(podiumId, opts.parentPodiumId ?? null, now)
    this.db
      .prepare(
        `INSERT INTO conversation_segments
           (machine_id, native_id, provider_id, podium_id, path, reported_bytes, seq_in_conv, linked_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'discovery', ?)`,
      )
      .run(
        opts.machineId,
        opts.nativeId,
        opts.providerId,
        podiumId,
        opts.path ?? null,
        opts.sizeBytes ?? null,
        now,
      )
    return podiumId
  }

  /**
   * Live-roll lineage (spec §3.1): the server observed a session's resume ref roll
   * from `priorNativeId` to `newNativeId` — attach the new native file as the NEXT
   * SEGMENT of the prior identity (minting the prior's identity if this is the
   * first time we see it). Returns the shared podium id. If the new id was already
   * linked (e.g. re-observed after a restart) this is a no-op returning its id.
   */
  linkConversationSegment(opts: {
    machineId: string
    newNativeId: string
    priorNativeId: string
    providerId: string
  }): string {
    const already = this.conversationPodiumId(opts.machineId, opts.newNativeId)
    if (already !== undefined) return already
    const podiumId = this.ensureConversationIdentity({
      machineId: opts.machineId,
      nativeId: opts.priorNativeId,
      providerId: opts.providerId,
    })
    const nextSeq =
      ((
        this.db
          .prepare('SELECT MAX(seq_in_conv) AS m FROM conversation_segments WHERE podium_id = ?')
          .get(podiumId) as { m: number | null }
      ).m ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO conversation_segments
           (machine_id, native_id, provider_id, podium_id, path, seq_in_conv, linked_by, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'live-roll', ?)`,
      )
      .run(
        opts.machineId,
        opts.newNativeId,
        opts.providerId,
        podiumId,
        nextSeq,
        new Date().toISOString(),
      )
    return podiumId
  }

  // ---- transcript mirror (docs/spec/transcript-mirror.md) ----

  /** Segments with known path evidence for one machine — the mirror work list.
   *  Cheap to call per scan: the caller diffs against in-flight state. */
  segmentsToMirror(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[] {
    const rows = this.db
      .prepare(
        'SELECT native_id, path, mirrored_bytes FROM conversation_segments WHERE machine_id = ? AND path IS NOT NULL',
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      path: r.path as string,
      mirroredBytes: r.mirrored_bytes as number,
    }))
  }

  /** DIRTY subset of {@link segmentsToMirror} (spec §2.3 "Dirty-driven"): segments
   *  whose last daemon-reported size disagrees with the mirrored cursor, plus
   *  NULL-reported rows (pre-upgrade / providers that never report a size) which
   *  count as dirty so one mirror pass can observe their size and quiet them.
   *  This is the per-scan/attach work list — a fully-mirrored fleet returns []. */
  segmentsToMirrorDirty(
    machineId: string,
  ): { nativeId: string; path: string; mirroredBytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT native_id, path, mirrored_bytes FROM conversation_segments
         WHERE machine_id = ? AND path IS NOT NULL
           AND (reported_bytes IS NULL OR reported_bytes != mirrored_bytes)`,
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      path: r.path as string,
      mirroredBytes: r.mirrored_bytes as number,
    }))
  }

  /** Record the file size the mirror OBSERVED at eof. Fresher than any scan report
   *  (the read just happened), and the convergence step for NULL-reported rows:
   *  after one successful pull, reported == mirrored and the segment goes quiet
   *  until a scan reports growth. */
  setReportedBytes(machineId: string, nativeId: string, bytes: number): void {
    this.db
      .prepare(
        'UPDATE conversation_segments SET reported_bytes = ? WHERE machine_id = ? AND native_id = ?',
      )
      .run(bytes, machineId, nativeId)
  }

  /** Last daemon-reported transcript size, or undefined when never reported. */
  reportedBytes(machineId: string, nativeId: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT reported_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { reported_bytes: number | null } | undefined
    return row?.reported_bytes ?? undefined
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare(
        'SELECT mirrored_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { mirrored_bytes: number } | undefined
    return row?.mirrored_bytes ?? 0
  }

  /** Advance (or, on rewrite, reset) the mirror cursor AFTER the lake write landed
   *  (spec invariant 2 — the cursor may lag the lake, never lead it). */
  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void {
    this.db
      .prepare(
        'UPDATE conversation_segments SET mirrored_bytes = ?, mirrored_at = ? WHERE machine_id = ? AND native_id = ?',
      )
      .run(bytes, at, machineId, nativeId)
  }

  // ---- transcript FTS index (docs/spec/search-v1.md §2.3) ----

  /** False when the runtime SQLite lacks FTS5 — the indexer then no-ops and search
   *  omits the transcript source (no LIKE degradation for transcript bodies). */
  get transcriptIndexAvailable(): boolean {
    return this.transcriptFtsAvailable
  }

  /** Segments whose lake copy holds bytes the FTS index hasn't consumed — the
   *  backfill work list (segmentsToMirror's shape; covers lakes mirrored before
   *  the indexer existed AND passes a budget stopped early). Cheap per trigger. */
  segmentsToIndex(
    machineId: string,
  ): { nativeId: string; mirroredBytes: number; indexedBytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT native_id, mirrored_bytes, indexed_bytes FROM conversation_segments
         WHERE machine_id = ? AND mirrored_bytes > indexed_bytes`,
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      mirroredBytes: r.mirrored_bytes as number,
      indexedBytes: r.indexed_bytes as number,
    }))
  }

  /** Bytes of the lake file already parsed into transcript_fts (≤ mirrored_bytes;
   *  the gap is the indexer's work list). */
  indexedCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare(
        'SELECT indexed_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { indexed_bytes: number } | undefined
    return row?.indexed_bytes ?? 0
  }

  /** Insert extracted message rows and advance the index cursor in ONE transaction —
   *  a crash can never leave rows indexed without the cursor (double-index on retry)
   *  or the cursor advanced without the rows (a silent gap). */
  appendTranscriptIndex(
    machineId: string,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): void {
    if (!this.transcriptFtsAvailable) return
    const insert = this.db.prepare(
      'INSERT INTO transcript_fts (content, machine_id, native_id, item_uuid, ts) VALUES (?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        insert.run(r.content, machineId, nativeId, r.itemUuid ?? null, r.ts ?? null)
      }
      this.db
        .prepare(
          'UPDATE conversation_segments SET indexed_bytes = ? WHERE machine_id = ? AND native_id = ?',
        )
        .run(indexedBytes, machineId, nativeId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** One segment's indexed rows in insertion (= transcript) order — a diagnostic /
   *  test seam; search goes through the MATCH path, never this scan. */
  transcriptIndexRows(
    machineId: string,
    nativeId: string,
  ): { content: string; itemUuid?: string; ts?: string }[] {
    if (!this.transcriptFtsAvailable) return []
    const rows = this.db
      .prepare(
        'SELECT content, item_uuid, ts FROM transcript_fts WHERE machine_id = ? AND native_id = ? ORDER BY rowid ASC',
      )
      .all(machineId, nativeId) as Record<string, unknown>[]
    return rows.map((r) => ({
      content: r.content as string,
      itemUuid: (r.item_uuid as string | null) ?? undefined,
      ts: (r.ts as string | null) ?? undefined,
    }))
  }

  /** BM25-ranked matches over the transcript index, one row per matched message,
   *  with a snippet() (matches wrapped in `**`) and the joins the search service
   *  needs: segments → podium id, conversations → display title + recency. `rank`
   *  is raw SQLite bm25 — smaller (more negative) = better; the caller normalizes.
   *  Empty when FTS5 is unavailable (the transcript source just goes dark). */
  searchTranscripts(
    query: string,
    limit = 30,
  ): {
    machineId: string
    nativeId: string
    itemUuid?: string
    ts?: string
    snippet: string
    rank: number
    podiumId?: string
    title?: string
    updatedAt?: string
  }[] {
    const q = query.trim()
    if (!q || !this.transcriptFtsAvailable) return []
    const ftsQuery = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ')
    const rows = this.db
      .prepare(
        `SELECT f.machine_id, f.native_id, f.item_uuid, f.ts,
                snippet(transcript_fts, 0, '**', '**', '…', 12) AS snip,
                bm25(transcript_fts) AS rank,
                s.podium_id, c.title, c.name, c.updated_at
         FROM transcript_fts f
         LEFT JOIN conversation_segments s
           ON s.machine_id = f.machine_id AND s.native_id = f.native_id
         LEFT JOIN conversations c ON c.id = f.native_id
         WHERE transcript_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, Math.min(200, Math.max(1, limit))) as Record<string, unknown>[]
    return rows.map((r) => ({
      machineId: r.machine_id as string,
      nativeId: r.native_id as string,
      itemUuid: (r.item_uuid as string | null) ?? undefined,
      ts: (r.ts as string | null) ?? undefined,
      snippet: r.snip as string,
      rank: r.rank as number,
      podiumId: (r.podium_id as string | null) ?? undefined,
      // User-set name wins over the harness title, matching every other surface.
      title: (r.name as string | null) ?? (r.title as string | null) ?? undefined,
      updatedAt: (r.updated_at as string | null) ?? undefined,
    }))
  }

  /** Substring match over issue comment bodies — comments have no FTS (bounded
   *  volume), so LIKE is enough for the omni-search's comment source. */
  searchIssueComments(
    query: string,
    limit = 30,
  ): { issueId: string; body: string; createdAt: string }[] {
    const q = query.trim()
    if (!q) return []
    const rows = this.db
      .prepare(
        `SELECT issue_id, body, created_at FROM issue_comments
         WHERE body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        Math.min(200, Math.max(1, limit)),
      ) as Record<string, unknown>[]
    return rows.map((r) => ({
      issueId: r.issue_id as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))
  }

  /** Re-mirror (truncate) invalidates the segment's indexed content: drop its FTS
   *  rows and reset the cursor so the reindex starts from byte 0 as chunks arrive. */
  dropTranscriptIndex(machineId: string, nativeId: string): void {
    if (this.transcriptFtsAvailable) {
      this.db
        .prepare('DELETE FROM transcript_fts WHERE machine_id = ? AND native_id = ?')
        .run(machineId, nativeId)
    }
    this.db
      .prepare(
        'UPDATE conversation_segments SET indexed_bytes = 0 WHERE machine_id = ? AND native_id = ?',
      )
      .run(machineId, nativeId)
  }

  /** Batch lookup for wire enrichment: native id → podium id (per machine). */
  conversationPodiumIds(machineId: string, nativeIds: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const q = this.db.prepare(
      'SELECT podium_id FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
    )
    for (const id of nativeIds) {
      const row = q.get(machineId, id) as { podium_id: string } | undefined
      if (row) out.set(id, row.podium_id)
    }
    return out
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
         repo_id TEXT,
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
         last_resumed_at TEXT,
         spawned_by TEXT,
         headless INTEGER NOT NULL DEFAULT 0,
         issue_id TEXT,
         read_at TEXT
       )`,
    )
    // Additive column for headless harness sessions (concierge unification).
    // Fresh DBs get it from the CREATE above; live DBs gain it in place.
    if (
      !(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
        (c) => c.name === 'headless',
      )
    ) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN headless INTEGER NOT NULL DEFAULT 0')
    }
    // Additive explicit issue attachment (issue-as-workspace). Structural guard.
    if (
      !(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
        (c) => c.name === 'issue_id',
      )
    ) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN issue_id TEXT')
    }
    // Additive email-style read state (issue #124). Structural guard; legacy rows read
    // NULL (never opened) and behave as unread until first marked read.
    if (
      !(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
        (c) => c.name === 'read_at',
      )
    ) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN read_at TEXT')
    }
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
    // Metadata oplog (docs/spec/oplog-read-path.md). AUTOINCREMENT is deliberate:
    // seq must stay monotonic across restarts even if the whole table was pruned
    // (a plain INTEGER PRIMARY KEY would reuse max(rowid)+1 and rewind cursors).
    // payload is the entity's WIRE-shape JSON (NULL for removes) — the oplog speaks
    // protocol, so replaying it needs no join back to entity tables.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS changes (
         seq        INTEGER PRIMARY KEY AUTOINCREMENT,
         entity     TEXT NOT NULL,
         entity_id  TEXT NOT NULL,
         op         TEXT NOT NULL,
         payload    TEXT,
         event_time INTEGER NOT NULL
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity, entity_id, seq)')
    // Outbox write path (docs/spec/outbox-write-path.md). applied_mutations makes
    // replayed writes no-ops (the stored result is returned instead of re-running);
    // queued_messages is the durable per-session send queue that replaced the
    // in-memory sendTextWhenReady timer (survives restarts, never drops silently).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS applied_mutations (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         result      TEXT NOT NULL,
         applied_at  INTEGER NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS queued_messages (
         id         TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         text       TEXT NOT NULL,
         queued_at  INTEGER NOT NULL,
         attempts   INTEGER NOT NULL DEFAULT 0
       )`,
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS queued_messages_session ON queued_messages(session_id, queued_at)',
    )
    // Node⇄hub issue write forwarding (docs/spec/node-hub-issues.md §2.2): the
    // durable outbox of issue mutations targeting viaHub issues, replayed to the
    // hub's tRPC with each entry's mutation_id (hub-side applied_mutations makes
    // the replays idempotent). mutation_id PK doubles as the enqueue dedupe.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS upstream_outbox (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         input       TEXT NOT NULL,
         queued_at   INTEGER NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0
       )`,
    )
    // Conversation registry (docs/spec/conversation-registry.md §3.1): identity is
    // Podium-generated and immutable; native session ids / file paths are EVIDENCE
    // attached as segments. A resume that rolls into a new native file adds a
    // segment to the same identity instead of becoming a brand-new conversation.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS conversation_identities (
         podium_id        TEXT PRIMARY KEY,
         parent_podium_id TEXT,
         created_at       TEXT NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS conversation_segments (
         machine_id  TEXT NOT NULL,
         native_id   TEXT NOT NULL,
         provider_id TEXT NOT NULL,
         podium_id   TEXT NOT NULL,
         path        TEXT,
         seq_in_conv INTEGER NOT NULL,
         linked_by   TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         mirrored_bytes INTEGER NOT NULL DEFAULT 0,
         mirrored_at TEXT,
         indexed_bytes INTEGER NOT NULL DEFAULT 0,
         reported_bytes INTEGER,
         PRIMARY KEY (machine_id, native_id)
       )`,
    )
    // Mirror-cursor columns (docs/spec/transcript-mirror.md §2.2) and the FTS-index
    // cursor (docs/spec/search-v1.md §2.3) — ALTER for DBs created by earlier
    // registry versions (the CREATE above no-ops there).
    {
      const segCols = new Set(
        (
          this.db.prepare('PRAGMA table_info(conversation_segments)').all() as { name: string }[]
        ).map((c) => c.name),
      )
      if (!segCols.has('mirrored_bytes'))
        this.db.exec(
          'ALTER TABLE conversation_segments ADD COLUMN mirrored_bytes INTEGER NOT NULL DEFAULT 0',
        )
      if (!segCols.has('mirrored_at'))
        this.db.exec('ALTER TABLE conversation_segments ADD COLUMN mirrored_at TEXT')
      if (!segCols.has('indexed_bytes'))
        this.db.exec(
          'ALTER TABLE conversation_segments ADD COLUMN indexed_bytes INTEGER NOT NULL DEFAULT 0',
        )
      // Dirty-driven mirror (transcript-mirror spec §2.3 "Dirty-driven"): the
      // daemon-reported transcript file size, NULLable on purpose — NULL marks a
      // pre-upgrade row that must count as dirty ONCE so the fleet converges.
      if (!segCols.has('reported_bytes'))
        this.db.exec('ALTER TABLE conversation_segments ADD COLUMN reported_bytes INTEGER')
    }
    // Repair rows poisoned by the pre-#94 discovery bug: a subagent transcript
    // summarized under its PARENT's native id clobbered the parent's segment
    // path, so reattach boot-seeded from the wrong file. A main transcript is
    // always named <native_id>.jsonl; a subagents/ path under any OTHER name is
    // never legitimate evidence. NULL just falls back to derivation — the next
    // discovery scan re-fills it correctly. Idempotent, runs every boot.
    this.db.exec(
      "UPDATE conversation_segments SET path = NULL WHERE path LIKE '%/subagents/%' AND path NOT LIKE '%/' || native_id || '.jsonl'",
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS conversation_segments_podium ON conversation_segments(podium_id, seq_in_conv)',
    )
    // Persistent human-client login sessions (web/desktop UI). We store only the SHA-256
    // of the cookie token, never the token itself, so a DB read can't mint a valid cookie.
    // Persisted (not in-memory) so a server redeploy doesn't force every device to re-login.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS client_sessions (
         token_hash TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
    )
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
    // Additive column for per-repo concierge threads (issue #64).
    const satCols = this.db.prepare('PRAGMA table_info(superagent_threads)').all() as {
      name: string
    }[]
    if (!satCols.some((c) => c.name === 'repo_path')) {
      this.db.exec('ALTER TABLE superagent_threads ADD COLUMN repo_path TEXT')
    }
    // Additive headless-session binding columns (concierge unification): the
    // harness agent frozen onto the thread at its first headless turn, the
    // Podium headless session rendering it, the harness's own resume id, and
    // the PTY session id while "open in terminal" holds the one-writer lock.
    for (const col of [
      'agent_kind',
      'podium_session_id',
      'harness_session_id',
      'terminal_session_id',
    ]) {
      if (!satCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE superagent_threads ADD COLUMN ${col} TEXT`)
      }
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
         repo_id TEXT,
         seq INTEGER NOT NULL,
         title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         stage TEXT NOT NULL,
         worktree_path TEXT,
         branch TEXT,
         parent_branch TEXT NOT NULL DEFAULT 'main',
         default_agent TEXT NOT NULL,
         default_model TEXT NOT NULL DEFAULT 'auto',
         default_effort TEXT NOT NULL DEFAULT 'auto',
         machine_id TEXT,
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
         needs_human INTEGER NOT NULL DEFAULT 0,
         human_question TEXT,
         panel TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0,
         origin TEXT NOT NULL DEFAULT 'human',
         draft INTEGER NOT NULL DEFAULT 0,
         read_at TEXT
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
    addIssueCol('repo_id', 'repo_id TEXT')
    addIssueCol('default_model', "default_model TEXT NOT NULL DEFAULT 'auto'")
    addIssueCol('default_effort', "default_effort TEXT NOT NULL DEFAULT 'auto'")
    addIssueCol('machine_id', 'machine_id TEXT')
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
    addIssueCol('needs_human', 'needs_human INTEGER NOT NULL DEFAULT 0')
    addIssueCol('human_question', 'human_question TEXT')
    addIssueCol('panel', 'panel TEXT')
    addIssueCol('origin', "origin TEXT NOT NULL DEFAULT 'human'")
    addIssueCol('draft', 'draft INTEGER NOT NULL DEFAULT 0')
    // Email-style read state (issue #124): nullable ISO timestamp, null = never opened.
    addIssueCol('read_at', 'read_at TEXT')
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
    // Agent mail (issue #103): messages addressed to an ISSUE, not a session.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_messages (
         id          TEXT PRIMARY KEY,
         issue_id    TEXT NOT NULL,
         from_author TEXT NOT NULL,
         body        TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'unread',
         claimed_by  TEXT,
         read_at     TEXT,
         claimed_at  TEXT
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_messages_issue ON issue_messages(issue_id)')
    // Durable orchestrator event log — append-only, cursor = the AUTOINCREMENT id.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS podium_events (
         id        INTEGER PRIMARY KEY AUTOINCREMENT,
         ts        TEXT NOT NULL,
         kind      TEXT NOT NULL,
         subject   TEXT NOT NULL,
         repo_path TEXT,
         payload   TEXT NOT NULL DEFAULT '{}'
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_podium_events_kind ON podium_events(kind)')
    // Steward bookkeeping (event-log cursor etc.) — a tiny KV kept separate from
    // `meta` so orchestrator state never collides with the settings blob's keys.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS steward_state (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    )
    // Durable event subscriptions (event-subscriptions design, Phase B): an agent
    // (or the seeded defaults) subscribes a subscriber to an event whose source
    // resolves to the event's subject. The steward matches enabled rows on every
    // poll and delivers per deliver_nudge/deliver_notify.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS subscriptions (
         id              TEXT PRIMARY KEY,
         subscriber_kind TEXT NOT NULL,
         subscriber_id   TEXT NOT NULL,
         event           TEXT NOT NULL,
         source_kind     TEXT NOT NULL,
         source_ref      TEXT NOT NULL,
         deliver_nudge   INTEGER NOT NULL DEFAULT 1,
         deliver_notify  INTEGER NOT NULL DEFAULT 0,
         origin          TEXT NOT NULL DEFAULT 'custom',
         enabled         INTEGER NOT NULL DEFAULT 1,
         created_at      TEXT NOT NULL
       )`,
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_id)',
    )
    // Idempotent, replay-safe delivery ledger: one row per (subscription, event)
    // actually delivered. markDelivered's INSERT OR IGNORE is the dedup — a
    // cursor-rewind replay re-matches but never re-delivers.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS subscription_deliveries (
         subscription_id TEXT NOT NULL,
         event_id        INTEGER NOT NULL,
         PRIMARY KEY (subscription_id, event_id)
       )`,
    )
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
    // Transcript FTS (docs/spec/search-v1.md §2.3): one row per user/assistant
    // message, fed incrementally by the mirror-driven indexer. Contentful (not
    // external-content) — the source of truth is the lake file, and snippet()
    // needs the text stored. No LIKE fallback: without FTS5 the transcript source
    // is simply absent from search (transcripts are far too big to LIKE-scan).
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
           content, machine_id UNINDEXED, native_id UNINDEXED,
           item_uuid UNINDEXED, ts UNINDEXED
         )`,
      )
      this.transcriptFtsAvailable = true
    } catch {
      this.transcriptFtsAvailable = false
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
    // Additive provenance column (issue #60): WHO created the session. Legacy rows
    // read NULL (creator unknown). Structural guard, no version marker change.
    if (!colNames.has('spawned_by')) this.db.exec('ALTER TABLE sessions ADD COLUMN spawned_by TEXT')
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
    // v7 -> v8: stable repo identity (#74). Structural guard: repos.repo_id may be
    // missing either on a pre-v8 DB or right after the machine-migration rebuild
    // above (repos_v5 is created without it), so re-inspect the actual schema here.
    const repoColsV8 = new Set(
      (this.db.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!repoColsV8.has('repo_id')) this.db.exec('ALTER TABLE repos ADD COLUMN repo_id TEXT')
    // v8 -> v9: email-style read state (issue #124) — additive read_at columns on
    // issues + sessions. Structural guards above do the real migration; this marker is
    // just the at-a-glance coherence bump.
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!v || Number(v.value) < 9)
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', '9')
    this.importReposJson()
    this.backfillRepoIds()
  }

  /** v8 backfill (idempotent — only touches NULL repo_id rows, so it is safe to run
   *  every boot and also covers rows inserted by importReposJson above). */
  private backfillRepoIds(): void {
    const repos = this.db
      .prepare('SELECT machine_id, path, origin_url FROM repos WHERE repo_id IS NULL')
      .all() as { machine_id: string; path: string; origin_url: string | null }[]
    const setRepo = this.db.prepare(
      'UPDATE repos SET repo_id = ? WHERE machine_id = ? AND path = ?',
    )
    for (const r of repos) {
      setRepo.run(
        deriveRepoId({ originUrl: r.origin_url, machineId: r.machine_id, path: r.path }),
        r.machine_id,
        r.path,
      )
    }
    const issues = this.db
      .prepare('SELECT id, repo_path FROM issues WHERE repo_id IS NULL')
      .all() as {
      id: string
      repo_path: string
    }[]
    const setIssue = this.db.prepare('UPDATE issues SET repo_id = ? WHERE id = ?')
    for (const i of issues) setIssue.run(this.resolveRepoIdForPath(i.repo_path), i.id)
    // Self-heal origins for repos whose path exists on this host: pre-v8 rows never
    // recorded origin_url, so without this they'd sit on path-fallback ids until a
    // daemon scan happens to run. updateRepoOrigin upgrades fallback ids only (and
    // dual-writes issues), so this is idempotent — once recorded, the read is skipped.
    const originless = this.db
      .prepare('SELECT machine_id, path FROM repos WHERE origin_url IS NULL')
      .all() as { machine_id: string; path: string }[]
    for (const r of originless) {
      const origin = readLocalOriginUrl(r.path)
      if (origin) this.updateRepoOrigin(r.machine_id, r.path, origin)
    }
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
