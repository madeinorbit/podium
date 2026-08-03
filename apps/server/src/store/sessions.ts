/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import {
  type AccountId,
  type ActorKind,
  actorColumns,
  actorFromColumns,
  AgentKind,
  asSessionId,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
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
import { requireUserId } from './helpers'

const PIN_KINDS = new Set<PinKind>(['panel', 'worktree', 'repo'])

export class SessionsRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly purgeObservationCheckpoint: (sessionId: SessionId) => void = () => {},
  ) {}

  // ---- sessions ----
  loadSessions(): SessionRow[] {
    return this.readSessions('deleted_at IS NULL')
  }

  /** One durable row, including a tombstone, for scoped delete visibility. */
  getSession(sessionId: SessionId): SessionRow | undefined {
    return this.readSessions('id = ?', sessionId)[0]
  }

  /**
   * The live session a conversation resumes into, by its `resumeValue`.
   *
   * A QUERY RATHER THAN A SCAN, and that is the whole point (POD-1614). Feed
   * visibility asks this question once per conversation row of a bootstrap, and
   * the caller used to answer it with `loadSessions().find(…)` — a 49-column
   * load of every live session, mapped into objects, per row. On the live corpus
   * (2019 conversation rows x 1115 sessions) that was 18.9 s of synchronous CPU
   * inside one `authority.bootstrap()` call, which blocked the event loop whole.
   *
   * SAME ROW AS THE SCAN IT REPLACES, deliberately: `readSessions` supplies the
   * `created_at ASC, rowid ASC` order, so taking `[0]` here picks exactly the
   * entry a `.find()` over `loadSessions()` returned when several sessions share
   * a `resumeValue`. `deleted_at IS NULL` is restated for the same reason — it is
   * the filter `loadSessions` applied, not an added condition.
   */
  findSessionByResumeValue(resumeValue: string): SessionRow | undefined {
    return this.readSessions('resume_value = ? AND deleted_at IS NULL', resumeValue)[0]
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
        `SELECT id, owner_user_id, agent_kind, model, effort, account_id, cwd, title, name, name_source, origin_kind, conversation_id,
                resume_kind,
                resume_value, status, exit_code, spawn_failure, durable_label, created_at, last_active_at,
                terminal_cols, terminal_rows, working_ms_total, input_count, output_count, activity_count,
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
                spawned_by, headless, issue_id, stopped_at, stop_reason, deleted_at, deletion_source,
                deleted_by_issue_id, workflow_run_id, workflow_step_id, execution_profile_id,
                ref_issue_id, ref_letter, ref_draft,
                created_by_actor_kind, created_by_actor_id, created_by_on_behalf_of
         FROM sessions WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.mapSession(r))
  }

  /**
   * SERIALIZATION EDGE — the one place a sqlite `Record<string, unknown>` becomes
   * a `SessionRow`. Every cast is a decode of an untyped column, brands included:
   * sqlite carries no brand, so this is where a stored string re-enters the branded
   * id space. NOT POD-361 adapter casts; above this function every session id is
   * branded.
   */
  private mapSession(r: Record<string, unknown>): SessionRow {
    return {
      id: r.id as SessionId,
      ownerUserId: r.owner_user_id as UserId,
      agentKind: r.agent_kind as string,
      ...(r.model != null ? { model: r.model as string } : {}),
      ...(r.effort != null ? { effort: r.effort as string } : {}),
      ...(r.account_id != null ? { accountId: r.account_id as AccountId } : {}),
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
      spawnFailure: (r.spawn_failure as string | null) ?? null,
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
      ...(Number(r.input_count) > 0 ? { inputCount: Number(r.input_count) } : {}),
      ...(Number(r.output_count) > 0 ? { outputCount: Number(r.output_count) } : {}),
      ...(Number(r.activity_count) > 0 ? { activityCount: Number(r.activity_count) } : {}),
      archived: r.archived === 1,
      workState: (r.work_state as string | null) ?? null,
      // SERIALIZATION EDGE: untyped from sqlite; the machine id re-enters its id space.
      machineId: r.machine_id as MachineId,
      lastOutputAt: (r.last_output_at as string | null) ?? null,
      lastInputAt: (r.last_input_at as string | null) ?? null,
      lastResumedAt: (r.last_resumed_at as string | null) ?? null,
      spawnedBy: (r.spawned_by as string | null) ?? null,
      // THE ATTRIBUTION PAIR (POD-1516). BOTH id columns must be present for a
      // pair to exist — a kind with no id is a half-written row, and decoding it
      // would mint an actor with an empty id that compares equal to every other
      // empty one. `null` here is the honest "no pair recorded"; it is NEVER
      // filled in from `owner_user_id` or `spawned_by`, which answer different
      // questions (see the migration).
      // ABSENT, not `null`, when no pair was recorded. One spelling for one fact:
      // a row carrying `createdBy: null` beside rows that simply omit the key
      // would be two encodings of "nobody recorded this", and the whole point of
      // this field is that its absence has a single unambiguous meaning.
      ...(r.created_by_actor_kind != null && r.created_by_actor_id != null
        ? {
            createdBy: {
              // SERIALIZATION EDGE: the actor's id re-enters the branded id space.
              actor: actorFromColumns(
                r.created_by_actor_kind as ActorKind,
                r.created_by_actor_id as string,
              ),
              // The INNER null stays: it is the representable "no human behind
              // this" for the machine and system arms, which is a different fact
              // from the pair being absent altogether.
              onBehalfOf: (r.created_by_on_behalf_of as UserId | null) ?? null,
            },
          }
        : {}),
      headless: r.headless === 1,
      issueId: (r.issue_id as IssueId | null) ?? null,
      refIssueId: (r.ref_issue_id as IssueId | null) ?? null,
      refLetter: (r.ref_letter as string | null) ?? null,
      refDraft: (r.ref_draft as number | null) ?? null,
      stoppedAt: (r.stopped_at as string | null) ?? null,
      stopReason:
        r.stop_reason === 'self' ||
        r.stop_reason === 'parent' ||
        r.stop_reason === 'forced' ||
        r.stop_reason === 'exited'
          ? r.stop_reason
          : null,
      workflowRunId: (r.workflow_run_id as string | null) ?? null,
      workflowStepId: (r.workflow_step_id as string | null) ?? null,
      executionProfileId: (r.execution_profile_id as string | null) ?? null,
      deletedAt: (r.deleted_at as string | null) ?? null,
      deletionSource: (r.deletion_source as SessionDeletionSource | null) ?? null,
      deletedByIssueId: (r.deleted_by_issue_id as IssueId | null) ?? null,
    }
  }

  upsertSession(row: SessionRow): void {
    if (!row.ownerUserId) {
      throw new Error(`upsertSession: ownerUserId is required for ${row.id}`)
    }
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
           (id, owner_user_id, agent_kind, model, effort, account_id, cwd, title, name, name_source, origin_kind, conversation_id,
            resume_kind,
            resume_value, status, exit_code, spawn_failure, durable_label, created_at, last_active_at,
            terminal_cols, terminal_rows, working_ms_total, input_count, output_count, activity_count,
            archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at,
            spawned_by, headless, issue_id, stopped_at, stop_reason, deleted_at, deletion_source,
            deleted_by_issue_id, workflow_run_id, workflow_step_id, execution_profile_id,
            ref_issue_id, ref_letter, ref_draft,
            created_by_actor_kind, created_by_actor_id, created_by_on_behalf_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
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
           spawn_failure = excluded.spawn_failure,
           durable_label = excluded.durable_label,
           last_active_at = excluded.last_active_at,
           terminal_cols = excluded.terminal_cols,
           terminal_rows = excluded.terminal_rows,
           working_ms_total = excluded.working_ms_total,
           input_count = excluded.input_count,
           output_count = excluded.output_count,
           activity_count = excluded.activity_count,
           archived = excluded.archived,
           work_state = excluded.work_state,
           machine_id = excluded.machine_id,
           last_output_at = excluded.last_output_at,
           last_input_at = excluded.last_input_at,
           last_resumed_at = excluded.last_resumed_at,
           spawned_by = excluded.spawned_by,
           issue_id = excluded.issue_id,
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
           ref_draft = COALESCE(sessions.ref_draft, excluded.ref_draft),
           -- ATTRIBUTION IS IMMUTABLE AFTER CREATE (POD-365's
           -- SESSION_IMMUTABLE_AFTER_CREATE lists \`createdBy\`). COALESCE keeps the
           -- pair stamped at birth: an upsert from a later code path — a status
           -- change, a rename, a reattach — must not be able to re-attribute the
           -- session to whoever happened to trigger it. It can only FILL a pair
           -- that was never recorded, never overwrite one that was.
           created_by_actor_kind = COALESCE(sessions.created_by_actor_kind, excluded.created_by_actor_kind),
           created_by_actor_id = COALESCE(sessions.created_by_actor_id, excluded.created_by_actor_id),
           created_by_on_behalf_of = COALESCE(sessions.created_by_on_behalf_of, excluded.created_by_on_behalf_of)`,
      )
      .run(
        row.id,
        row.ownerUserId,
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
        row.spawnFailure ?? null,
        row.durableLabel,
        row.createdAt,
        row.lastActiveAt,
        row.geometry?.cols ?? 80,
        row.geometry?.rows ?? 24,
        row.workingMsTotal ?? null,
        row.inputCount ?? 0,
        row.outputCount ?? 0,
        row.activityCount ?? 0,
        row.archived ? 1 : 0,
        row.workState,
        row.machineId,
        row.lastOutputAt ?? null,
        row.lastInputAt ?? null,
        row.lastResumedAt ?? null,
        row.spawnedBy ?? null,
        row.headless ? 1 : 0,
        row.issueId ?? null,
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
        row.createdBy ? actorColumns(row.createdBy.actor).kind : null,
        row.createdBy ? actorColumns(row.createdBy.actor).id : null,
        row.createdBy?.onBehalfOf ?? null,
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
  purgeSession(id: SessionId): void {
    this.purgeObservationCheckpoint(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM pins WHERE kind = ? AND id = ?').run('panel', id)
    this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM session_user_state WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM offers WHERE session_id = ?').run(id) // [spec:SP-c7f1]
    this.scrubTabOrders(id)
  }

  // ---- pins (PER-USER STATE, POD-380) ----
  //
  // Keyed (user_id, kind, id). `userId` is REQUIRED and leading on every method
  // here rather than optional-with-a-default: a defaulted user id is how one
  // person ends up reading another's rows, and the point of the re-key is that the
  // caller must say whose state it is touching. Server-internal paths that have no
  // principal pass SOLE_USER_ID explicitly, which makes them greppable for
  // POD-1077 (the scoped feed that finally makes the broadcast per-principal).
  listPins(userId: string): PinState {
    const rows = this.db
      .prepare('SELECT kind, id FROM pins WHERE user_id = ? ORDER BY rowid ASC')
      .all(userId) as {
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

  setPin(userId: string, kind: PinKind, id: string, pinned: boolean): void {
    if (!PIN_KINDS.has(kind)) throw new Error(`invalid pin kind: ${kind}`)
    requireUserId(userId)
    const cleanId = id.trim()
    if (!cleanId) throw new Error('pin id is empty')
    if (pinned) {
      this.db
        .prepare('INSERT OR IGNORE INTO pins (user_id, kind, id, pinned_at) VALUES (?, ?, ?, ?)')
        .run(userId, kind, cleanId, new Date().toISOString())
    } else {
      this.db
        .prepare('DELETE FROM pins WHERE user_id = ? AND kind = ? AND id = ?')
        .run(userId, kind, cleanId)
    }
  }

  // ---- per-user session read state (POD-1076) ----
  /**
   * One user's read markers, `sessionId → readAt`. PER-USER STATE keyed
   * `(user_id, session_id)`: `sessions.read_at` was one column for the whole
   * instance until POD-1076, which asserted that exactly one person exists.
   *
   * Returns only sessions this user has opened. An absent key is "never opened",
   * which is the ONLY spelling — see {@link markSessionUnread}.
   */
  listReadAt(userId: string): Record<string, string | null> {
    requireUserId(userId)
    const rows = this.db
      .prepare('SELECT session_id, read_at FROM session_user_state WHERE user_id = ?')
      .all(userId) as { session_id: string; read_at: string | null }[]
    const out: Record<string, string | null> = {}
    for (const r of rows) out[r.session_id] = r.read_at
    return out
  }

  getReadAt(userId: string, sessionId: SessionId): string | null {
    requireUserId(userId)
    const row = this.db
      .prepare('SELECT read_at FROM session_user_state WHERE user_id = ? AND session_id = ?')
      .get(userId, sessionId.trim()) as { read_at: string | null } | undefined
    return row?.read_at ?? null
  }

  markSessionRead(userId: string, sessionId: SessionId, readAt: string): void {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('read-state session id is empty')
    this.db
      .prepare(
        `INSERT INTO session_user_state (user_id, session_id, read_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, session_id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run(userId, id, readAt)
  }

  /** DELETES the row rather than writing a null. Absence and `read_at IS NULL`
   *  would be two spellings of "never opened", and a table with two spellings of
   *  one fact acquires a second meaning nobody documented. */
  markSessionUnread(userId: string, sessionId: SessionId): void {
    requireUserId(userId)
    this.db
      .prepare('DELETE FROM session_user_state WHERE user_id = ? AND session_id = ?')
      .run(userId, sessionId.trim())
  }

  /**
   * Delete EVERY user's read marker for a session — "re-arm unread for all
   * readers", the terminal-transition rule (POD-1076).
   *
   * Takes no `userId` on purpose, and that is the one place in this family where
   * a write legitimately crosses owners: the session became something new, which
   * is true for everybody. It is not a widening — it removes rows, so no reader
   * ever sees another reader's state.
   */
  clearAllReadAt(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM session_user_state WHERE session_id = ?').run(sessionId.trim())
  }

  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time. */
  listSnoozes(userId: string, now: number = Date.now()): SnoozeMap {
    const rows = this.db
      .prepare('SELECT session_id, snoozed_until FROM snoozes WHERE user_id = ?')
      .all(userId) as {
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
    // The lazy delete stays scoped to the reader: housekeeping on read must never
    // drop somebody else's row, even an expired one.
    for (const id of expired) {
      this.db.prepare('DELETE FROM snoozes WHERE user_id = ? AND session_id = ?').run(userId, id)
    }
    return out
  }

  /** Snooze a session for one user. `until` = null → until next message; ISO
   *  string → timed. PER-USER STATE (POD-380) — see the note on {@link listPins}. */
  setSnooze(userId: string, sessionId: SessionId, until: string | null): void {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('snooze session id is empty')
    this.db
      .prepare(
        `INSERT INTO snoozes (user_id, session_id, snoozed_until, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, session_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
      )
      .run(userId, id, until, new Date().toISOString())
  }

  /** Un-snooze a session for one user (no-op if not snoozed). */
  clearSnooze(userId: string, sessionId: SessionId): void {
    this.db
      .prepare('DELETE FROM snoozes WHERE user_id = ? AND session_id = ?')
      .run(userId, sessionId.trim())
  }

  hasAnySnooze(sessionId: SessionId): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS present FROM snoozes WHERE session_id = ? LIMIT 1')
        .get(sessionId.trim()) !== undefined
    )
  }

  /** Clear every viewer's independent snooze after a shared session event. */
  clearAllSnoozes(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(sessionId.trim())
  }

  // ---- agent action offers [spec:SP-c7f1] ----
  /** Every live offer, keyed by session — replayed onto SessionMeta at boot. A
   *  row with corrupt JSON actions is dropped rather than failing the load. */
  listOffers(): OfferMap {
    const rows = this.db
      .prepare('SELECT session_id, message, actions, artifacts, created_at FROM offers')
      .all() as {
      session_id: string
      message: string
      actions: string
      artifacts: string | null
      created_at: string
    }[]
    const out: OfferMap = {}
    for (const r of rows) {
      try {
        const actions = JSON.parse(r.actions)
        if (!Array.isArray(actions)) continue
        // A corrupt artifacts column degrades to "no artifacts", not "no offer".
        let artifacts: string[] | undefined
        if (r.artifacts != null) {
          try {
            const parsed = JSON.parse(r.artifacts)
            if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
              artifacts = parsed
            }
          } catch {}
        }
        out[r.session_id] = {
          message: r.message,
          actions,
          ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
          createdAt: r.created_at,
        }
      } catch {
        // corrupt row -> treat as no offer
      }
    }
    return out
  }

  /** Set (replace) the live offer for a session. */
  setOffer(sessionId: SessionId, offer: OfferRecord): void {
    const id = sessionId.trim()
    if (!id) throw new Error('offer session id is empty')
    this.db
      .prepare(
        `INSERT INTO offers (session_id, message, actions, artifacts, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message = excluded.message,
           actions = excluded.actions,
           artifacts = excluded.artifacts,
           created_at = excluded.created_at`,
      )
      .run(
        id,
        offer.message,
        JSON.stringify(offer.actions),
        offer.artifacts && offer.artifacts.length > 0 ? JSON.stringify(offer.artifacts) : null,
        offer.createdAt,
      )
  }

  /** Remove a session's offer (no-op if none). */
  clearOffer(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM offers WHERE session_id = ?').run(sessionId.trim())
  }

  // ---- tab order ----
  /** Manual tab order per worktree path. Worktrees never reordered are absent. */
  listTabOrders(userId: string): Record<string, string[]> {
    const rows = this.db
      .prepare('SELECT worktree, ids FROM tab_order WHERE user_id = ?')
      .all(userId) as {
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

  setTabOrder(userId: string, worktree: string, sessionIds: string[]): void {
    requireUserId(userId)
    const cleanWorktree = worktree.trim()
    if (!cleanWorktree) throw new Error('worktree path is empty')
    if (sessionIds.length === 0) {
      this.db
        .prepare('DELETE FROM tab_order WHERE user_id = ? AND worktree = ?')
        .run(userId, cleanWorktree)
      return
    }
    this.db
      .prepare(
        `INSERT INTO tab_order (user_id, worktree, ids, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, worktree) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at`,
      )
      .run(userId, cleanWorktree, JSON.stringify(sessionIds), new Date().toISOString())
  }

  /**
   * Drop a session id from EVERY user's saved tab order during irreversible
   * purge. Deliberately cross-user: a purge destroys the session itself, so
   * leaving a dangling id in somebody else's saved order would outlive the thing
   * it names. This is §3.1.6 S5's system-writer rule — a system job may act
   * across owners, and it lands in the scope of what it acted on.
   */
  private scrubTabOrders(sessionId: SessionId): void {
    const rows = this.db.prepare('SELECT user_id, worktree, ids FROM tab_order').all() as {
      user_id: string
      worktree: string
      ids: string
    }[]
    for (const row of rows) {
      let ids: string[]
      try {
        const parsed = JSON.parse(row.ids)
        if (!Array.isArray(parsed)) continue
        ids = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        continue // corrupt row -> nothing to scrub
      }
      if (!ids.includes(sessionId)) continue
      this.setTabOrder(
        row.user_id,
        row.worktree,
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
  loadDrafts(): Record<SessionId, string> {
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
  setDraft(sessionId: SessionId, text: string): string | undefined {
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
  loadDraftDocs(): Record<SessionId, StoredDraftDoc> {
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
  setDraftDoc(sessionId: SessionId, doc: StoredDraftDoc): void {
    // `.trim()` returns a plain `string` — a normalizing method STRIPS the brand.
    // Re-applied because trimming an id yields the same id, not a different one.
    const id = asSessionId(sessionId.trim())
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
