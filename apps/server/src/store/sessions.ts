/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import { AgentKind } from '@podium/protocol'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
import type {
  PinKind,
  PinState,
  SessionDeletionSource,
  SessionRow,
  SessionStatusPersisted,
  SnoozeMap,
} from './types'

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo'])

export class SessionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  // ---- sessions ----
  loadSessions(): SessionRow[] {
    return this.readSessions('deleted_at IS NULL')
  }

  /** All session tombstones, for repository-level inspection and maintenance. */
  loadDeletedSessions(): SessionRow[] {
    return this.readSessions('deleted_at IS NOT NULL')
  }

  /** Recoverable session tombstones created by one issue deletion. */
  loadDeletedSessionsForIssue(issueId: string): SessionRow[] {
    return this.readSessions(
      "deleted_at IS NOT NULL AND deletion_source = 'issue' AND deleted_by_issue_id = ?",
      issueId,
    )
  }

  private readSessions(where: string, ...params: SqlParam[]): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_kind, cwd, title, name, origin_kind, conversation_id, resume_kind,
                resume_value, status, exit_code, durable_label, created_at, last_active_at,
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
                spawned_by, headless, issue_id, read_at, deleted_at, deletion_source,
                deleted_by_issue_id
         FROM sessions WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.mapSession(r))
  }

  private mapSession(r: Record<string, unknown>): SessionRow {
    return {
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
      deletedAt: (r.deleted_at as string | null) ?? null,
      deletionSource: (r.deletion_source as SessionDeletionSource | null) ?? null,
      deletedByIssueId: (r.deleted_by_issue_id as string | null) ?? null,
    }
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
            spawned_by, headless, issue_id, read_at, deleted_at, deletion_source,
            deleted_by_issue_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           read_at = excluded.read_at,
           deleted_at = excluded.deleted_at,
           deletion_source = excluded.deletion_source,
           deleted_by_issue_id = excluded.deleted_by_issue_id`,
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
        row.deletedAt ?? null,
        row.deletionSource ?? null,
        row.deletedByIssueId ?? null,
      )
  }

  /** Tombstone sessions without destroying their metadata or UI satellites. */
  softDeleteSessions(
    ids: string[],
    deletedAt: string,
    source: SessionDeletionSource,
    deletedByIssueId: string | null = null,
  ): void {
    const update = this.db.prepare(
      `UPDATE sessions SET deleted_at = ?, deletion_source = ?, deleted_by_issue_id = ?
       WHERE id = ? AND deleted_at IS NULL`,
    )
    for (const id of ids) update.run(deletedAt, source, deletedByIssueId, id)
  }

  /** Mark sessions as deleted by an issue so restoring that issue can recover them. */
  softDeleteForIssue(ids: string[], issueId: string, deletedAt: string): void {
    this.softDeleteSessions(ids, deletedAt, 'issue', issueId)
  }

  /** Re-expose an issue's tombstoned sessions as honestly exited runtime records. */
  restoreDeletedForIssue(issueId: string): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET deleted_at = NULL, deletion_source = NULL, deleted_by_issue_id = NULL,
             status = 'exited', exit_code = NULL
         WHERE deleted_at IS NOT NULL AND deletion_source = 'issue' AND deleted_by_issue_id = ?`,
      )
      .run(issueId)
  }

  /** Irreversibly remove a session and its satellites. Internal maintenance only. */
  purgeSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM pins WHERE kind = ? AND id = ?').run('panel', id)
    this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
    this.scrubTabOrders(id)
  }

  /** Multi-machine adoption: rewrite placeholder '__local__' rows to the real id. */
  adoptLocalRows(machineId: string): void {
    this.db
      .prepare("UPDATE sessions SET machine_id = ? WHERE machine_id = '__local__'")
      .run(machineId)
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

  /** Drop a session id from every saved tab order during irreversible purge. */
  private scrubTabOrders(sessionId: string): void {
    for (const [worktree, ids] of Object.entries(this.listTabOrders())) {
      if (!ids.includes(sessionId)) continue
      this.setTabOrder(
        worktree,
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
}
