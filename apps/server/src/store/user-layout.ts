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
import type { SqlDatabase } from '@podium/runtime/sqlite'

interface LayoutRow {
  key: string
  value: string
}

export class UserLayoutRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * One person's layout snapshot — every key they have set, as a plain map.
   * POD-403 hydrates ui-state from this object (bootstrap / command response).
   * Unparseable rows are skipped (same posture as preferences).
   */
  getSnapshot(userId: UserId): LayoutSnapshot {
    const rows = this.db
      .prepare('SELECT key, value FROM user_layout WHERE user_id = ?')
      .all(userId) as LayoutRow[]
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
      .prepare('SELECT value FROM user_layout WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined
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
    this.db
      .prepare(
        'INSERT OR REPLACE INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, key, JSON.stringify(value ?? null), updatedAt)
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
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    )
    const run = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        stmt.run(userId, key, JSON.stringify(value ?? null), updatedAt)
      }
    })
    run()
  }

  /** Forget one key — the client falls back to its default. */
  clear(userId: UserId, key: string): void {
    this.db.prepare('DELETE FROM user_layout WHERE user_id = ? AND key = ?').run(userId, key)
  }

  clearMany(userId: UserId, keys: readonly string[]): void {
    const stmt = this.db.prepare('DELETE FROM user_layout WHERE user_id = ? AND key = ?')
    const run = this.db.transaction(() => {
      for (const key of keys) stmt.run(userId, key)
    })
    run()
  }

  keysFor(userId: UserId): string[] {
    const rows = this.db
      .prepare('SELECT key FROM user_layout WHERE user_id = ? ORDER BY key')
      .all(userId) as { key: string }[]
    return rows.map((r) => r.key)
  }
}
