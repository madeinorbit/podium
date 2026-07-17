/**
 * Messages aggregate — owns the unified `messages` table (#237)
 * [spec:SP-34d7]: one durable row per inter-agent / superagent / system / UI
 * message, with the delivery ledger as columns on the row.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { MessageRow, MessageStatus, MessageToKind } from './types'

/** A message recipient principal: `issue`/`session` carry an id; `operator` has none. */
export interface MessagePrincipalRef {
  kind: MessageToKind
  id?: string | null
}

function mapMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    inReplyTo: (r.in_reply_to as string | null) ?? null,
    fromKind: r.from_kind as MessageRow['fromKind'],
    fromSession: (r.from_session as string | null) ?? null,
    ...(r.from_name !== null && r.from_name !== undefined
      ? { fromName: r.from_name as string }
      : {}),
    fromIssue: (r.from_issue as string | null) ?? null,
    toKind: r.to_kind as MessageRow['toKind'],
    toId: (r.to_id as string | null) ?? null,
    kind: r.kind as MessageRow['kind'],
    urgency: r.urgency as MessageRow['urgency'],
    lifecycle: r.lifecycle as MessageRow['lifecycle'],
    body: r.body as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: r.created_at as string,
    status: r.status as MessageStatus,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    deliveredTo: (r.delivered_to as string | null) ?? null,
    ackedBy: (r.acked_by as string | null) ?? null,
    hop: (r.hop as number | null) ?? 0,
    clampedFrom: (r.clamped_from as string | null) ?? null,
    remindedAt: (r.reminded_at as string | null) ?? null,
  }
}

export class MessagesRepository {
  constructor(private readonly db: SqlDatabase) {}

  addMessage(m: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, thread_id, in_reply_to, from_kind, from_session, from_name, from_issue,
            to_kind, to_id, kind, urgency, lifecycle, body, expires_at,
            created_at, status, delivered_at, delivered_to, acked_by, hop, clamped_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.threadId,
        m.inReplyTo,
        m.fromKind,
        m.fromSession,
        m.fromName ?? null,
        m.fromIssue,
        m.toKind,
        m.toId,
        m.kind,
        m.urgency,
        m.lifecycle,
        m.body,
        m.expiresAt,
        m.createdAt,
        m.status,
        m.deliveredAt,
        m.deliveredTo,
        m.ackedBy,
        m.hop,
        m.clampedFrom,
      )
  }

  getMessage(id: string): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? mapMessage(r) : null
  }

  /** All messages addressed to a principal, oldest first. */
  listMessagesFor(
    to: MessagePrincipalRef,
    opts?: { status?: MessageStatus; limit?: number },
  ): MessageRow[] {
    const where = ['to_kind = ?']
    const params: unknown[] = [to.kind]
    if (to.kind !== 'operator') {
      where.push('to_id = ?')
      params.push(to.id ?? null)
    }
    if (opts?.status) {
      where.push('status = ?')
      params.push(opts.status)
    }
    params.push(Math.min(500, Math.max(1, opts?.limit ?? 200)))
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where.join(' AND ')}
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** The delivery ledger for one issue or session (#237) [spec:SP-34d7 web]:
   *  every row the principal SENT or was ADDRESSED (issue box / session box /
   *  delivered-to), newest first — the "what happened to my message" view. */
  listLedger(q: { issueId?: string; sessionId?: string; limit?: number }): MessageRow[] {
    const ors: string[] = []
    const params: unknown[] = []
    if (q.issueId) {
      ors.push('from_issue = ?', "(to_kind = 'issue' AND to_id = ?)")
      params.push(q.issueId, q.issueId)
    }
    if (q.sessionId) {
      ors.push('from_session = ?', "(to_kind = 'session' AND to_id = ?)", 'delivered_to = ?')
      params.push(q.sessionId, q.sessionId, q.sessionId)
    }
    if (ors.length === 0) return []
    params.push(Math.min(500, Math.max(1, q.limit ?? 200)))
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE ${ors.join(' OR ')}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** Undelivered (queued) messages awaiting a principal, oldest first. */
  pendingFor(to: MessagePrincipalRef): MessageRow[] {
    return this.listMessagesFor(to, { status: 'queued' })
  }

  countPending(to: MessagePrincipalRef): number {
    const params: unknown[] = to.kind === 'operator' ? [to.kind] : [to.kind, to.id ?? null]
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE to_kind = ?${to.kind === 'operator' ? '' : ' AND to_id = ?'} AND status = 'queued'`,
      )
      .get(...(params as never[])) as { n: number }
    return r.n
  }

  /** queued → delivered, recording when and which session received it. Guarded
   *  on status so a duplicate delivery attempt is a no-op (returns false). */
  markDelivered(id: string, deliveredTo: string | null, deliveredAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET status = 'delivered', delivered_at = ?, delivered_to = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(deliveredAt, deliveredTo, id)
    return r.changes === 1
  }

  /** Every queued (undelivered) row, oldest first — the slow sweep's retry set. */
  listQueued(limit = 500): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE status = 'queued'
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(Math.min(2000, Math.max(1, limit))) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** Wake-lifecycle rows attempted since `sinceIso` (delivered_at, falling
   *  back to created_at for still-queued attempts) — restart-proof backing for
   *  the wake-cooldown brake (#237) [spec:SP-34d7 brakes]. */
  listRecentWakes(sinceIso: string): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE lifecycle = 'wake' AND COALESCE(delivered_at, created_at) >= ?
         ORDER BY created_at ASC, id ASC LIMIT 500`,
      )
      .all(sinceIso) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** Expire queued rows whose expires_at has passed; returns the expired rows.
   *  `waitImplicitCutoff` [POD-817] additionally expires wait-lifecycle rows
   *  with NO explicit expires_at created at or before the cutoff — the policy
   *  (TTL) lives with the caller; an explicit expires_at always wins. */
  expireQueued(now: string, opts?: { waitImplicitCutoff?: string }): MessageRow[] {
    const cutoff = opts?.waitImplicitCutoff ?? null
    const where = `status = 'queued' AND (
           (expires_at IS NOT NULL AND expires_at <= ?1)
           OR (?2 IS NOT NULL AND expires_at IS NULL AND lifecycle = 'wait' AND created_at <= ?2)
         )`
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE ${where}`)
      .all(now, cutoff) as Record<string, unknown>[]
    if (rows.length === 0) return []
    this.db
      .prepare(`UPDATE messages SET status = 'expired' WHERE ${where}`)
      .run(now, cutoff)
    return rows.map(mapMessage).map((m) => ({ ...m, status: 'expired' as const }))
  }

  /** Stamp the ack message id onto the original (first ack wins). */
  markAcked(id: string, ackedBy: string): boolean {
    const r = this.db
      .prepare('UPDATE messages SET acked_by = ? WHERE id = ? AND acked_by IS NULL')
      .run(ackedBy, id)
    return r.changes === 1
  }

  /** Delivered-to-`sessionId`, unacked, unexpired rows that still expect an ack
   *  (kinds message/question — acks and notifications never expect one). The
   *  stop-hook reminder and the steward's deterministic fallback both read this
   *  set (#237) [spec:SP-34d7 acks]. */
  listDeliveredUnacked(sessionId: string, now: string): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE status = 'delivered' AND delivered_to = ? AND acked_by IS NULL
           AND kind IN ('message','question')
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, now) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** The steward settle-fallback set (#468) [spec:SP-34d7 acks]: delivered,
   *  unacked, unexpired rows for `sessionId` that (a) actually asked for something
   *  — a `question`, or a non-`fyi` message; a `fyi` is a courtesy note and never
   *  demands an ack — and (b) have not already produced a settle notice. The
   *  once-guard is structural: a settle notice is a `notification` row whose
   *  `in_reply_to` is the original, so "already notified" == such a row exists.
   *  No column needed; the notice itself is the marker. This is why the notice
   *  fires at most ONCE per message instead of on every settle. */
  listSettleNotifiable(sessionId: string, now: string): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages m
         WHERE m.status = 'delivered' AND m.delivered_to = ? AND m.acked_by IS NULL
           AND m.kind IN ('message','question')
           AND NOT (m.kind = 'message' AND m.urgency = 'fyi')
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND NOT EXISTS (
             SELECT 1 FROM messages n
             WHERE n.kind = 'notification' AND n.in_reply_to = m.id
           )
         ORDER BY m.created_at ASC, m.id ASC`,
      )
      .all(sessionId, now) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** Stamp the ONE stop-hook reminder (never repeats: guarded on NULL). */
  markReminded(id: string, at: string): boolean {
    const r = this.db
      .prepare('UPDATE messages SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL')
      .run(at, id)
    return r.changes === 1
  }
}
