/**
 * Sessions aggregate — owns the `sessions` table plus its UI-adjacent
 * satellites: `pins`, `snoozes`, `tab_order` and `session_drafts`. Soft
 * deletion preserves them; explicit internal purge removes them.
 */

import {
  type ActorKind,
  AgentKind,
  actorColumns,
  actorFromColumns,
  asSessionId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm'
import {
  issues as issuesTable,
  offers as offersTable,
  pins as pinsTable,
  runtimeEventCheckpoints,
  sessionDrafts,
  sessions as sessionsTable,
  sessionUserState,
  snoozes as snoozesTable,
  tabOrder,
} from '../migrations/schema'
import type { SyncQueries } from './executor/sync-drizzle'
import { requireUserId } from './helpers'
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

/** The one row shape every session read returns, before mapping. */
type SessionSelect = typeof sessionsTable.$inferSelect

export class SessionsRepository {
  /**
   * The synchronous query capability, injected [spec rule 27b]. The ASYNC pair
   * satisfies the same shape, so B1 refills this field and the query bodies
   * below do not change.
   */
  constructor(
    private readonly queries: SyncQueries,
    private readonly purgeObservationCheckpoint: (sessionId: SessionId) => void = () => {},
  ) {}

  // ---- sessions ----
  loadSessions(): SessionRow[] {
    return this.readSessions(isNull(sessionsTable.deletedAt))
  }

  /** One durable row, including a tombstone, for scoped delete visibility. */
  getSession(sessionId: SessionId): SessionRow | undefined {
    return this.readSessions(eq(sessionsTable.id, sessionId))[0]
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
    return this.readSessions(
      and(eq(sessionsTable.resumeValue, resumeValue), isNull(sessionsTable.deletedAt)),
    )[0]
  }

  /**
   * The same durable-row read as {@link getSession}, asked about MANY ids at
   * once. Tombstones remain included because feed visibility must preserve the
   * delete-audience answer. The 500-row chunks stay below SQLite's variable
   * limit while keeping one repository call for a bootstrap pass.
   */
  getSessions(sessionIds: readonly string[]): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>()
    for (const chunk of chunked(sessionIds)) {
      for (const row of this.readSessions(inArray(sessionsTable.id, chunk as SessionId[]))) {
        out.set(row.id, row)
      }
    }
    return out
  }

  /**
   * The live resume lookup asked about MANY conversation ids at once. The
   * `readSessions` ordering is deliberately retained so the first row per
   * resume value is exactly the row returned by
   * {@link findSessionByResumeValue} when duplicate values exist.
   */
  findSessionsByResumeValues(resumeValues: readonly string[]): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>()
    for (const chunk of chunked(resumeValues)) {
      for (const row of this.readSessions(this.liveByResumeValue(chunk))) {
        if (row.resumeValue !== null && !out.has(row.resumeValue)) {
          out.set(row.resumeValue, row)
        }
      }
    }
    return out
  }

  /**
   * EVERY session that names each of these resume values, not just the first.
   *
   * {@link findSessionsByResumeValues} answers "the live session a conversation
   * resumes into" and deliberately keeps whichever row `readSessions` returns
   * first, so that feed visibility keeps the answer it had before POD-1614 made
   * it a query. Cost attribution needs a different thing: when two rows share a
   * resume value — five pairs on this machine — one may carry an `issueId` and
   * the other not, and letting row order decide whether a transcript is
   * attributed at all is not a tie-break, it is a coin toss. So this returns the
   * candidates and lets the caller state its own preference, leaving the
   * visibility answer above untouched.
   */
  listSessionsByResumeValues(resumeValues: readonly string[]): Map<string, SessionRow[]> {
    const out = new Map<string, SessionRow[]>()
    for (const chunk of chunked(resumeValues)) {
      for (const row of this.readSessions(this.liveByResumeValue(chunk))) {
        if (row.resumeValue === null) continue
        const list = out.get(row.resumeValue)
        if (list) list.push(row)
        else out.set(row.resumeValue, [row])
      }
    }
    return out
  }

  /** The predicate the two plural resume readers share, so they cannot drift. */
  private liveByResumeValue(chunk: readonly string[]): SQL | undefined {
    return and(inArray(sessionsTable.resumeValue, chunk), isNull(sessionsTable.deletedAt))
  }

  /**
   * Every live-table session bound to one of these issues (POD-1858).
   *
   * The cost read's denominator: how many sessions a task HAS is what separates
   * "no sessions ever" from "sessions ran and left no transcript", and neither
   * is a zero-dollar figure. Tombstones stay excluded — a deleted session's work
   * is not part of what the task cost today.
   */
  findSessionsByIssueIds(issueIds: readonly IssueId[]): SessionRow[] {
    const out: SessionRow[] = []
    for (const chunk of chunked(issueIds)) {
      out.push(
        ...this.readSessions(
          and(inArray(sessionsTable.issueId, chunk), isNull(sessionsTable.deletedAt)),
        ),
      )
    }
    return out
  }

  /** All session tombstones, for repository-level inspection and maintenance. */
  loadDeletedSessions(): SessionRow[] {
    return this.readSessions(isNotNull(sessionsTable.deletedAt))
  }

  /** Recoverable session tombstones created by one issue deletion. */
  loadDeletedSessionsForIssue(issueId: IssueId): SessionRow[] {
    return this.readSessions(
      and(
        isNotNull(sessionsTable.deletedAt),
        eq(sessionsTable.deletionSource, 'issue'),
        eq(sessionsTable.deletedByIssueId, issueId),
      ),
    )
  }

  /**
   * THE ONE SESSION READ. Every reader above supplies a predicate and inherits
   * this ordering; three of them depend on it meaning the same thing, so it is
   * declared once (see {@link findSessionByResumeValue}).
   */
  private readSessions(where: SQL | undefined): SessionRow[] {
    return this.queries.db
      .select()
      .from(sessionsTable)
      .where(where)
      .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
      .all()
      .map(mapSession)
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
    const createdBy = row.createdBy ? actorColumns(row.createdBy.actor) : null
    const values = {
      id: row.id,
      ownerUserId: row.ownerUserId,
      agentKind: row.agentKind,
      model: row.model ?? null,
      effort: row.effort ?? null,
      requestedModel: row.requestedModel ?? null,
      requestedEffort: row.requestedEffort ?? null,
      accountId: row.accountId ?? null,
      loginHarness: row.loginHarness ?? null,
      cwd: row.cwd,
      title: row.title,
      name: row.name,
      nameSource: row.nameSource ?? null,
      originKind: row.originKind,
      conversationId: row.conversationId,
      resumeKind: row.resumeKind,
      resumeValue: row.resumeValue,
      selectedDriverId: row.selectedDriverId ?? null,
      requestedDriverId: row.requestedDriverId ?? null,
      conversationBinding: row.conversationBinding ?? null,
      status: row.status,
      exitCode: row.exitCode,
      spawnFailure: row.spawnFailure ?? null,
      durableLabel: row.durableLabel,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      terminalCols: row.geometry?.cols ?? 80,
      terminalRows: row.geometry?.rows ?? 24,
      workingMsTotal: row.workingMsTotal ?? null,
      inputCount: row.inputCount ?? 0,
      outputCount: row.outputCount ?? 0,
      activityCount: row.activityCount ?? 0,
      archived: row.archived,
      workState: row.workState,
      machineId: row.machineId,
      lastOutputAt: row.lastOutputAt ?? null,
      lastInputAt: row.lastInputAt ?? null,
      lastResumedAt: row.lastResumedAt ?? null,
      spawnedBy: row.spawnedBy ?? null,
      headless: row.headless ?? false,
      issueId: row.issueId ?? null,
      stoppedAt: row.stoppedAt ?? null,
      /**
       * `stop_reason` KEEPS ITS FOUR-VALUE VOCABULARY, and `oom` is not one
       * of them: `sessions_stop_reason_check` admits only self/parent/
       * forced/exited, and widening it means a SQLite table rebuild the
       * expand-only gate refuses. So the DEATH persists as `exited` and the
       * CAUSE persists beside it as a timestamp; `Session.hydrate` re-derives
       * `oom` from the pair. Without this the whole write threw on the CHECK
       * and took the durable `oomKilled` event append down with it.
       */
      stopReason: row.stopReason === 'oom' ? 'exited' : (row.stopReason ?? null),
      oomKilledAt: row.oomKilledAt ?? null,
      deletedAt: row.deletedAt ?? null,
      deletionSource: row.deletionSource ?? null,
      deletedByIssueId: row.deletedByIssueId ?? null,
      workflowRunId: row.workflowRunId ?? null,
      workflowStepId: row.workflowStepId ?? null,
      executionProfileId: row.executionProfileId ?? null,
      refIssueId: row.refIssueId ?? null,
      refLetter: row.refLetter ?? null,
      refDraft: row.refDraft ?? null,
      createdByActorKind: createdBy ? createdBy.kind : null,
      createdByActorId: createdBy ? createdBy.id : null,
      createdByOnBehalfOf: row.createdBy?.onBehalfOf ?? null,
    }
    this.queries.db
      .insert(sessionsTable)
      .values(values)
      .onConflictDoUpdate({
        target: sessionsTable.id,
        set: {
          cwd: values.cwd,
          model: values.model,
          effort: values.effort,
          requestedModel: values.requestedModel,
          requestedEffort: values.requestedEffort,
          accountId: values.accountId,
          loginHarness: sql`COALESCE(${sessionsTable.loginHarness}, excluded."login_harness")`,
          title: values.title,
          name: values.name,
          nameSource: values.nameSource,
          originKind: values.originKind,
          conversationId: values.conversationId,
          resumeKind: values.resumeKind,
          resumeValue: values.resumeValue,
          selectedDriverId: values.selectedDriverId,
          requestedDriverId: values.requestedDriverId,
          // BINDING IS ONE-WAY (POD-2392): once a launch is known to have had a
          // native conversation, no later write may say it never did. The rule
          // lives here rather than in the caller because it is the premise the
          // fresh-relaunch path depends on — a caller that reconstructs a stale
          // Session and persists it must not be able to un-prove a conversation.
          conversationBinding: sql`CASE
             WHEN ${sessionsTable.conversationBinding} = 'bound' THEN 'bound'
             ELSE excluded."conversation_binding"
           END`,
          status: values.status,
          exitCode: values.exitCode,
          spawnFailure: values.spawnFailure,
          durableLabel: values.durableLabel,
          lastActiveAt: values.lastActiveAt,
          terminalCols: values.terminalCols,
          terminalRows: values.terminalRows,
          workingMsTotal: values.workingMsTotal,
          inputCount: values.inputCount,
          outputCount: values.outputCount,
          activityCount: values.activityCount,
          archived: values.archived,
          workState: values.workState,
          machineId: values.machineId,
          lastOutputAt: values.lastOutputAt,
          lastInputAt: values.lastInputAt,
          lastResumedAt: values.lastResumedAt,
          spawnedBy: values.spawnedBy,
          issueId: values.issueId,
          stoppedAt: values.stoppedAt,
          stopReason: values.stopReason,
          oomKilledAt: values.oomKilledAt,
          deletedAt: values.deletedAt,
          deletionSource: values.deletionSource,
          deletedByIssueId: values.deletedByIssueId,
          workflowRunId: values.workflowRunId,
          workflowStepId: values.workflowStepId,
          executionProfileId: values.executionProfileId,
          // Birth name is PERMANENT (#474): once allocated it never changes, even
          // when the session re-attaches to a different issue. COALESCE keeps the
          // first non-null allocation.
          refIssueId: sql`COALESCE(${sessionsTable.refIssueId}, excluded."ref_issue_id")`,
          refLetter: sql`COALESCE(${sessionsTable.refLetter}, excluded."ref_letter")`,
          refDraft: sql`COALESCE(${sessionsTable.refDraft}, excluded."ref_draft")`,
          // ATTRIBUTION IS IMMUTABLE AFTER CREATE (POD-365's
          // SESSION_IMMUTABLE_AFTER_CREATE lists `createdBy`). COALESCE keeps the
          // pair stamped at birth: an upsert from a later code path — a status
          // change, a rename, a reattach — must not be able to re-attribute the
          // session to whoever happened to trigger it. It can only FILL a pair
          // that was never recorded, never overwrite one that was.
          createdByActorKind: sql`COALESCE(${sessionsTable.createdByActorKind}, excluded."created_by_actor_kind")`,
          createdByActorId: sql`COALESCE(${sessionsTable.createdByActorId}, excluded."created_by_actor_id")`,
          createdByOnBehalfOf: sql`COALESCE(${sessionsTable.createdByOnBehalfOf}, excluded."created_by_on_behalf_of")`,
        },
      })
      .run()
  }

  /** Tombstone sessions without destroying their metadata or UI satellites. */
  softDeleteSessions(
    ids: string[],
    deletedAt: string,
    source: SessionDeletionSource,
    deletedByIssueId: IssueId | null = null,
  ): void {
    for (const id of ids) {
      this.queries.db
        .update(sessionsTable)
        .set({ deletedAt, deletionSource: source, deletedByIssueId })
        .where(and(eq(sessionsTable.id, id as SessionId), isNull(sessionsTable.deletedAt)))
        .run()
    }
  }

  /** Mark sessions as deleted by an issue so restoring that issue can recover them. */
  softDeleteForIssue(ids: string[], issueId: IssueId, deletedAt: string): void {
    this.softDeleteSessions(ids, deletedAt, 'issue', issueId)
  }

  /** Re-expose an issue's tombstoned sessions as honestly exited runtime records. */
  restoreDeletedForIssue(issueId: IssueId): void {
    this.queries.db
      .update(sessionsTable)
      .set({
        deletedAt: null,
        deletionSource: null,
        deletedByIssueId: null,
        status: 'exited',
        exitCode: null,
      })
      .where(
        and(
          isNotNull(sessionsTable.deletedAt),
          eq(sessionsTable.deletionSource, 'issue'),
          eq(sessionsTable.deletedByIssueId, issueId),
        ),
      )
      .run()
  }

  /**
   * Clear a TOMBSTONED session's pointers at an issue that is being hard-purged
   * (POD-1926).
   *
   * `purgeEmptyDraft` really does `DELETE FROM issues`, and `sessions.issue_id`
   * carries no foreign key — only `parent_id`, `superseded_by` and `duplicate_of`
   * have `ON DELETE SET NULL` — so nothing at the SQL layer stops a session row
   * outliving the issue it names. The reaper detaches the sessions it can SEE
   * before deleting, but it sees them through `loadSessions()`, which is
   * `deleted_at IS NULL`: a soft-deleted session is invisible to it and kept its
   * `issue_id` forever. One such row (deleted nine seconds after it was spawned,
   * `status` still `live`) is how POD-1926 was found.
   *
   * Deliberately scoped to `deleted_at IS NOT NULL`. Live rows are already
   * detached by the reaper through `setSessionIssueId`, which persists AND
   * refreshes the in-memory `Session`; a raw UPDATE behind that map's back would
   * desync it. Tombstones are not in the map at all, so SQL is the whole truth
   * for them.
   *
   * `ref_issue_id`/`ref_letter` go with it: the pair is sticky on upsert
   * (`COALESCE(sessions.ref_issue_id, excluded.ref_issue_id)`) so a dead ref would
   * never be reallocated, and `prepareRefAllocation` returns early whenever
   * `refIssueId` is set — leaving the session permanently unable to earn the draft
   * ref it should now get.
   */
  detachTombstonesFromIssue(issueId: IssueId): void {
    this.queries.db
      .update(sessionsTable)
      .set({
        issueId: sql`CASE WHEN ${sessionsTable.issueId} = ${issueId} THEN NULL ELSE ${sessionsTable.issueId} END`,
        refIssueId: sql`CASE WHEN ${sessionsTable.refIssueId} = ${issueId} THEN NULL ELSE ${sessionsTable.refIssueId} END`,
        refLetter: sql`CASE WHEN ${sessionsTable.refIssueId} = ${issueId} THEN NULL ELSE ${sessionsTable.refLetter} END`,
      })
      .where(
        and(
          isNotNull(sessionsTable.deletedAt),
          or(eq(sessionsTable.issueId, issueId), eq(sessionsTable.refIssueId, issueId)),
        ),
      )
      .run()
  }

  /**
   * Per-boot heal for references left behind by a purge that predates
   * {@link detachTombstonesFromIssue} (POD-1926). Idempotent, and unscoped by
   * `deleted_at` on purpose: it runs from the store facade's constructor, ahead
   * of every reader in the process, so no in-memory `Session` exists yet to
   * desync. Returns the number of rows healed.
   */
  detachDanglingIssueReferences(): number {
    // The subquery's own column is unqualified and resolves inside `issues`,
    // which is what it must do; the OUTER columns are the `sessions` ones the
    // builder qualifies for us here because they are named as columns rather
    // than interpolated into the fragment.
    const danglingIssue = sql`${sessionsTable.issueId} IS NOT NULL AND ${sessionsTable.issueId} NOT IN (SELECT ${issuesTable.id} FROM ${issuesTable})`
    const danglingRef = sql`${sessionsTable.refIssueId} IS NOT NULL AND ${sessionsTable.refIssueId} NOT IN (SELECT ${issuesTable.id} FROM ${issuesTable})`
    const result = this.queries.db
      .update(sessionsTable)
      .set({
        issueId: sql`CASE WHEN ${danglingIssue} THEN NULL ELSE ${sessionsTable.issueId} END`,
        refLetter: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${sessionsTable.refLetter} END`,
        refIssueId: sql`CASE WHEN ${danglingRef} THEN NULL ELSE ${sessionsTable.refIssueId} END`,
      })
      .where(or(danglingIssue, danglingRef))
      .run()
    return Number(result.changes)
  }

  /** Irreversibly remove a session and its satellites. Internal maintenance only. */
  purgeSession(id: SessionId): void {
    this.queries.db
      .delete(runtimeEventCheckpoints)
      .where(eq(runtimeEventCheckpoints.sessionId, id))
      .run()
    this.purgeObservationCheckpoint(id)
    this.queries.db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run()
    this.queries.db
      .delete(pinsTable)
      .where(and(eq(pinsTable.kind, 'panel'), eq(pinsTable.id, id)))
      .run()
    this.queries.db.delete(sessionDrafts).where(eq(sessionDrafts.sessionId, id)).run()
    this.queries.db.delete(snoozesTable).where(eq(snoozesTable.sessionId, id)).run()
    this.queries.db.delete(sessionUserState).where(eq(sessionUserState.sessionId, id)).run()
    this.queries.db.delete(offersTable).where(eq(offersTable.sessionId, id)).run() // [spec:SP-c7f1]
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
  listPins(userId: UserId): PinState {
    const rows = this.queries.db
      .select({ kind: pinsTable.kind, id: pinsTable.id })
      .from(pinsTable)
      .where(eq(pinsTable.userId, userId))
      .orderBy(asc(sql`rowid`))
      .all()
    const pins: PinState = { panels: [], worktrees: [], repos: [] }
    for (const row of rows) {
      if (row.kind === 'panel') pins.panels.push(row.id)
      else if (row.kind === 'worktree') pins.worktrees.push(row.id)
      else if (row.kind === 'repo') pins.repos.push(row.id)
    }
    return pins
  }

  setPin(userId: UserId, kind: PinKind, id: string, pinned: boolean): void {
    if (!PIN_KINDS.has(kind)) throw new Error(`invalid pin kind: ${kind}`)
    requireUserId(userId)
    const cleanId = id.trim()
    if (!cleanId) throw new Error('pin id is empty')
    if (pinned) {
      // NOT CONVERTED, by ruling (POD-3403, spec §6): `INSERT OR IGNORE` is not
      // `onConflictDoNothing()`. `OR IGNORE` suppresses EVERY constraint
      // violation on the statement — foreign key, NOT NULL and CHECK included —
      // while drizzle's `DO NOTHING` suppresses only the uniqueness conflict and
      // lets the rest throw. So the literal conversion changes behaviour in both
      // directions, and the rule is to leave the statement as it stands.
      //
      // FOR THIS TABLE the two are in fact equivalent, and the evidence is in
      // the handoff rather than acted on here: `pins` as actually built carries
      // exactly one constraint, the composite primary key
      // (user_id, kind, id) — no foreign key and no UNIQUE index, in the
      // baseline and in the per-user-state rebuild alike. The ruling is a
      // category rule and I am not making a per-site exception to it.
      //
      // Written through the drizzle instance rather than a raw handle: this file
      // is converted and holds no connection, so the statement keeps its exact
      // text while the file keeps its ledger line off.
      this.queries.db.run(
        // DECISION POD-3403
        sql`INSERT OR IGNORE INTO ${pinsTable} (user_id, kind, id, pinned_at) VALUES (${userId}, ${kind}, ${cleanId}, ${new Date().toISOString()})`,
      )
    } else {
      this.queries.db
        .delete(pinsTable)
        .where(
          and(eq(pinsTable.userId, userId), eq(pinsTable.kind, kind), eq(pinsTable.id, cleanId)),
        )
        .run()
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
  listReadAt(userId: UserId): Record<string, string | null> {
    requireUserId(userId)
    const rows = this.queries.db
      .select({ sessionId: sessionUserState.sessionId, readAt: sessionUserState.readAt })
      .from(sessionUserState)
      .where(eq(sessionUserState.userId, userId))
      .all()
    const out: Record<string, string | null> = {}
    for (const r of rows) out[r.sessionId] = r.readAt
    return out
  }

  getReadAt(userId: UserId, sessionId: SessionId): string | null {
    requireUserId(userId)
    const row = this.queries.db
      .select({ readAt: sessionUserState.readAt })
      .from(sessionUserState)
      .where(
        and(
          eq(sessionUserState.userId, userId),
          eq(sessionUserState.sessionId, asSessionId(sessionId.trim())),
        ),
      )
      .get()
    return row?.readAt ?? null
  }

  markSessionRead(userId: UserId, sessionId: SessionId, readAt: string): void {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('read-state session id is empty')
    this.queries.db
      .insert(sessionUserState)
      .values({ userId, sessionId: asSessionId(id), readAt })
      .onConflictDoUpdate({
        target: [sessionUserState.userId, sessionUserState.sessionId],
        set: { readAt },
      })
      .run()
  }

  /** DELETES the row rather than writing a null. Absence and `read_at IS NULL`
   *  would be two spellings of "never opened", and a table with two spellings of
   *  one fact acquires a second meaning nobody documented. */
  markSessionUnread(userId: UserId, sessionId: SessionId): void {
    requireUserId(userId)
    this.queries.db
      .delete(sessionUserState)
      .where(
        and(
          eq(sessionUserState.userId, userId),
          eq(sessionUserState.sessionId, asSessionId(sessionId.trim())),
        ),
      )
      .run()
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
    this.queries.db
      .delete(sessionUserState)
      .where(eq(sessionUserState.sessionId, asSessionId(sessionId.trim())))
      .run()
  }

  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time. */
  listSnoozes(userId: UserId, now: number = Date.now()): SnoozeMap {
    const rows = this.queries.db
      .select({ sessionId: snoozesTable.sessionId, snoozedUntil: snoozesTable.snoozedUntil })
      .from(snoozesTable)
      .where(eq(snoozesTable.userId, userId))
      .all()
    const out: SnoozeMap = {}
    const expired: SessionId[] = []
    for (const r of rows) {
      if (r.snoozedUntil !== null && Date.parse(r.snoozedUntil) <= now) {
        expired.push(r.sessionId)
        continue
      }
      out[r.sessionId] = r.snoozedUntil
    }
    // The lazy delete stays scoped to the reader: housekeeping on read must never
    // drop somebody else's row, even an expired one.
    for (const id of expired) {
      this.queries.db
        .delete(snoozesTable)
        .where(and(eq(snoozesTable.userId, userId), eq(snoozesTable.sessionId, id)))
        .run()
    }
    return out
  }

  /** Snooze a session for one user. `until` = null → until next message; ISO
   *  string → timed. PER-USER STATE (POD-380) — see the note on {@link listPins}. */
  setSnooze(userId: UserId, sessionId: SessionId, until: string | null): void {
    requireUserId(userId)
    const id = sessionId.trim()
    if (!id) throw new Error('snooze session id is empty')
    this.queries.db
      .insert(snoozesTable)
      .values({
        userId,
        sessionId: asSessionId(id),
        snoozedUntil: until,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [snoozesTable.userId, snoozesTable.sessionId],
        set: { snoozedUntil: until },
      })
      .run()
  }

  /** Un-snooze a session for one user (no-op if not snoozed). */
  clearSnooze(userId: UserId, sessionId: SessionId): void {
    this.queries.db
      .delete(snoozesTable)
      .where(
        and(
          eq(snoozesTable.userId, userId),
          eq(snoozesTable.sessionId, asSessionId(sessionId.trim())),
        ),
      )
      .run()
  }

  hasAnySnooze(sessionId: SessionId): boolean {
    return (
      this.queries.db
        .select({ present: sql<number>`1` })
        .from(snoozesTable)
        .where(eq(snoozesTable.sessionId, asSessionId(sessionId.trim())))
        .limit(1)
        .get() !== undefined
    )
  }

  /** Clear every viewer's independent snooze after a shared session event. */
  clearAllSnoozes(sessionId: SessionId): void {
    this.queries.db
      .delete(snoozesTable)
      .where(eq(snoozesTable.sessionId, asSessionId(sessionId.trim())))
      .run()
  }

  // ---- agent action offers [spec:SP-c7f1] ----
  /** Every live offer, keyed by session — replayed onto SessionMeta at boot. A
   *  row with corrupt JSON actions is dropped rather than failing the load. */
  listOffers(): OfferMap {
    const rows = this.queries.db.select().from(offersTable).all()
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
        out[r.sessionId] = {
          message: r.message,
          actions,
          ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
          createdAt: r.createdAt,
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
    const values = {
      sessionId: asSessionId(id),
      message: offer.message,
      actions: JSON.stringify(offer.actions),
      artifacts:
        offer.artifacts && offer.artifacts.length > 0 ? JSON.stringify(offer.artifacts) : null,
      createdAt: offer.createdAt,
    }
    this.queries.db
      .insert(offersTable)
      .values(values)
      .onConflictDoUpdate({
        target: offersTable.sessionId,
        set: {
          message: values.message,
          actions: values.actions,
          artifacts: values.artifacts,
          createdAt: values.createdAt,
        },
      })
      .run()
  }

  /** The stamp of one session's live offer, or undefined when it has none. The
   *  guard a dismissal checks itself against — one row, not the whole table,
   *  because `listOffers` exists to rebuild every session at boot. */
  offerCreatedAt(sessionId: SessionId): string | undefined {
    const row = this.queries.db
      .select({ createdAt: offersTable.createdAt })
      .from(offersTable)
      .where(eq(offersTable.sessionId, asSessionId(sessionId.trim())))
      .get()
    return row?.createdAt
  }

  /** Remove a session's offer (no-op if none). */
  clearOffer(sessionId: SessionId): void {
    this.queries.db
      .delete(offersTable)
      .where(eq(offersTable.sessionId, asSessionId(sessionId.trim())))
      .run()
  }

  // ---- tab order ----
  /** Manual tab order per worktree path. Worktrees never reordered are absent. */
  listTabOrders(userId: UserId): Record<string, string[]> {
    const rows = this.queries.db
      .select({ worktree: tabOrder.worktree, ids: tabOrder.ids })
      .from(tabOrder)
      .where(eq(tabOrder.userId, userId))
      .all()
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

  setTabOrder(userId: UserId, worktree: string, sessionIds: string[]): void {
    requireUserId(userId)
    const cleanWorktree = worktree.trim()
    if (!cleanWorktree) throw new Error('worktree path is empty')
    if (sessionIds.length === 0) {
      this.queries.db
        .delete(tabOrder)
        .where(and(eq(tabOrder.userId, userId), eq(tabOrder.worktree, cleanWorktree)))
        .run()
      return
    }
    const ids = JSON.stringify(sessionIds)
    const updatedAt = new Date().toISOString()
    this.queries.db
      .insert(tabOrder)
      .values({ userId, worktree: cleanWorktree, ids, updatedAt })
      .onConflictDoUpdate({
        target: [tabOrder.userId, tabOrder.worktree],
        set: { ids, updatedAt },
      })
      .run()
  }

  /**
   * Drop a session id from EVERY user's saved tab order during irreversible
   * purge. Deliberately cross-user: a purge destroys the session itself, so
   * leaving a dangling id in somebody else's saved order would outlive the thing
   * it names. This is §3.1.6 S5's system-writer rule — a system job may act
   * across owners, and it lands in the scope of what it acted on.
   */
  private scrubTabOrders(sessionId: SessionId): void {
    const rows = this.queries.db.select().from(tabOrder).all()
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
        row.userId,
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
    const rows = this.queries.db
      .select({ sessionId: sessionDrafts.sessionId, text: sessionDrafts.text })
      .from(sessionDrafts)
      .all()
    const out: Record<string, string> = {}
    for (const r of rows) out[r.sessionId] = r.text
    return out
  }

  /** Draft last-edit times by session — the companion to {@link loadDrafts}, used
   *  to seed `Session.draftUpdatedAt` at boot so a draft lifts its session in the
   *  attention ordering after a restart. */
  loadDraftTimes(): Record<string, string> {
    const rows = this.queries.db
      .select({ sessionId: sessionDrafts.sessionId, updatedAt: sessionDrafts.updatedAt })
      .from(sessionDrafts)
      .all()
    const out: Record<string, string> = {}
    for (const r of rows) out[r.sessionId] = r.updatedAt
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
      this.queries.db
        .insert(sessionDrafts)
        .values({ sessionId: asSessionId(id), text, updatedAt })
        .onConflictDoUpdate({ target: sessionDrafts.sessionId, set: { text, updatedAt } })
        .run()
      return updatedAt
    }
    this.queries.db
      .delete(sessionDrafts)
      .where(eq(sessionDrafts.sessionId, asSessionId(id)))
      .run()
    return undefined
  }

  // ---- versioned drafts (POD-859, Draft Sync v2) ----
  // The same `session_drafts` row, read/written with its versioning columns
  // (`rev`, `origin`, `history`). Used only by the flag-on versioned path; the
  // legacy `loadDrafts`/`setDraft` above stay byte-for-byte for the flag-off path.
  // `updatedAt` doubles as the doc's `editedAt`.
  //
  // THESE COLUMNS ARE ASSUMED PRESENT, and until POD-3246 they were not: a
  // `PRAGMA table_info` probe degraded to the legacy shape if `rev` was missing,
  // guarding `loadDraftDocs()` (which runs at boot regardless of the flag)
  // against a `no such column` crash-loop on a DB whose migration had not
  // applied. There is no such DB. `SessionStore` runs the whole migration chain
  // on this connection before it constructs a repository, drizzle applies by
  // NAME so `20260718093018_session-drafts-versioned` cannot be skipped, and a
  // database that claims it applied while lacking the columns is corruption —
  // which is worth a loud failure, not a silent fallback to a shape that drops
  // every rev and history on write.

  /** All persisted draft docs, keyed by session. A row written before the
   *  versioning columns existed reads back with `rev: 0`, `origin: null`, and an
   *  empty history. */
  loadDraftDocs(): Record<SessionId, StoredDraftDoc> {
    const rows = this.queries.db.select().from(sessionDrafts).all()
    const out: Record<string, StoredDraftDoc> = {}
    for (const r of rows) {
      out[r.sessionId] = {
        text: r.text,
        updatedAt: r.updatedAt,
        rev: r.rev ?? 0,
        origin: r.origin ?? null,
        history: parseHistory(r.history ?? null),
      }
    }
    return out
  }

  /** Upsert (non-empty) or delete (empty text) a versioned draft doc. Empty text
   *  removes the row just like {@link setDraft}, so a cleared draft never lingers. */
  setDraftDoc(sessionId: SessionId, doc: StoredDraftDoc): void {
    // `.trim()` returns a plain `string` — a normalizing method STRIPS the brand.
    // Re-applied because trimming an id yields the same id, not a different one.
    const id = asSessionId(sessionId.trim())
    if (!id) return
    if (!doc.text) {
      this.queries.db.delete(sessionDrafts).where(eq(sessionDrafts.sessionId, id)).run()
      return
    }
    const values = {
      sessionId: id,
      text: doc.text,
      updatedAt: doc.updatedAt,
      rev: doc.rev,
      origin: doc.origin,
      history: JSON.stringify(doc.history),
    }
    this.queries.db
      .insert(sessionDrafts)
      .values(values)
      .onConflictDoUpdate({
        target: sessionDrafts.sessionId,
        set: {
          text: values.text,
          updatedAt: values.updatedAt,
          rev: values.rev,
          origin: values.origin,
          history: values.history,
        },
      })
      .run()
  }
}

/** The 500-row chunks every batched id reader here shares. They stay below
 *  SQLite's variable limit while keeping one repository call per pass. */
function* chunked<T>(values: readonly T[]): Generator<T[]> {
  const unique = [...new Set(values)]
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) {
    yield unique.slice(i, i + CHUNK)
  }
}

/**
 * SERIALIZATION EDGE — the one place a `sessions` row becomes a `SessionRow`.
 *
 * WHAT IS LEFT HERE IS DECISIONS. The brand casts and the `?? null` decodes are
 * gone: the schema carries `$type<>()` on the id columns and drizzle's own
 * execution path maps physical names back, so those lines existed only because
 * the driver returned `unknown` (spec §6 rule 6). Every line that remains is a
 * refusal, a whitelist, or a spelling choice, and each says which.
 */
function mapSession(r: SessionSelect): SessionRow {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    agentKind: r.agentKind,
    ...(r.model != null ? { model: r.model } : {}),
    ...(r.effort != null ? { effort: r.effort } : {}),
    // ABSENT, NOT NULL, when nobody has changed it — the same spelling as the
    // launch pair above. `requestedModel: null` and an absent key read the
    // same at every consumer here, but the absent form keeps "never
    // configured" from looking like a recorded decision to clear it.
    ...(r.requestedModel != null ? { requestedModel: r.requestedModel } : {}),
    ...(r.requestedEffort != null ? { requestedEffort: r.requestedEffort } : {}),
    ...(r.accountId != null ? { accountId: r.accountId } : {}),
    ...(r.loginHarness != null
      ? { loginHarness: AgentKind.exclude(['shell']).parse(r.loginHarness) }
      : {}),
    cwd: r.cwd,
    title: r.title,
    name: r.name ?? null,
    // Anything else on disk (an old/rogue value) reads as "nobody named it" rather
    // than as a source that could out-rank the user (#490).
    nameSource: r.nameSource === 'user' || r.nameSource === 'agent' ? r.nameSource : null,
    originKind: r.originKind as 'spawn' | 'resume',
    conversationId: r.conversationId ?? null,
    resumeKind: r.resumeKind ?? null,
    resumeValue: r.resumeValue ?? null,
    selectedDriverId: r.selectedDriverId ?? null,
    requestedDriverId: r.requestedDriverId ?? null,
    // Anything else on disk (an old/rogue value) reads as "no claim recorded"
    // rather than as proof — the same conservative decode as `name_source`,
    // and here it is the safety property itself: only a literal 'never'
    // authorizes discarding a launch and starting it again.
    conversationBinding:
      r.conversationBinding === 'never' || r.conversationBinding === 'bound'
        ? r.conversationBinding
        : null,
    status: r.status as SessionStatusPersisted,
    exitCode: r.exitCode ?? null,
    spawnFailure: r.spawnFailure ?? null,
    durableLabel: r.durableLabel,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    geometry: {
      cols: Number.isInteger(r.terminalCols) && r.terminalCols > 0 ? r.terminalCols : 80,
      rows: Number.isInteger(r.terminalRows) && r.terminalRows > 0 ? r.terminalRows : 24,
    },
    ...(r.workingMsTotal != null ? { workingMsTotal: r.workingMsTotal } : {}),
    ...(r.inputCount > 0 ? { inputCount: r.inputCount } : {}),
    ...(r.outputCount > 0 ? { outputCount: r.outputCount } : {}),
    ...(r.activityCount > 0 ? { activityCount: r.activityCount } : {}),
    archived: r.archived,
    workState: r.workState ?? null,
    machineId: r.machineId,
    lastOutputAt: r.lastOutputAt ?? null,
    lastInputAt: r.lastInputAt ?? null,
    lastResumedAt: r.lastResumedAt ?? null,
    spawnedBy: r.spawnedBy ?? null,
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
    ...(r.createdByActorKind != null && r.createdByActorId != null
      ? {
          createdBy: {
            actor: actorFromColumns(r.createdByActorKind as ActorKind, r.createdByActorId),
            // The INNER null stays: it is the representable "no human behind
            // this" for the machine and system arms, which is a different fact
            // from the pair being absent altogether.
            onBehalfOf: (r.createdByOnBehalfOf as UserId | null) ?? null,
          },
        }
      : {}),
    headless: r.headless,
    issueId: r.issueId ?? null,
    refIssueId: r.refIssueId ?? null,
    refLetter: r.refLetter ?? null,
    refDraft: r.refDraft ?? null,
    stoppedAt: r.stoppedAt ?? null,
    stopReason:
      r.stopReason === 'self' ||
      r.stopReason === 'parent' ||
      r.stopReason === 'forced' ||
      r.stopReason === 'exited'
        ? r.stopReason
        : null,
    oomKilledAt: r.oomKilledAt ?? null,
    workflowRunId: r.workflowRunId ?? null,
    workflowStepId: r.workflowStepId ?? null,
    executionProfileId: r.executionProfileId ?? null,
    deletedAt: r.deletedAt ?? null,
    deletionSource: (r.deletionSource as SessionDeletionSource | null) ?? null,
    deletedByIssueId: r.deletedByIssueId ?? null,
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
