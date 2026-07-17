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
    readAt: (r.read_at as string | null) ?? null,
    injectedAt: (r.injected_at as string | null) ?? null,
    deadLetteredAt: (r.dead_lettered_at as string | null) ?? null,
    ackedBy: (r.acked_by as string | null) ?? null,
    hop: (r.hop as number | null) ?? 0,
    clampedFrom: (r.clamped_from as string | null) ?? null,
    remindedAt: (r.reminded_at as string | null) ?? null,
    factKey: (r.fact_key as string | null) ?? null,
    factTarget: (r.fact_target as string | null) ?? null,
    expectsResponse: Boolean(r.expects_response),
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
            created_at, status, delivered_at, delivered_to, acked_by, hop, clamped_from,
            expects_response, fact_key, fact_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        m.expectsResponse ? 1 : 0,
        m.factKey ?? null,
        m.factTarget ?? null,
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

  /** Record a PUSH toward a live PTY without claiming the agent saw it [POD-834]:
   *  stamps injected_at + delivered_to but keeps status='queued'. This replaces
   *  the old "mark delivered on enqueue" lie — `delivered` is now reserved for a
   *  transcript echo. A queued row that was injected but never echoed within the
   *  window is auto-requeued (clearInjected). Guarded on status='queued'. */
  markInjected(id: string, deliveredTo: string | null, injectedAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET injected_at = ?, delivered_to = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(injectedAt, deliveredTo, id)
    return r.changes === 1
  }

  /** queued → delivered: the PUSH is CONFIRMED — the message's envelope appeared
   *  as a turn in the target's transcript (transcript echo, [POD-834]). Only now
   *  does the ledger claim the agent has it in context. Guarded on status so a
   *  duplicate/late echo is a no-op (returns false). */
  markDelivered(id: string, deliveredTo: string | null, deliveredAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET status = 'delivered', delivered_at = ?, delivered_to = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(deliveredAt, deliveredTo, id)
    return r.changes === 1
  }

  /** queued|delivered → read: the recipient opened its inbox and consumed it (the
   *  PULL path, [POD-834]). Distinct from delivered (push): `read` proves the
   *  agent pulled it. A delivered row can still be marked read if later pulled. */
  markRead(id: string, deliveredTo: string | null, readAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET status = 'read', read_at = ?, delivered_to = COALESCE(delivered_to, ?)
         WHERE id = ? AND status IN ('queued','delivered')`,
      )
      .run(readAt, deliveredTo, id)
    return r.changes === 1
  }

  /** queued → dead_letter: the target was gone before the message could land
   *  (issue closed/archived, session deleted with nowhere to re-route) [POD-834].
   *  Terminal; the sender is told once. Guarded on status='queued'. */
  markDeadLetter(id: string, at: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET status = 'dead_letter', dead_lettered_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(at, id)
    return r.changes === 1
  }

  /** Auto-requeue seam [POD-834]: a queued row was injected but no echo confirmed
   *  it within the window — the push was lost. Clear injected_at so the next
   *  delivery attempt re-pushes. Guarded on status='queued' so a row that raced to
   *  delivered/read in the meantime is left alone. */
  clearInjected(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE messages SET injected_at = NULL WHERE id = ? AND status = 'queued'`)
      .run(id)
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
    this.db.prepare(`UPDATE messages SET status = 'expired' WHERE ${where}`).run(now, cutoff)
    return rows.map(mapMessage).map((m) => ({ ...m, status: 'expired' as const }))
  }

  /** Stamp the ack message id onto the original (first ack wins). */
  markAcked(id: string, ackedBy: string): boolean {
    const r = this.db
      .prepare('UPDATE messages SET acked_by = ? WHERE id = ? AND acked_by IS NULL')
      .run(ackedBy, id)
    return r.changes === 1
  }

  /** Delivered-to-`sessionId`, unfulfilled, unexpired rows that REQUESTED a
   *  response [POD-835 §04b] — `expects_response = 1` is the sole gate (a
   *  `--expect-response` send or a `question`); an ordinary message owes no reply,
   *  so receipt alone never lands here. `acked_by IS NULL` is the unfulfilled test:
   *  it is stamped by any in-thread reply (semantic-reply-as-ack), not just a
   *  `kind:'ack'`. The stop-hook reminder and the steward's deterministic fallback
   *  both read this set (#237) [spec:SP-34d7 acks]. */
  listDeliveredUnacked(sessionId: string, now: string): MessageRow[] {
    const rows = this.db
      .prepare(
        // The agent has it either way — pushed (delivered) or pulled (read).
        `SELECT * FROM messages
         WHERE status IN ('delivered','read') AND delivered_to = ? AND acked_by IS NULL
           AND expects_response = 1
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, now) as Record<string, unknown>[]
    return rows.map(mapMessage)
  }

  /** The steward settle-fallback set (#468, [spec:SP-bf44] [POD-835 §04b]): delivered,
   *  unfulfilled, unexpired rows for `sessionId` that (a) REQUESTED a response — `expects_response
   *  = 1`, the opt-in flag; an ordinary message (even next-turn) owes no reply and
   *  never nags, killing the 49% ack traffic — and (b) have not already produced a
   *  settle notice. `acked_by` is the fulfilment marker, stamped by ANY in-thread
   *  reply (semantic-reply-as-ack), so a thorough reply clears the nag; the false
   *  "finished without acking" notices are gone. The once-guard is structural: a
   *  settle notice is a `notification` row whose `in_reply_to` is the original, so
   *  "already notified" == such a row exists. No column needed; the notice itself is
   *  the marker. This is why the notice fires at most ONCE per requested response. */
  listSettleNotifiable(sessionId: string, now: string): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages m
         WHERE m.status IN ('delivered','read') AND m.delivered_to = ? AND m.acked_by IS NULL
           AND m.expects_response = 1
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
