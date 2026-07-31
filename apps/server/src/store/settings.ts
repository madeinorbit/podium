/**
 * Settings/meta aggregate — owns the `meta` key/value table: the settings blob and
 * the live model-catalog SWR cache. (It also owned the node⇄hub sync cursor and the
 * received-state blobs until POD-309 retired the dialer that produced them.)
 *
 * ---------------------------------------------------------------------------
 * THE BLOB IS NO LONGER THE WHOLE ANSWER (POD-1213)
 * ---------------------------------------------------------------------------
 *
 * ADR 1's matrix puts this blob's leaves on three rows. POD-419 moved the
 * `server-secrets` third into `server_secrets`; POD-1213 moved the
 * `preferences-personal` twenty-four into `user_preferences`, keyed by user. What
 * remains in `meta['settings']` is the `preferences-instance` tier — a property of
 * the DEPLOYMENT, which every reader must resolve identically.
 *
 * So there are now TWO reads and they answer different questions:
 *
 *   - {@link SettingsRepository.getSettings} — the blob as stored. Instance tier
 *     is authoritative; the personal leaves are whatever the shape defaults to.
 *     It belongs to consumers that only need instance policy.
 *   - {@link SettingsRepository.getSettingsFor} — the blob RESOLVED FOR ONE
 *     PERSON. This is what a client is served and what any personal-tier consumer
 *     must read.
 *
 * The resolution is an overlay and never a merge back into storage: a per-user row
 * wins, and the blob's value is the fallback ONLY where no row exists. Writing the
 * resolved object back through {@link setSettings} would re-plant one person's
 * preferences on the shared row, which is the leak this issue removed — so
 * {@link setSettingsFor} is the write half, and it partitions by tier rather than
 * trusting its caller.
 */

import { applySettingsPatch, changedSettingsLeaves, readSettingsLeaf } from '@podium/commands'
import type { UserId } from '@podium/model'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { isPersonalPreferenceKey, UserPreferencesRepository } from './user-preferences'

export class SettingsRepository {
  /** The per-user half of the same aggregate. Composed rather than injected: the
   *  two tables answer ONE question ("what are this person's settings"), and a
   *  resolver that lived above them both would be a third place that knows which
   *  tier a key is in. */
  readonly userPreferences: UserPreferencesRepository

  constructor(private readonly db: SqlDatabase) {
    this.userPreferences = new UserPreferencesRepository(db)
  }

  /**
   * The INSTANCE-TIER settings, plus defaults for everything else.
   *
   * NOT what a client is served and not what a personal-tier consumer may read —
   * see {@link getSettingsFor}. The name is kept because the instance tier is
   * genuinely instance-wide and most consumers of this method want exactly that
   * (hibernation policy, git workflow, the steward toggle).
   */
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

  // -------------------------------------------------------------------------
  // The per-user resolution (POD-1213)
  // -------------------------------------------------------------------------

  /**
   * THE SETTINGS AS ONE PERSON SEES THEM: the instance blob with that person's
   * own preference rows laid over it.
   *
   * A row wins; the blob is the fallback ONLY where no row exists — which after
   * the migration means the model's default, and for an instance-tier key means
   * the deployment's answer, unchanged. No other user's rows are read: the
   * repository has no method that could.
   *
   * `normalizeSettings` runs LAST, over the overlaid object, so a stored value
   * this build no longer accepts is refused by the same schema that governs the
   * blob rather than by a second validation written here.
   */
  getSettingsFor(userId: UserId): PodiumSettings {
    const base = this.getSettings()
    const overlay = this.userPreferences.getFor(userId)
    if (overlay.size === 0) return base
    return normalizeSettings(applySettingsPatch(base, Object.fromEntries(overlay)))
  }

  /**
   * WRITE A WHOLE SETTINGS OBJECT ON BEHALF OF ONE PERSON, split by tier.
   *
   * This is the legacy `settings.set` shape — the shipped clients send the entire
   * blob back — met at the storage seam rather than trusted. Every leaf that
   * DIFFERS from what that person currently resolves is routed by its
   * classification: a personal leaf becomes their own row, an instance leaf lands
   * on the shared blob, and anything else is left to the caller's own guard
   * (`SettingsService.assertNoSecretChange` refuses a secret change before this
   * is reached).
   *
   * Only CHANGED leaves are written, which is what keeps a save from one client
   * from stamping twenty-four rows of unchanged defaults onto a person who never
   * opened the settings screen — and, more importantly, keeps a save from writing
   * another user's resolved values onto the shared blob.
   *
   * Returns the blob as it now stands (instance tier), for the caller's
   * `settings.changed` event pair.
   */
  setSettingsFor(userId: UserId, next: PodiumSettings, updatedAt: string): PodiumSettings {
    const resolved = this.getSettingsFor(userId)
    const instancePatch: Record<string, unknown> = {}
    for (const leaf of changedSettingsLeaves(resolved, next)) {
      if (isPersonalPreferenceKey(leaf.path)) {
        this.userPreferences.set(userId, leaf.path, leaf.value, updatedAt)
        continue
      }
      // Unclassified leaves land here too, and deliberately: they are members of
      // the blob this build does not classify (an older or newer shape), and the
      // blob is where they already live. The tier gate for a CONTRACTED write is
      // the command's input schema; this method serves the uncontracted legacy
      // blob write, whose job is to not lose them.
      instancePatch[leaf.path] = leaf.value
    }
    const blob = this.getSettings()
    if (Object.keys(instancePatch).length === 0) return blob
    const updated = normalizeSettings(applySettingsPatch(blob, instancePatch))
    this.setSettings(updated)
    return updated
  }

  /**
   * Apply a path-addressed patch, each path routed by its own tier — the storage
   * half of `settings.updatePersonal` / `settings.updateInstance`.
   *
   * The commands' input schemas have already refused every path outside their
   * tier, so this cannot be reached with a mixed patch from them; routing per
   * path anyway means the ONE answer to "where does this key live" is the
   * classification, at both entry points.
   */
  applyPreferencePatch(
    userId: UserId,
    values: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): PodiumSettings {
    const instancePatch: Record<string, unknown> = {}
    for (const [path, value] of Object.entries(values)) {
      if (isPersonalPreferenceKey(path)) {
        this.userPreferences.set(userId, path, value, updatedAt)
        continue
      }
      instancePatch[path] = value
    }
    if (Object.keys(instancePatch).length > 0) {
      this.setSettings(normalizeSettings(applySettingsPatch(this.getSettings(), instancePatch)))
    }
    return this.getSettingsFor(userId)
  }

  /** One person's value for one dotted path, resolved: their row, else the blob.
   *  For the consumers that need a single preference and should not materialise a
   *  whole settings object to get it. */
  preferenceFor(userId: UserId, path: string): unknown {
    const own = this.userPreferences.get(userId, path)
    return own !== undefined ? own : readSettingsLeaf(this.getSettings(), path)
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

  // RETIRED at POD-309: the node⇄hub cursor (`upstream_sync_cursor`) and the
  // last-known replica blobs (`upstream_sessions` / `upstream_conversations` /
  // `upstream_issues`) were read and written by `UpstreamSync` alone. The meta ROWS
  // are left in place rather than deleted — an operator's last-known hub state is data,
  // and ADR 5 D8 forbids silently discarding parked federation work — but nothing
  // reads them, so they are inert until POD-353 decides their fate.
}
