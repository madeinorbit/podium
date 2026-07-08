/**
 * Events/steward aggregate — owns the durable orchestrator event log
 * (`podium_events`), the steward's KV state (`steward_state`) and the
 * event-subscription tables (`subscriptions`, `subscription_deliveries`,
 * event-subscriptions design Phase B).
 */

import type { SqlDatabase } from '@podium/core/sqlite'
import type { Subscription } from './types'

function rowToSubscription(r: Record<string, unknown>): Subscription {
  return {
    id: r.id as string,
    subscriberKind: r.subscriber_kind as Subscription['subscriberKind'],
    subscriberId: r.subscriber_id as string,
    event: r.event as string,
    sourceKind: r.source_kind as Subscription['sourceKind'],
    sourceRef: r.source_ref as string,
    deliverNudge: Number(r.deliver_nudge) !== 0,
    deliverNotify: Number(r.deliver_notify) !== 0,
    origin: r.origin as Subscription['origin'],
    enabled: Number(r.enabled) !== 0,
    createdAt: r.created_at as string,
  }
}

export class EventsRepository {
  constructor(private readonly db: SqlDatabase) {}

  // ---- event log ----

  appendEvent(e: {
    ts: string
    kind: string
    subject: string
    repoPath?: string | null
    payload?: unknown
  }): number {
    const r = this.db
      .prepare(
        'INSERT INTO podium_events (ts, kind, subject, repo_path, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.ts, e.kind, e.subject, e.repoPath ?? null, JSON.stringify(e.payload ?? {}))
    return Number(r.lastInsertRowid)
  }

  listEventsSince(
    sinceId: number,
    opts?: { kinds?: string[]; repoPath?: string; limit?: number },
  ): Array<{
    id: number
    ts: string
    kind: string
    subject: string
    repoPath: string | null
    payload: unknown
  }> {
    const where = ['id > ?']
    const params: unknown[] = [sinceId]
    if (opts?.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`)
      params.push(...opts.kinds)
    }
    if (opts?.repoPath) {
      where.push('repo_path = ?')
      params.push(opts.repoPath)
    }
    params.push(opts?.limit ?? 200)
    const rows = this.db
      .prepare(`SELECT * FROM podium_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map((r) => {
      let payload: unknown = {}
      try {
        payload = JSON.parse(r.payload as string)
      } catch {}
      return {
        id: Number(r.id),
        ts: r.ts as string,
        kind: r.kind as string,
        subject: r.subject as string,
        repoPath: (r.repo_path as string | null) ?? null,
        payload,
      }
    })
  }

  /** The highest event id in the log (0 when empty) — the "now" mark for
   *  seeding a consumer cursor that must not replay history. */
  maxEventId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM podium_events').get() as {
      m: number | null
    }
    return r.m ?? 0
  }

  /**
   * Event-log retention (issue #61): delete rows older than maxAgeDays, and always
   * keep the total row count ≤ maxRows (dropping the oldest beyond the cap even if
   * young). Returns the number of rows deleted.
   *
   * Cursor safety: `id` is AUTOINCREMENT, so ids are never reused after deletion —
   * a consumer cursor (e.g. the steward's persisted `steward_state` cursor) stays
   * valid across pruning: listEventsSince(cursor) simply returns whatever retained
   * rows still lie above it. The one intentional gap: a consumer that was disabled
   * for longer than the retention window will silently miss the pruned events.
   * That is BY DESIGN — first-enable seeds the cursor to MAX(id) ("now") anyway,
   * so replaying deep history was never part of the contract.
   */
  pruneEvents(opts: { maxAgeDays: number; maxRows: number }): number {
    // ts is an ISO-8601 string, so lexicographic comparison == chronological.
    const cutoff = new Date(Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const byAge = this.db.prepare('DELETE FROM podium_events WHERE ts < ?').run(cutoff)
    // Row cap: keep only the newest maxRows rows (highest ids), regardless of age.
    const byCap = this.db
      .prepare(
        'DELETE FROM podium_events WHERE id NOT IN (SELECT id FROM podium_events ORDER BY id DESC LIMIT ?)',
      )
      .run(opts.maxRows)
    return Number(byAge.changes) + Number(byCap.changes)
  }

  // ---- steward state ----

  getStewardState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM steward_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setStewardState(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO steward_state (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  // ---- event subscriptions (event-subscriptions design, Phase B) ----

  addSubscription(sub: Subscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, subscriber_kind, subscriber_id, event, source_kind, source_ref,
            deliver_nudge, deliver_notify, origin, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.id,
        sub.subscriberKind,
        sub.subscriberId,
        sub.event,
        sub.sourceKind,
        sub.sourceRef,
        sub.deliverNudge ? 1 : 0,
        sub.deliverNotify ? 1 : 0,
        sub.origin,
        sub.enabled ? 1 : 0,
        sub.createdAt,
      )
  }

  removeSubscription(id: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
  }

  listSubscriptions(filter?: { subscriberId?: string }): Subscription[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter?.subscriberId) {
      where.push('subscriber_id = ?')
      params.push(filter.subscriberId)
    }
    const sql = `SELECT * FROM subscriptions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
    const rows = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]
    return rows.map(rowToSubscription)
  }

  /** Flip a subscription's enabled flag. Returns true when a row was updated. */
  setSubscriptionEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .prepare('UPDATE subscriptions SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id)
    return r.changes > 0
  }

  getSubscription(id: string): Subscription | undefined {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToSubscription(row) : undefined
  }

  listEnabledSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY created_at ASC')
      .all() as Record<string, unknown>[]
    return rows.map(rowToSubscription)
  }

  /** Record a (subscription, event) delivery. Returns true only when the pair was
   *  NEWLY inserted — a replay (or a same-poll double-match) returns false so the
   *  steward delivers exactly once. */
  markDelivered(subscriptionId: string, eventId: number): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO subscription_deliveries (subscription_id, event_id) VALUES (?, ?)',
      )
      .run(subscriptionId, eventId)
    return Number(r.changes) > 0
  }
}
