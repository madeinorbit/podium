// workspace-scoped (POD-6959)
/**
 * SIDEBAR / TAB LAYOUT AT REST, KEYED BY USER (POD-1350).
 *
 * Layout keys that follow a person across devices — dock tab, superagent open
 * state, panel modes, sidebar section collapses, file-tab presentation — live
 * here as `(user_id, key)` rows. Device-local route, selection, focus, pane/
 * split geometry and screen pixel widths do NOT: those stay in the client
 * ui-state module (POD-403).
 *
 * ---------------------------------------------------------------------------
 * CLIENT READS TAKE A USER; BOOT RECONCILIATION READS FULL TRUTH.
 * ---------------------------------------------------------------------------
 * Ordinary reads have the same posture as {@link UserPreferencesRepository}:
 * no bulk cross-user read. The boot-only reconciliation scan is the exception.
 * A caller's snapshot is their own rows; a second user on the same device sees
 * nothing of the first.
 *
 * ---------------------------------------------------------------------------
 * WHICH KEYS ARE ADMISSIBLE IS THE MODEL'S ANSWER
 * ---------------------------------------------------------------------------
 * {@link UserLayoutRepository.set} refuses a key {@link isLayoutKey} does not
 * admit. That is the closed vocabulary shared with POD-403's routing table and
 * with `layout.set`'s input schema — three answers that must stay one.
 */

import {
  isLayoutKey,
  type LayoutSnapshot,
  type LayoutWire,
  normalizeDockWorktreeKey,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import { and, asc, eq, sql } from 'drizzle-orm'
import { captureWrite } from '../sync/capture-pg'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
} from './executor/sync-drizzle'

// Every query these repositories run, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const layoutUserIs = (t: StoreTables) =>
  inWorkspace(t.userLayout, eq(t.userLayout.userId, param(t.userLayout.userId, 'userId')))
const layoutKeyIs = (t: StoreTables) =>
  and(layoutUserIs(t), eq(t.userLayout.key, param(t.userLayout.key, 'key')))

const layoutOfUser = prepared((db, t) =>
  db
    .select({ key: t.userLayout.key, value: t.userLayout.value })
    .from(t.userLayout)
    .where(layoutUserIs(t))
    .prepare(),
)

const layoutValue = prepared((db, t) =>
  db.select({ value: t.userLayout.value }).from(t.userLayout).where(layoutKeyIs(t)).prepare(),
)

const upsertLayout = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.userLayout)
      .values({
        workspaceId: WORKSPACE,
        userId: P('userId'),
        key: P('key'),
        value: P('value'),
        updatedAt: P('updatedAt'),
      })
      .onConflictDoUpdate({
        target: [t.userLayout.userId, t.userLayout.key],
        set: { value: P('value'), updatedAt: P('updatedAt') },
      }),
  ).prepare(),
)

const deleteLayoutKey = prepared((db, t) =>
  captureWrite(db.delete(t.userLayout).where(layoutKeyIs(t))).prepare(),
)

/** Every user's layout rows in primary-key order, one page after a cursor:
 *  the boot reconcile's full truth, read a page at a time through the key. */
const layoutRowsPage = preparedFamily((db, t, from: 'start' | 'after') =>
  db
    .select({ userId: t.userLayout.userId, key: t.userLayout.key, value: t.userLayout.value })
    .from(t.userLayout)
    // The first page starts at the lowest key, `>=`, so it is a seek like the rest.
    .where(
      inWorkspace(
        t.userLayout,
        from === 'start'
          ? sql`(${t.userLayout.userId}, ${t.userLayout.key}) >= (${P('afterUserId')}, ${P('afterKey')})`
          : sql`(${t.userLayout.userId}, ${t.userLayout.key}) > (${P('afterUserId')}, ${P('afterKey')})`,
      ),
    )
    .orderBy(asc(t.userLayout.userId), asc(t.userLayout.key))
    .limit(P('limit'))
    .prepare(),
)

const layoutKeysOfUser = prepared((db, t) =>
  db
    .select({ key: t.userLayout.key })
    .from(t.userLayout)
    .where(layoutUserIs(t))
    .orderBy(asc(t.userLayout.key))
    .prepare(),
)

const shellUserIs = (t: StoreTables) =>
  inWorkspace(t.userDockShell, eq(t.userDockShell.userId, param(t.userDockShell.userId, 'userId')))
const shellSlotIs = (t: StoreTables) =>
  and(
    shellUserIs(t),
    eq(t.userDockShell.worktreeKey, param(t.userDockShell.worktreeKey, 'worktreeKey')),
  )
const shellWorktreeIs = (t: StoreTables) =>
  inWorkspace(
    t.userDockShell,
    eq(t.userDockShell.worktreeKey, param(t.userDockShell.worktreeKey, 'worktreeKey')),
  )
const shellSessionIs = (t: StoreTables) =>
  inWorkspace(
    t.userDockShell,
    eq(t.userDockShell.sessionId, param(t.userDockShell.sessionId, 'sessionId')),
  )

const dockShellOfSlot = prepared((db, t) =>
  db
    .select({ sessionId: t.userDockShell.sessionId })
    .from(t.userDockShell)
    .where(shellSlotIs(t))
    .prepare(),
)

const dockShellsOfUser = prepared((db, t) =>
  db
    .select({ worktreeKey: t.userDockShell.worktreeKey, sessionId: t.userDockShell.sessionId })
    .from(t.userDockShell)
    .where(shellUserIs(t))
    .orderBy(asc(t.userDockShell.worktreeKey))
    .prepare(),
)

const dockShellValues = {
  workspaceId: WORKSPACE,
  userId: P('userId'),
  worktreeKey: P('worktreeKey'),
  sessionId: P('sessionId'),
  updatedAt: P('updatedAt'),
}

const claimDockShell = prepared((db, t) =>
  db
    .insert(t.userDockShell)
    .values(dockShellValues)
    .onConflictDoNothing({ target: [t.userDockShell.userId, t.userDockShell.worktreeKey] })
    .prepare(),
)

const upsertDockShell = prepared((db, t) =>
  db
    .insert(t.userDockShell)
    .values(dockShellValues)
    .onConflictDoUpdate({
      target: [t.userDockShell.userId, t.userDockShell.worktreeKey],
      set: { sessionId: P('sessionId'), updatedAt: P('updatedAt') },
    })
    .prepare(),
)

const deleteDockShellSlot = prepared((db, t) =>
  db.delete(t.userDockShell).where(shellSlotIs(t)).prepare(),
)

const dockShellsOfWorktree = prepared((db, t) =>
  db
    .select({ sessionId: t.userDockShell.sessionId })
    .from(t.userDockShell)
    .where(shellWorktreeIs(t))
    .prepare(),
)

const deleteDockShellsOfWorktree = prepared((db, t) =>
  db.delete(t.userDockShell).where(shellWorktreeIs(t)).prepare(),
)

const deleteDockShellsOfSession = prepared((db, t) =>
  db.delete(t.userDockShell).where(shellSessionIs(t)).prepare(),
)

/** A session's rows in primary-key order, the order both shell readers share. */
const shellKeyOrder = (t: StoreTables) => [
  asc(t.userDockShell.userId),
  asc(t.userDockShell.worktreeKey),
]

/** An IN list sized by `inListSize`: see `worktreesForSessions`. The one-session
 *  read is its size-1 shape, so the two return a session's rows in one order. */
const worktreesOfSessions = preparedFamily((db, t, size: number) =>
  db
    .select({
      sessionId: t.userDockShell.sessionId,
      userId: t.userDockShell.userId,
      worktreeKey: t.userDockShell.worktreeKey,
    })
    .from(t.userDockShell)
    .where(inWorkspace(t.userDockShell, inListOf(t.userDockShell.sessionId, size)))
    .orderBy(...shellKeyOrder(t))
    .prepare(),
)

/** At most this many session ids in one shell read: a power of two, far under
 *  SQLite's 32766 bound parameters. */
const SHELL_IDS_PER_STATEMENT = 4096

export class UserLayoutRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * One person's layout snapshot — every key they have set, as a plain map.
   * POD-403 hydrates ui-state from this object (bootstrap / command response).
   * Unparseable rows are skipped (same posture as preferences).
   */
  async getSnapshot(userId: UserId): Promise<LayoutSnapshot> {
    const rows = await layoutOfUser(this.db).all({ userId })
    const out: LayoutSnapshot = {}
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        // Unparseable: treated as absent.
      }
    }
    return out
  }

  /** Full durable truth for boot reconciliation only, before clients are served.
   * Ordinary reads remain user-scoped. Malformed JSON is absent, just as in getSnapshot. */
  async allForBootReconcile(pageSize = 500): Promise<LayoutWire[]> {
    const values: LayoutWire[] = []
    let after: { afterUserId: UserId; afterKey: string } | null = null
    for (;;) {
      const rows: Array<{ userId: UserId; key: string; value: string }> =
        after === null
          ? await layoutRowsPage(this.db, 'start').all({
              afterUserId: '',
              afterKey: '',
              limit: pageSize,
            })
          : await layoutRowsPage(this.db, 'after').all({ ...after, limit: pageSize })
      for (const row of rows) {
        try {
          values.push({ userId: row.userId, key: row.key, value: JSON.parse(row.value) })
        } catch {
          // Corrupt rows must not poison the feed or disagree with getSnapshot.
        }
      }
      if (rows.length < pageSize) return values
      const last = rows[rows.length - 1]!
      after = { afterUserId: last.userId, afterKey: last.key }
    }
  }

  /** One key's value, or `undefined` when never set. */
  async get(userId: UserId, key: string): Promise<unknown> {
    const row = await layoutValue(this.db).get({ userId, key })
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  /**
   * Write one layout key. THROWS on a key outside the closed vocabulary so a
   * mis-routed device-local key cannot grow a server row.
   *
   * `user_layout` is a synced table: every writer here takes the commit's write
   * scope, so it only runs inside the `Ledger.commit` that appends the row's
   * change entry (ADR 12 D9, POD-6594). That is what retired the old write
   * followed by a separate capture.
   */
  async set(
    _scope: WriteScope,
    userId: UserId,
    key: string,
    value: unknown,
    updatedAt: string,
  ): Promise<void> {
    if (!isLayoutKey(key)) {
      throw new Error(
        `'${key}' is not a replicated layout key (POD-1350 / isLayoutKey), so it has no server row`,
      )
    }
    await this.write(userId, key, value, updatedAt)
  }

  /** Apply a multi-key patch. Refuses the whole batch if any key is inadmissible. */
  async setMany(
    _scope: WriteScope,
    userId: UserId,
    values: Record<string, unknown>,
    updatedAt: string,
  ): Promise<void> {
    for (const key of Object.keys(values)) {
      if (!isLayoutKey(key)) {
        throw new Error(
          `'${key}' is not a replicated layout key (POD-1350 / isLayoutKey), so it has no server row`,
        )
      }
    }
    await this.createOrJoinTransaction(async () => {
      for (const [key, value] of Object.entries(values)) {
        await this.write(userId, key, value, updatedAt)
      }
    })
  }

  /**
   * The one layout write, shared by {@link set} and {@link setMany}.
   *
   * `user_layout` carries its `(user_id, key)` primary key and NO second
   * uniqueness constraint, so `ON CONFLICT` on that key is `INSERT OR REPLACE`
   * exactly (checklist item 1, as amended: every column is named).
   */
  private async write(
    userId: UserId,
    key: string,
    value: unknown,
    updatedAt: string,
  ): Promise<void> {
    const encoded = JSON.stringify(value ?? null)
    await upsertLayout(this.db).run({ userId, key, value: encoded, updatedAt })
  }

  /** Forget one key — the client falls back to its default. */
  async clear(_scope: WriteScope, userId: UserId, key: string): Promise<void> {
    await deleteLayoutKey(this.db).run({ userId, key })
  }

  async clearMany(scope: WriteScope, userId: UserId, keys: readonly string[]): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      for (const key of keys) await this.clear(scope, userId, key)
    })
  }

  async keysFor(userId: UserId): Promise<string[]> {
    const rows = await layoutKeysOfUser(this.db).all({ userId })
    return rows.map((r) => r.key)
  }
}

/**
 * SERVER-OWNED DOCK-SHELL MAPPING AT REST, KEYED BY (USER, WORKTREE) (POD-4436).
 *
 * "Which shell belongs to this worktree" is a server fact so the same dock
 * shell opens on every device. One row per `(user_id, worktree_key)` where
 * `worktree_key` is the normalized absolute path
 * (`normalizeDockWorktreeKey`): `a` and `a/` are one row. Tab shells from the
 * + menu are unmapped by design (SP-75b1) and never grow a row here.
 *
 * ---------------------------------------------------------------------------
 * EVERY READ TAKES A USER, EXCEPT THE FREE-PATH DELETE. THERE IS NO OTHER
 * METHOD THAT DOES NOT.
 * ---------------------------------------------------------------------------
 * Same posture as {@link UserLayoutRepository}: a caller's mapping is their
 * own rows. The one exception is `removeByWorktree`, which deletes every
 * user's row for a freed worktree path — freeing is a global fact about the
 * disk, not a per-user preference, so every device's dock must release it.
 *
 * ---------------------------------------------------------------------------
 * THE PRIMARY KEY KEEPS THE ROW SINGLE; IT DOES NOT ARBITRATE CREATION
 * ---------------------------------------------------------------------------
 * The `(user_id, worktree_key)` primary key keeps one row per user and
 * worktree: `tryClaim` inserts with ON CONFLICT DO NOTHING and reports whether
 * THIS caller's insert landed. That is not what makes two devices opening the
 * same worktree at once create exactly one shell — the dock-shell service's
 * in-process per-(user, worktree) mutex is (`modules/shells/service.ts`). A
 * loser that re-reads between the winner's claim and the winner's create finds
 * a row with no session, reads it as dead, and would replace it; only the
 * mutex keeps it from getting there. `set` is the upsert for replacing a dead
 * shell, never the creation path.
 */
export class UserDockShellRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /** Resolve the normalized key or THROW — a relative cwd cannot name a worktree. */
  private keyOf(worktreePath: string): string {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) {
      throw new Error(
        `'${worktreePath}' is not an absolute worktree path, so it has no dock-shell row`,
      )
    }
    return key
  }

  /** One user's dock shell for one worktree, or `undefined` when never mapped. */
  async get(userId: UserId, worktreePath: string): Promise<SessionId | undefined> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) return undefined
    const row = await dockShellOfSlot(this.db).get({ userId, worktreeKey: key })
    return row?.sessionId
  }

  /** Every worktree→shell entry for one user, as a plain map. */
  async listForUser(userId: UserId): Promise<Record<string, SessionId>> {
    const rows = await dockShellsOfUser(this.db).all({ userId })
    const out: Record<string, SessionId> = {}
    for (const row of rows) out[row.worktreeKey] = row.sessionId
    return out
  }

  /**
   * Claim the (user, worktree) slot for `sessionId`. Returns true when THIS
   * caller won, false when a row already exists (winner's id survives — this
   * never overwrites). The creation arbiter: callers mint an id, claim, and
   * only the winner spawns.
   */
  async tryClaim(
    userId: UserId,
    worktreePath: string,
    sessionId: SessionId,
    updatedAt: string,
  ): Promise<boolean> {
    const key = this.keyOf(worktreePath)
    await claimDockShell(this.db).run({ userId, worktreeKey: key, sessionId, updatedAt })
    const row = await dockShellOfSlot(this.db).get({ userId, worktreeKey: key })
    return row?.sessionId === sessionId
  }

  /**
   * Point (user, worktree) at `sessionId`, replacing a dead shell's row.
   * Upsert, never the creation path — creation races go through `tryClaim`.
   */
  async set(
    userId: UserId,
    worktreePath: string,
    sessionId: SessionId,
    updatedAt: string,
  ): Promise<void> {
    const key = this.keyOf(worktreePath)
    await upsertDockShell(this.db).run({ userId, worktreeKey: key, sessionId, updatedAt })
  }

  /** Forget one user's mapping for one worktree. */
  async remove(userId: UserId, worktreePath: string): Promise<void> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) return
    await deleteDockShellSlot(this.db).run({ userId, worktreeKey: key })
  }

  /**
   * Forget EVERY user's mapping for a freed worktree path. Freeing is global:
   * the disk fact holds for all devices, so every dock releases it. The
   * lifetime policy parks/kills per its rule from the returned session ids.
   */
  async removeByWorktree(worktreePath: string): Promise<SessionId[]> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) return []
    const rows = await dockShellsOfWorktree(this.db).all({ worktreeKey: key })
    await deleteDockShellsOfWorktree(this.db).run({ worktreeKey: key })
    return rows.map((r) => r.sessionId)
  }

  /** Forget every mapping that points at `sessionId` (shell retired). */
  async removeBySession(sessionId: SessionId): Promise<void> {
    await deleteDockShellsOfSession(this.db).run({ sessionId })
  }

  /**
   * Every (user, worktree) row pointing at `sessionId` — the reverse lookup
   * the lifetime policy reads to answer "owning worktree" exactly (POD-4436
   * step 3), instead of containing a cwd string. Normally one row: one dock
   * shell per worktree per user, and one claim wins each slot.
   */
  async worktreeForSession(
    sessionId: SessionId,
  ): Promise<Array<{ userId: UserId; worktreeKey: string }>> {
    const rows = await worktreesOfSessions(this.db, 1).all(inListValues([sessionId], 1))
    return rows.map((r) => ({ userId: r.userId, worktreeKey: r.worktreeKey }))
  }

  /**
   * {@link worktreeForSession} for many shells in ONE statement (POD-4627).
   * The host sample asks this four to six times a sample; per-shell reads were
   * ~5,000 statements a sample on a real 1,000-shell database.
   *
   * The ids travel as an `IN (?, ?, …)` list sized by `inListSize`, so the
   * driver's per-text statement cache holds one statement per power of two,
   * not one per live-shell count; a list past {@link SHELL_IDS_PER_STATEMENT}
   * is read in chunks of that size, under SQLite's bound-parameter ceiling
   * (POD-6983: the JSON parameter this replaced read `json_each`, which
   * Postgres has not).
   *
   * Each session's rows come back in primary-key order, the order the
   * single-session read returns them in, so `rows[0]` is the same row either
   * way, on both engines. A session with no mapping is absent from the map.
   */
  async worktreesForSessions(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, Array<{ userId: UserId; worktreeKey: string }>>> {
    const out = new Map<SessionId, Array<{ userId: UserId; worktreeKey: string }>>()
    if (sessionIds.length === 0) return out
    const ids = [...new Set(sessionIds)]
    for (let start = 0; start < ids.length; start += SHELL_IDS_PER_STATEMENT) {
      const chunk = ids.slice(start, start + SHELL_IDS_PER_STATEMENT)
      const size = inListSize(chunk.length)
      for (const r of await worktreesOfSessions(this.db, size).all(inListValues(chunk, size))) {
        const bucket = out.get(r.sessionId)
        const row = { userId: r.userId, worktreeKey: r.worktreeKey }
        if (bucket) bucket.push(row)
        else out.set(r.sessionId, [row])
      }
    }
    return out
  }
}
