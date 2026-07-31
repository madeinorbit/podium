/**
 * PERSONAL PREFERENCES AT REST, KEYED BY USER (POD-1213).
 *
 * The twenty-four `preferences-personal` leaves used to be members of the
 * instance-wide `meta['settings']` JSON blob, which is served whole to every
 * authenticated client — so one person's role choices, sidebar order,
 * autoContinue dismissal, ntfy topic and Telegram chat id were readable by every
 * other person. `20260731040000_personal-preference-store` lifted them here and
 * removed them there.
 *
 * ---------------------------------------------------------------------------
 * EVERY READ TAKES A USER. THERE IS NO METHOD THAT DOES NOT.
 * ---------------------------------------------------------------------------
 *
 * No `all()`, no `getEveryone()`, no `Record<UserId, …>`. The leak this replaces
 * was not a missing filter at one call site — it was a bulk accessor whose result
 * something then serialized, and a repository that offers one invites the same
 * shape back one layer down. `ServerSecretsRepository` declines a
 * `getAllAsBlob()` for the same reason and says so in its own header.
 *
 * The one exception is {@link keysFor}-style enumeration WITHIN a user, which is
 * still scoped to a user. A caller that wants two people's preferences must ask
 * twice, and will be visible doing it.
 *
 * ---------------------------------------------------------------------------
 * WHICH KEYS ARE ADMISSIBLE IS THE MODEL'S ANSWER, NOT THIS FILE'S
 * ---------------------------------------------------------------------------
 *
 * {@link UserPreferencesRepository.set} refuses a key that
 * `settingsPathsInTier('personal-preference')` does not classify. That is
 * POD-418's DERIVED table — the same one the command contracts admit paths from
 * — so a leaf added to `PersonalPreferences` becomes writable here on the same
 * commit, and an instance-tier or secret path can never acquire a per-user row
 * that would then shadow the singleton it belongs on. A hand-written key list
 * here would be the second list this programme exists to end.
 *
 * ---------------------------------------------------------------------------
 * VALUES ARE JSON TEXT, ABSENCE IS THE ROW BEING ABSENT
 * ---------------------------------------------------------------------------
 *
 * The column holds the leaf's JSON encoding, so `true` stays a boolean and
 * `sidebar.repoOrder` stays an array. There is no "unset" value: {@link clear}
 * DELETEs, and an absent row means "this person has never set it", which is what
 * lets the resolver fall back to the instance blob without having to
 * distinguish a stored default from a choice.
 */

import { settingsPathsInTier, type UserId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** The admissible keys, derived once. A `Set` for the membership test only — the
 *  ORDER and the CONTENT are the classification's, never this module's. */
const PERSONAL_PREFERENCE_KEYS: ReadonlySet<string> = new Set(
  settingsPathsInTier('personal-preference'),
)

/** Is this dotted path a personal preference? Exported because the settings
 *  service partitions an incoming blob write by the same question, and two
 *  answers to "is this key personal" is how a leaf ends up written to both
 *  homes. */
export const isPersonalPreferenceKey = (key: string): boolean => PERSONAL_PREFERENCE_KEYS.has(key)

interface PreferenceRow {
  key: string
  value: string
}

export class UserPreferencesRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * One person's stored preferences, as `path → parsed JSON value`.
   *
   * Rows this build cannot parse are SKIPPED rather than thrown on: a corrupt
   * row must not make a user's whole settings screen fail to load, which is the
   * posture `SettingsRepository.getSettings` already takes for a corrupt blob.
   * The skipped path then resolves to its fallback, which is the same answer as
   * "never set".
   */
  getFor(userId: UserId): Map<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
      .all(userId) as PreferenceRow[]
    const out = new Map<string, unknown>()
    for (const row of rows) {
      try {
        out.set(row.key, JSON.parse(row.value))
      } catch {
        // Unparseable row: treated as absent. See above.
      }
    }
    return out
  }

  /** One person's value for one path, or `undefined` when they have never set
   *  it. `undefined` is the ABSENCE answer and is never a stored value — the
   *  column is NOT NULL and holds JSON, so a stored `null` reads back as `null`. */
  get(userId: UserId, key: string): unknown {
    const row = this.db
      .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  /**
   * Write one person's value for one personal preference path.
   *
   * THROWS on a key the classification does not put in this tier. A silent
   * ignore would make a mis-tiered write look identical to a successful one at
   * every call site — the failure mode where a green save button and a lost
   * write are indistinguishable — and a permissive write would let an
   * instance-tier path grow a per-user row that shadows the singleton.
   */
  set(userId: UserId, key: string, value: unknown, updatedAt: string): void {
    if (!isPersonalPreferenceKey(key)) {
      throw new Error(
        `'${key}' is not a personal preference (POD-418 classification), so it has no per-user row`,
      )
    }
    this.db
      .prepare(
        'INSERT OR REPLACE INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, key, JSON.stringify(value ?? null), updatedAt)
  }

  /** Forget one person's choice for one path — it resolves to the fallback
   *  again. A DELETE rather than a written default, so "never chosen" and "chose
   *  the value that happens to be the default" stay distinguishable. */
  clear(userId: UserId, key: string): void {
    this.db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(userId, key)
  }

  /** Every path this person has set. Scoped to one user like every other method
   *  here — see the file header on why there is no cross-user read. */
  keysFor(userId: UserId): string[] {
    const rows = this.db
      .prepare('SELECT key FROM user_preferences WHERE user_id = ? ORDER BY key')
      .all(userId) as { key: string }[]
    return rows.map((r) => r.key)
  }
}
