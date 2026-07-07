/**
 * Settings/meta aggregate — owns the `meta` key/value table: the settings
 * blob, the live model-catalog SWR cache, and the node⇄hub upstream sync
 * cursor + received-state blobs (docs/spec/node-hub-sync.md).
 */

import { normalizeSettings, type PodiumSettings } from '@podium/core'
import type { SqlDatabase } from '@podium/core/sqlite'

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

  // ---- node⇄hub upstream sync (docs/spec/node-hub-sync.md) ----
  /** Last hub oplog seq this node applied (meta key). Null until the first catch-up. */
  getUpstreamCursor(): number | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('upstream_sync_cursor') as { value: string } | undefined
    if (!row) return null
    const n = Number(row.value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  setUpstreamCursor(cursor: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('upstream_sync_cursor', String(cursor))
  }

  /**
   * Issues RECEIVED from the hub, stored verbatim as a JSON blob — deliberately NOT
   * merged into this node's IssueService (two issue stores merge in P7b; this is the
   * P7b input, kept durable so nothing received is lost across restarts).
   */
  setUpstreamIssuesJson(json: string): void {
    this.setUpstreamBlob('upstream_issues', json)
  }

  getUpstreamIssuesJson(): string | null {
    return this.getUpstreamBlob('upstream_issues')
  }

  /** Last-known hub sessions/conversations (wire JSON). Durable so a restarted
   *  UpstreamSync resumes from its persisted cursor with a DELTA applied on top
   *  of this base — a delta over an empty replica would silently drop entities. */
  setUpstreamSessionsJson(json: string): void {
    this.setUpstreamBlob('upstream_sessions', json)
  }

  getUpstreamSessionsJson(): string | null {
    return this.getUpstreamBlob('upstream_sessions')
  }

  setUpstreamConversationsJson(json: string): void {
    this.setUpstreamBlob('upstream_conversations', json)
  }

  getUpstreamConversationsJson(): string | null {
    return this.getUpstreamBlob('upstream_conversations')
  }

  private setUpstreamBlob(key: string, json: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, json)
  }

  private getUpstreamBlob(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }
}
