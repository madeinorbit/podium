/**
 * Events/steward aggregate — owns the durable orchestrator event log
 * (`podium_events`), the steward's KV state (`steward_state`) and the
 * event-subscription tables (`subscriptions`, `subscription_deliveries`,
 * event-subscriptions design Phase B).
 */

import type { SessionId } from '@podium/model'
import { ISSUE_EVENTS_DEFAULT_LIMIT, ProviderCursor, RuntimeEvent } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { Subscription } from './types'

export interface PodiumEventRecord {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

function rowToEvent(r: Record<string, unknown>): PodiumEventRecord {
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
}

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

export const RUNTIME_EVENT_LOG_KIND = 'session.runtime'

export interface RuntimeEventCheckpoint {
  sessionId: SessionId
  observerGeneration: number
  cursor: import('@podium/protocol').ProviderCursor
  turnEpoch: number
  closedTurnEpoch: number | null
  updatedAt: string
}

export interface RuntimeEventLogRecord {
  id: number
  sessionId: SessionId
  event: import('@podium/protocol').RuntimeEvent
}

export interface EventPrunePlan {
  cutoff: string
  capThroughId: number
}

/** What an appended event is announced to, after it is durable (POD-1772). */
export type EventAppendListener = (
  id: number,
  event: { ts: string; kind: string; subject: string; repoPath: string | null; payload: unknown },
) => void

export class EventsRepository {
  /** The feed publisher, installed by the composition root once the ledger
   *  exists. Absent in the storage-only unit tests, and absent for the window
   *  between store construction and wiring — an event appended in that window is
   *  boot bookkeeping nobody is connected to see. */
  private appendListener: EventAppendListener | undefined

  constructor(private readonly db: SqlDatabase) {}

  /** Install the post-append announcement. One listener: this is the feed's
   *  seam, not a general event bus (the orchestrator already has one). */
  onAppend(listener: EventAppendListener): void {
    this.appendListener = listener
  }

  // ---- coarse runtime event log + restart head ----

  runtimeEventCheckpoint(sessionId: SessionId): RuntimeEventCheckpoint | null {
    const row = this.db
      .prepare(
        'SELECT observer_generation, cursor_json, turn_epoch, closed_turn_epoch, updated_at FROM runtime_event_checkpoints WHERE session_id = ?',
      )
      .get(sessionId) as Record<string, unknown> | undefined
    if (!row) return null
    try {
      const cursor = ProviderCursor.parse(JSON.parse(String(row.cursor_json)))
      return {
        sessionId,
        observerGeneration: Number(row.observer_generation),
        cursor,
        turnEpoch: Number(row.turn_epoch),
        closedTurnEpoch: row.closed_turn_epoch == null ? null : Number(row.closed_turn_epoch),
        updatedAt: String(row.updated_at),
      }
    } catch {
      return null
    }
  }

  saveRuntimeEventCheckpoint(checkpoint: RuntimeEventCheckpoint): void {
    this.db
      .prepare(
        'INSERT INTO runtime_event_checkpoints (session_id, observer_generation, cursor_json, turn_epoch, closed_turn_epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET observer_generation = excluded.observer_generation, cursor_json = excluded.cursor_json, turn_epoch = excluded.turn_epoch, closed_turn_epoch = excluded.closed_turn_epoch, updated_at = excluded.updated_at',
      )
      .run(
        checkpoint.sessionId,
        checkpoint.observerGeneration,
        JSON.stringify(checkpoint.cursor),
        checkpoint.turnEpoch,
        checkpoint.closedTurnEpoch,
        checkpoint.updatedAt,
      )
  }

  listRuntimeEvents(sessionId: SessionId, limit = 64): RuntimeEvent[] {
    const rows = this.db
      .prepare(
        'SELECT payload FROM podium_events WHERE kind = ? AND subject = ? ORDER BY id DESC LIMIT ?',
      )
      .all(RUNTIME_EVENT_LOG_KIND, sessionId, limit) as { payload: unknown }[]
    const events: RuntimeEvent[] = []
    for (const row of rows.reverse()) {
      try {
        events.push(
          RuntimeEvent.parse(
            typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
          ),
        )
      } catch {}
    }
    return events
  }

  listRuntimeEventsAfter(afterId: number, limit = 128): RuntimeEventLogRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, subject, payload FROM podium_events WHERE kind = ? AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(RUNTIME_EVENT_LOG_KIND, afterId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: row.subject as SessionId,
      event: RuntimeEvent.parse(
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      ),
    }))
  }

  runtimeEventProjectionCursor(projector: string): number {
    const row = this.db
      .prepare('SELECT last_event_id FROM runtime_event_projection_cursors WHERE projector = ?')
      .get(projector) as { last_event_id?: unknown } | undefined
    return row ? Number(row.last_event_id) : 0
  }

  saveRuntimeEventProjectionCursor(projector: string, eventId: number, updatedAt: string): void {
    this.db
      .prepare(
        'INSERT INTO runtime_event_projection_cursors (projector, last_event_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(projector) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at WHERE excluded.last_event_id > runtime_event_projection_cursors.last_event_id',
      )
      .run(projector, eventId, updatedAt)
  }

  // ---- event log ----

  appendEvent(
    e: {
      ts: string
      kind: string
      subject: string
      repoPath?: string | null
      payload?: unknown
    },
    options: { announce?: boolean } = {},
  ): number {
    const r = this.db
      .prepare(
        'INSERT INTO podium_events (ts, kind, subject, repo_path, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.ts, e.kind, e.subject, e.repoPath ?? null, JSON.stringify(e.payload ?? {}))
    const id = Number(r.lastInsertRowid)
    // AFTER the insert, never before: the feed must not carry a row the log does
    // not have. The listener is documented as non-throwing, and this call is not
    // guarded here on purpose — a swallow at both ends hides a wiring fault
    // behind a pane that simply never updates.
    if (options.announce !== false) {
      this.appendListener?.(id, {
        ts: e.ts,
        kind: e.kind,
        subject: e.subject,
        repoPath: e.repoPath ?? null,
        payload: e.payload ?? {},
      })
    }
    return id
  }

  /** Announce an event that was inserted silently inside a wider transaction.
   * The caller invokes this only after that transaction commits. */
  announceEvent(id: number): void {
    if (!this.appendListener) return
    const row = this.db.prepare('SELECT * FROM podium_events WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) throw new Error(`unknown podium event ${id}`)
    const event = rowToEvent(row)
    this.appendListener(id, {
      ts: event.ts,
      kind: event.kind,
      subject: event.subject,
      repoPath: event.repoPath,
      payload: event.payload,
    })
  }

  /**
   * Cursor read over the event log, ascending from `sinceId`.
   *
   * `subject` narrows to one subject's events IN SQL (POD-532). It exists so a
   * per-issue activity feed can ask for that issue instead of draining the
   * repo-wide log and filtering in the browser — the old shape both shipped
   * thousands of irrelevant rows over the wire and lost any issue whose events
   * fell outside the newest page. `idx_podium_events_subject` makes the narrowed
   * read a search rather than a table walk.
   */
  listEventsSince(
    sinceId: number,
    opts?: { kinds?: string[]; repoPath?: string; subject?: string; limit?: number },
  ): PodiumEventRecord[] {
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
    if (opts?.subject) {
      where.push('subject = ?')
      params.push(opts.subject)
    }
    params.push(opts?.limit ?? ISSUE_EVENTS_DEFAULT_LIMIT)
    const rows = this.db
      .prepare(`SELECT * FROM podium_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map(rowToEvent)
  }

  /**
   * One event kind over a time window, plus the last row before the window.
   *
   * A step-function reader needs the prior row to know the value carried into
   * its first bucket. Keeping that lookup here avoids teaching feature modules
   * about the event table's JSON column or ordering tie-breaker.
   */
  listKindSinceWithPrior(kind: string, since: string): PodiumEventRecord[] {
    const prior = this.db
      .prepare(
        `SELECT * FROM podium_events
         WHERE kind = ? AND ts < ?
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(kind, since) as Record<string, unknown> | undefined
    const rows = this.db
      .prepare(
        `SELECT * FROM podium_events
         WHERE kind = ? AND ts >= ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(kind, since) as Record<string, unknown>[]
    return [...(prior ? [rowToEvent(prior)] : []), ...rows.map(rowToEvent)]
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
  planEventPrune(opts: { maxAgeDays: number; maxRows: number }): EventPrunePlan {
    if (!Number.isInteger(opts.maxRows) || opts.maxRows < 0) {
      throw new RangeError('maxRows must be a non-negative integer')
    }

    // ts is an ISO-8601 string, so lexicographic comparison == chronological.
    const cutoff = new Date(Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    // Compute the cap threshold once per job. Repeating this OFFSET scan before
    // every delete unit made a 50k-row retention pass itself monopolize the loop.
    // Rows appended after this snapshot are intentionally handled by the next pass.
    const cap = this.db
      .prepare('SELECT id FROM podium_events ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(opts.maxRows) as { id: number } | undefined
    return { cutoff, capThroughId: cap?.id ?? 0 }
  }

  /** [spec:SP-c29e] One bounded synchronous DELETE unit from a fixed plan. */
  pruneEventBatch(plan: EventPrunePlan, batchSize = 500): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    const result = this.db
      .prepare(
        `DELETE FROM podium_events
         WHERE id IN (
           SELECT id FROM podium_events
           WHERE (ts < ? OR id <= ?)
             AND NOT (
               kind = 'session.runtime'
               AND id > COALESCE(
                 (SELECT last_event_id FROM runtime_event_projection_cursors WHERE projector = 'runtime.board.v1'),
                 0
               )
             )
           ORDER BY id ASC
           LIMIT ?
         )`,
      )
      .run(plan.cutoff, plan.capThroughId, batchSize)
    return Number(result.changes)
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
