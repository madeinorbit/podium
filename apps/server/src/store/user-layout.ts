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
 * EVERY READ TAKES A USER. THERE IS NO METHOD THAT DOES NOT.
 * ---------------------------------------------------------------------------
 * Same posture as {@link UserPreferencesRepository}: no bulk cross-user read.
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
  normalizeDockWorktreeKey,
  type SessionId,
  type UserId,
} from '@podium/model'
import { and, asc, eq } from 'drizzle-orm'
import { userDockShell, userLayout } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'

export class UserLayoutRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
  }

  /**
   * One person's layout snapshot — every key they have set, as a plain map.
   * POD-403 hydrates ui-state from this object (bootstrap / command response).
   * Unparseable rows are skipped (same posture as preferences).
   */
  async getSnapshot(userId: UserId): Promise<LayoutSnapshot> {
    const rows = await this.db
      .select({ key: userLayout.key, value: userLayout.value })
      .from(userLayout)
      .where(eq(userLayout.userId, userId))
      .all()
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

  /** One key's value, or `undefined` when never set. */
  async get(userId: UserId, key: string): Promise<unknown> {
    const row = await this.db
      .select({ value: userLayout.value })
      .from(userLayout)
      .where(and(eq(userLayout.userId, userId), eq(userLayout.key, key)))
      .get()
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
   */
  async set(userId: UserId, key: string, value: unknown, updatedAt: string): Promise<void> {
    if (!isLayoutKey(key)) {
      throw new Error(
        `'${key}' is not a replicated layout key (POD-1350 / isLayoutKey), so it has no server row`,
      )
    }
    await this.write(userId, key, value, updatedAt)
  }

  /** Apply a multi-key patch. Refuses the whole batch if any key is inadmissible. */
  async setMany(userId: UserId, values: Record<string, unknown>, updatedAt: string): Promise<void> {
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
  private async write(userId: UserId, key: string, value: unknown, updatedAt: string): Promise<void> {
    const encoded = JSON.stringify(value ?? null)
    ;await (this.db
      .insert(userLayout)
      .values({ userId, key, value: encoded, updatedAt }))
      .onConflictDoUpdate({
        target: [userLayout.userId, userLayout.key],
        set: { value: encoded, updatedAt },
      })
      .run()
  }

  /** Forget one key — the client falls back to its default. */
  async clear(userId: UserId, key: string): Promise<void> {
    await this.db
      .delete(userLayout)
      .where(and(eq(userLayout.userId, userId), eq(userLayout.key, key)))
      .run()
  }

  async clearMany(userId: UserId, keys: readonly string[]): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      for (const key of keys) await this.clear(userId, key)
    })
  }

  async keysFor(userId: UserId): Promise<string[]> {
    const rows = await this.db
      .select({ key: userLayout.key })
      .from(userLayout)
      .where(eq(userLayout.userId, userId))
      .orderBy(asc(userLayout.key))
      .all()
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
 * UNIQUENESS IS THE CONCURRENCY CONTROL, NOT CHECK-THEN-INSERT
 * ---------------------------------------------------------------------------
 * The `(user_id, worktree_key)` primary key arbitrates creation:
 * `tryClaim` inserts with ON CONFLICT DO NOTHING and reports whether THIS
 * caller won, so two devices opening the same worktree at once create exactly
 * one shell — the loser re-reads the winner's row and never spawns. `set` is
 * the upsert for replacing a dead shell, never the creation path.
 */
export class UserDockShellRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
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
    const row = await this.db
      .select({ sessionId: userDockShell.sessionId })
      .from(userDockShell)
      .where(and(eq(userDockShell.userId, userId), eq(userDockShell.worktreeKey, key)))
      .get()
    return row?.sessionId
  }

  /** Every worktree→shell entry for one user, as a plain map. */
  async listForUser(userId: UserId): Promise<Record<string, SessionId>> {
    const rows = await this.db
      .select({ worktreeKey: userDockShell.worktreeKey, sessionId: userDockShell.sessionId })
      .from(userDockShell)
      .where(eq(userDockShell.userId, userId))
      .orderBy(asc(userDockShell.worktreeKey))
      .all()
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
    await this.db
      .insert(userDockShell)
      .values({ userId, worktreeKey: key, sessionId, updatedAt })
      .onConflictDoNothing({ target: [userDockShell.userId, userDockShell.worktreeKey] })
      .run()
    const row = await this.db
      .select({ sessionId: userDockShell.sessionId })
      .from(userDockShell)
      .where(and(eq(userDockShell.userId, userId), eq(userDockShell.worktreeKey, key)))
      .get()
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
    await this.db
      .insert(userDockShell)
      .values({ userId, worktreeKey: key, sessionId, updatedAt })
      .onConflictDoUpdate({
        target: [userDockShell.userId, userDockShell.worktreeKey],
        set: { sessionId, updatedAt },
      })
      .run()
  }

  /** Forget one user's mapping for one worktree. */
  async remove(userId: UserId, worktreePath: string): Promise<void> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) return
    await this.db
      .delete(userDockShell)
      .where(and(eq(userDockShell.userId, userId), eq(userDockShell.worktreeKey, key)))
      .run()
  }

  /**
   * Forget EVERY user's mapping for a freed worktree path. Freeing is global:
   * the disk fact holds for all devices, so every dock releases it. The
   * lifetime policy parks/kills per its rule from the returned session ids.
   */
  async removeByWorktree(worktreePath: string): Promise<SessionId[]> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) return []
    const rows = await this.db
      .select({ sessionId: userDockShell.sessionId })
      .from(userDockShell)
      .where(eq(userDockShell.worktreeKey, key))
      .all()
    await this.db.delete(userDockShell).where(eq(userDockShell.worktreeKey, key)).run()
    return rows.map((r) => r.sessionId)
  }

  /** Forget every mapping that points at `sessionId` (shell retired). */
  async removeBySession(sessionId: SessionId): Promise<void> {
    await this.db.delete(userDockShell).where(eq(userDockShell.sessionId, sessionId)).run()
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
    const rows = await this.db
      .select({ userId: userDockShell.userId, worktreeKey: userDockShell.worktreeKey })
      .from(userDockShell)
      .where(eq(userDockShell.sessionId, sessionId))
      .all()
    return rows.map((r) => ({ userId: r.userId, worktreeKey: r.worktreeKey }))
  }
}
