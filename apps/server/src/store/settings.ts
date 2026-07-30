/**
 * Settings/meta aggregate — owns the `meta` key/value table: the settings blob and
 * the live model-catalog SWR cache. (It also owned the node⇄hub sync cursor and the
 * received-state blobs until POD-309 retired the dialer that produced them.)
 */

import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import type { SqlDatabase } from '@podium/runtime/sqlite'

export class SettingsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** The whole settings blob, defaults filled in. A corrupt row reads as defaults. */
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
