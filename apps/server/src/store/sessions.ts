/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import { AgentKind } from '@podium/protocol'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
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
        `SELECT id, agent_kind, model, effort, account_id, cwd, title, name, name_source, origin_kind, conversation_id,
                resume_kind,
                resume_value, status, exit_code, durable_label, created_at, last_active_at,
                terminal_cols, terminal_rows, working_ms_total,
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
                spawned_by, headless, issue_id, read_at, stopped_at, stop_reason, deleted_at, deletion_source,
                deleted_by_issue_id, workflow_run_id, workflow_step_id, execution_profile_id,
                ref_issue_id, ref_letter, ref_draft
         FROM sessions WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.mapSession(r))
  }

  private mapSession(r: Record<string, unknown>): SessionRow {
    return {
      id: r.id as string,
      agentKind: r.agent_kind as string,
      ...(r.model != null ? { model: r.model as string } : {}),
      ...(r.effort != null ? { effort: r.effort as string } : {}),
      ...(r.account_id != null ? { accountId: r.account_id as string } : {}),
      cwd: r.cwd as string,
      title: r.title as string,
      name: (r.name as string | null) ?? null,
      // Anything else on disk (an old/rogue value) reads as "nobody named it" rather
      // than as a source that could out-rank the user (#490).
      nameSource: r.name_source === 'user' || r.name_source === 'agent' ? r.name_source : null,
      originKind: r.origin_kind as 'spawn' | 'resume',
      conversationId: (r.conversation_id as string | null) ?? null,
      resumeKind: (r.resume_kind as string | null) ?? null,
      resumeValue: (r.resume_value as string | null) ?? null,
      status: r.status as SessionStatusPersisted,
      exitCode: (r.exit_code as number | null) ?? null,
      durableLabel: r.durable_label as string,
      createdAt: r.created_at as string,
      lastActiveAt: r.last_active_at as string,
      geometry: {
        cols:
          Number.isInteger(r.terminal_cols) && Number(r.terminal_cols) > 0
            ? Number(r.terminal_cols)
            : 80,
        rows:
          Number.isInteger(r.terminal_rows) && Number(r.terminal_rows) > 0
            ? Number(r.terminal_rows)
            : 24,
      },
      ...(r.working_ms_total != null ? { workingMsTotal: r.working_ms_total as number } : {}),
      archived: r.archived === 1,
      workState: (r.work_state as string | null) ?? null,
      machineId: (r.machine_id as string | null) ?? '__local__',
      lastOutputAt: (r.last_output_at as string | null) ?? null,
      lastInputAt: (r.last_input_at as string | null) ?? null,
      lastResumedAt: (r.last_resumed_at as string | null) ?? null,
      spawnedBy: (r.spawned_by as string | null) ?? null,
      headless: r.headless === 1,
      issueId: (r.issue_id as string | null) ?? null,
      refIssueId: (r.ref_issue_id as string | null) ?? null,
      refLetter: (r.ref_letter as string | null) ?? null,
      refDraft: (r.ref_draft as number | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
      stoppedAt: (r.stopped_at as string | null) ?? null,
      stopReason:
        r.stop_reason === 'self' || r.stop_reason === 'parent' || r.stop_reason === 'forced'
          ? r.stop_reason
          : null,
      workflowRunId: (r.workflow_run_id as string | null) ?? null,
      workflowStepId: (r.workflow_step_id as string | null) ?? null,
      executionProfileId: (r.execution_profile_id as string | null) ?? null,
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
           (id, agent_kind, model, effort, account_id, cwd, title, name, name_source, origin_kind, conversation_id,
            resume_kind,
            resume_value, status, exit_code, durable_label, created_at, last_active_at,
            terminal_cols, terminal_rows, working_ms_total,
            archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
            spawned_by, headless, issue_id, read_at, stopped_at, stop_reason, deleted_at, deletion_source,
            deleted_by_issue_id, workflow_run_id, workflow_step_id, execution_profile_id,
            ref_issue_id, ref_letter, ref_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model = excluded.model,
           effort = excluded.effort,
           account_id = excluded.account_id,
           title = excluded.title,
           name = excluded.name,
           name_source = excluded.name_source,
           origin_kind = excluded.origin_kind,
           conversation_id = excluded.conversation_id,
           resume_kind = excluded.resume_kind,
           resume_value = excluded.resume_value,
           status = excluded.status,
           exit_code = excluded.exit_code,
           durable_label = excluded.durable_label,
           last_active_at = excluded.last_active_at,
           terminal_cols = excluded.terminal_cols,
           terminal_rows = excluded.terminal_rows,
           working_ms_total = excluded.working_ms_total,
           archived = excluded.archived,
           work_state = excluded.work_state,
           machine_id = excluded.machine_id,
           last_output_at = excluded.last_output_at,
           last_input_at = excluded.last_input_at,
           last_resumed_at = excluded.last_resumed_at,
           spawned_by = excluded.spawned_by,
           issue_id = excluded.issue_id,
           read_at = excluded.read_at,
           stopped_at = excluded.stopped_at,
           stop_reason = excluded.stop_reason,
           deleted_at = excluded.deleted_at,
           deletion_source = excluded.deletion_source,
           deleted_by_issue_id = excluded.deleted_by_issue_id,
           workflow_run_id = excluded.workflow_run_id,
           workflow_step_id = excluded.workflow_step_id,
           execution_profile_id = excluded.execution_profile_id,
           -- Birth name is PERMANENT (#474): once allocated it never changes, even
           -- when the session re-attaches to a different issue. COALESCE keeps the
           -- first non-null allocation.
           ref_issue_id = COALESCE(sessions.ref_issue_id, excluded.ref_issue_id),
           ref_letter = COALESCE(sessions.ref_letter, excluded.ref_letter),
           ref_draft = COALESCE(sessions.ref_draft, excluded.ref_draft)`,
      )
      .run(
        row.id,
        row.agentKind,
        row.model ?? null,
        row.effort ?? null,
        row.accountId ?? null,
        row.cwd,
        row.title,
        row.name,
        row.nameSource ?? null,
        row.originKind,
        row.conversationId,
        row.resumeKind,
        row.resumeValue,
        row.status,
        row.exitCode,
        row.durableLabel,
        row.createdAt,
        row.lastActiveAt,
        row.geometry?.cols ?? 80,
        row.geometry?.rows ?? 24,
        row.workingMsTotal ?? null,
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
        row.stoppedAt ?? null,
        row.stopReason ?? null,
        row.deletedAt ?? null,
        row.deletionSource ?? null,
        row.deletedByIssueId ?? null,
        row.workflowRunId ?? null,
        row.workflowStepId ?? null,
        row.executionProfileId ?? null,
        row.refIssueId ?? null,
        row.refLetter ?? null,
        row.refDraft ?? null,
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
    this.db.prepare('DELETE FROM offers WHERE session_id = ?').run(id) // [spec:SP-c7f1]
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

  // ---- agent action offers [spec:SP-c7f1] ----
  /** Every live offer, keyed by session — replayed onto SessionMeta at boot. A
   *  row with corrupt JSON actions is dropped rather than failing the load. */
  listOffers(): OfferMap {
    const rows = this.db
      .prepare('SELECT session_id, message, actions, created_at FROM offers')
      .all() as { session_id: string; message: string; actions: string; created_at: string }[]
    const out: OfferMap = {}
    for (const r of rows) {
      try {
        const actions = JSON.parse(r.actions)
        if (!Array.isArray(actions)) continue
        out[r.session_id] = { message: r.message, actions, createdAt: r.created_at }
      } catch {
        // corrupt row -> treat as no offer
      }
    }
    return out
  }

  /** Set (replace) the live offer for a session. */
  setOffer(sessionId: string, offer: OfferRecord): void {
    const id = sessionId.trim()
    if (!id) throw new Error('offer session id is empty')
    this.db
      .prepare(
        `INSERT INTO offers (session_id, message, actions, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message = excluded.message,
           actions = excluded.actions,
           created_at = excluded.created_at`,
      )
      .run(id, offer.message, JSON.stringify(offer.actions), offer.createdAt)
  }

  /** Remove a session's offer (no-op if none). */
  clearOffer(sessionId: string): void {
    this.db.prepare('DELETE FROM offers WHERE session_id = ?').run(sessionId.trim())
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

  // ---- versioned drafts (POD-859, Draft Sync v2) ----
  // The same `session_drafts` row, read/written with its versioning columns
  // (`rev`, `origin`, `history`). Used only by the flag-on versioned path; the
  // legacy `loadDrafts`/`setDraft` above stay byte-for-byte for the flag-off path.
  // `updatedAt` doubles as the doc's `editedAt`.
  //
  // COLUMN-GUARDED as defense-in-depth: the drizzle migration adds these columns,
  // and drizzle applies by NAME so a fresh unique migration always runs (unlike the
  // old skip-by-version runner). But loadDraftDocs() runs UNCONDITIONALLY at boot
  // (flag-independent), so if the columns are somehow absent — a DB opened before
  // its migration applied, a schema-ahead lineage — degrade to the legacy shape
  // instead of a `no such column: rev` crash-loop with the flag OFF.
  private hasVersionedDraftCols: boolean | undefined

  private versionedDraftColumns(): boolean {
    if (this.hasVersionedDraftCols === undefined) {
      const cols = new Set(
        (this.db.prepare('PRAGMA table_info(session_drafts)').all() as { name: string }[]).map(
          (c) => c.name,
        ),
      )
      this.hasVersionedDraftCols = cols.has('rev') && cols.has('origin') && cols.has('history')
      if (!this.hasVersionedDraftCols) {
        // Surface the silent degradation once: the versioned-draft columns are
        // missing, so Draft Sync v2's versioned persistence is inert on this DB.
        console.warn(
          '[podium] session_drafts is missing the versioned-draft columns ' +
            '(rev/origin/history) — the session-drafts-versioned migration has not applied; ' +
            'Draft Sync v2 falls back to legacy drafts.',
        )
      }
    }
    return this.hasVersionedDraftCols
  }

  /** All persisted draft docs, keyed by session. Legacy rows (or a DB where the
   *  versioning migration has not applied) read back with `rev: 0`, `origin: null`,
   *  and an empty history. */
  loadDraftDocs(): Record<string, StoredDraftDoc> {
    const versioned = this.versionedDraftColumns()
    const sql = versioned
      ? 'SELECT session_id, text, updated_at, rev, origin, history FROM session_drafts'
      : 'SELECT session_id, text, updated_at FROM session_drafts'
    const rows = this.db.prepare(sql).all() as {
      session_id: string
      text: string
      updated_at: string
      rev?: number | null
      origin?: string | null
      history?: string | null
    }[]
    const out: Record<string, StoredDraftDoc> = {}
    for (const r of rows) {
      out[r.session_id] = {
        text: r.text,
        updatedAt: r.updated_at,
        rev: r.rev ?? 0,
        origin: r.origin ?? null,
        history: parseHistory(r.history ?? null),
      }
    }
    return out
  }

  /** Upsert (non-empty) or delete (empty text) a versioned draft doc. Empty text
   *  removes the row just like {@link setDraft}, so a cleared draft never lingers.
   *  On a DB without the versioning columns, degrades to a legacy text-only write. */
  setDraftDoc(sessionId: string, doc: StoredDraftDoc): void {
    const id = sessionId.trim()
    if (!id) return
    if (!doc.text) {
      this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
      return
    }
    if (!this.versionedDraftColumns()) {
      // Columns absent: persist text only. rev/history won't survive a restart on
      // this DB, but nothing crashes and no data is lost.
      this.setDraft(id, doc.text)
      return
    }
    this.db
      .prepare(
        `INSERT INTO session_drafts (session_id, text, updated_at, rev, origin, history)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           text = excluded.text, updated_at = excluded.updated_at,
           rev = excluded.rev, origin = excluded.origin, history = excluded.history`,
      )
      .run(id, doc.text, doc.updatedAt, doc.rev, doc.origin, JSON.stringify(doc.history))
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
