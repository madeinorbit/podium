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

import { isLayoutKey, type LayoutSnapshot, type UserId } from '@podium/model'
import { and, asc, eq } from 'drizzle-orm'
import { userLayout } from '../migrations/schema'
import type { SyncDrizzle, SyncQueries } from './executor/sync-drizzle'

export class UserLayoutRepository {
  constructor(private readonly queries: SyncQueries) {}

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): SyncDrizzle {
    return this.queries.db
  }

  /**
   * Rule 34a — an arrow FIELD, not `this.transact = queries.transact`. The
   * straight assignment works only while the implementation ignores `this`, and
   * it stops working silently the moment it does not.
   */
  protected transact = <T>(fn: () => T): T => this.queries.transact(fn)

  /**
   * One person's layout snapshot — every key they have set, as a plain map.
   * POD-403 hydrates ui-state from this object (bootstrap / command response).
   * Unparseable rows are skipped (same posture as preferences).
   */
  getSnapshot(userId: UserId): LayoutSnapshot {
    const rows = this.db
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
  get(userId: UserId, key: string): unknown {
    const row = this.db
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
  set(userId: UserId, key: string, value: unknown, updatedAt: string): void {
    if (!isLayoutKey(key)) {
      throw new Error(
        `'${key}' is not a replicated layout key (POD-1350 / isLayoutKey), so it has no server row`,
      )
    }
    this.write(userId, key, value, updatedAt)
  }

  /** Apply a multi-key patch. Refuses the whole batch if any key is inadmissible. */
  setMany(userId: UserId, values: Record<string, unknown>, updatedAt: string): void {
    for (const key of Object.keys(values)) {
      if (!isLayoutKey(key)) {
        throw new Error(
          `'${key}' is not a replicated layout key (POD-1350 / isLayoutKey), so it has no server row`,
        )
      }
    }
    this.transact(() => {
      for (const [key, value] of Object.entries(values)) {
        this.write(userId, key, value, updatedAt)
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
  private write(userId: UserId, key: string, value: unknown, updatedAt: string): void {
    const encoded = JSON.stringify(value ?? null)
    this.db
      .insert(userLayout)
      .values({ userId, key, value: encoded, updatedAt })
      .onConflictDoUpdate({
        target: [userLayout.userId, userLayout.key],
        set: { value: encoded, updatedAt },
      })
      .run()
  }

  /** Forget one key — the client falls back to its default. */
  clear(userId: UserId, key: string): void {
    this.db
      .delete(userLayout)
      .where(and(eq(userLayout.userId, userId), eq(userLayout.key, key)))
      .run()
  }

  clearMany(userId: UserId, keys: readonly string[]): void {
    this.transact(() => {
      for (const key of keys) this.clear(userId, key)
    })
  }

  keysFor(userId: UserId): string[] {
    const rows = this.db
      .select({ key: userLayout.key })
      .from(userLayout)
      .where(eq(userLayout.userId, userId))
      .orderBy(asc(userLayout.key))
      .all()
    return rows.map((r) => r.key)
  }
}
