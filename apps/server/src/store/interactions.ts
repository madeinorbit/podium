/**
 * The PendingInteraction store (POD-2020, spec §4) — durable rows for every
 * blocking ask, so a blocked session is an ENUMERABLE session.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEDUPE LIVES IN SQL AND NOT IN THE SERVICE
 * ---------------------------------------------------------------------------
 * The at-least-once obligation on classifier-sourced asks (spec §4: "a
 * re-rendered menu can mint a duplicate ask") is collapsed by a PARTIAL UNIQUE
 * INDEX on `(session_id, fingerprint) WHERE status = 'asked'`, and the insert
 * below is `ON CONFLICT DO NOTHING` against it. A read-then-write in the service
 * would be the same check with a race in the middle, and the racing writers are
 * real: two observations of one menu arrive from the same daemon microseconds
 * apart. The index decides once.
 *
 * The index is deliberately scoped to OPEN rows. The same question asked again
 * after the first was answered is a genuinely new ask — a session that runs for
 * hours will hit the same permission prompt repeatedly and each one needs its
 * own answer. A total unique index would swallow every one after the first.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS DELETED ON RESOLUTION
 * ---------------------------------------------------------------------------
 * An answered interaction is the audit trail for a decision a headless run made
 * without a human, which is the property the whole aggregate is here to
 * provide. Rows are trimmed by age, never by status.
 */

import type { SessionId } from '@podium/model'
import type {
  InteractionAnswer,
  InteractionAnsweredBy,
  InteractionKind,
  InteractionSource,
  InteractionStatus,
  PendingInteractionWire,
} from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** One stored ask. The JSON columns are parsed on the way out, so callers get
 *  the wire shape and never a string. */
export interface InteractionRow {
  id: string
  sessionId: SessionId
  kind: InteractionKind
  payload: unknown
  source: InteractionSource
  answerable: PendingInteractionWire['answerable']
  fingerprint: string
  status: InteractionStatus
  policyVerdict: PendingInteractionWire['policyVerdict']
  askedAt: string
  expiresAt: string | null
  answeredAt: string | null
  answeredBy: InteractionAnsweredBy | null
  answer: InteractionAnswer | null
  deliveredVia: NonNullable<PendingInteractionWire['deliveredVia']> | null
  expiredAt: string | null
}

export interface InteractionInsert {
  id: string
  sessionId: SessionId
  kind: InteractionKind
  payload: unknown
  source: InteractionSource
  answerable: PendingInteractionWire['answerable']
  fingerprint: string
  askedAt: string
  expiresAt?: string
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    // A payload we cannot parse is a row we cannot render, but it is still a row
    // whose EXISTENCE says a session is blocked — which is the part that keeps
    // somebody from waiting forever. Surfacing it with a null payload beats
    // dropping it.
    return null
  }
}

function toRow(r: Record<string, unknown>): InteractionRow {
  return {
    id: r.id as string,
    // SERIALIZATION EDGE: an untyped sqlite column re-entering its id space.
    sessionId: r.session_id as SessionId,
    kind: r.kind as InteractionKind,
    payload: parseJson(r.payload_json),
    source: r.source as InteractionSource,
    answerable: r.answerable as PendingInteractionWire['answerable'],
    fingerprint: r.fingerprint as string,
    status: r.status as InteractionStatus,
    policyVerdict: (r.policy_verdict as PendingInteractionWire['policyVerdict']) ?? undefined,
    askedAt: r.asked_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    answeredAt: (r.answered_at as string | null) ?? null,
    answeredBy: (r.answered_by as InteractionAnsweredBy | null) ?? null,
    answer: parseJson(r.answer_json) as InteractionAnswer | null,
    deliveredVia:
      (r.delivered_via as NonNullable<PendingInteractionWire['deliveredVia']> | null) ?? null,
    expiredAt: (r.expired_at as string | null) ?? null,
  }
}

export class InteractionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Record an ask. Returns the row that is now open for this fingerprint —
   * either the freshly inserted one or the existing duplicate.
   *
   * `inserted` is what the caller needs to decide whether to publish an `asked`
   * event: a collapsed duplicate must NOT re-announce, or every re-render of a
   * classified menu would ping every surface again.
   */
  insert(row: InteractionInsert): { row: InteractionRow; inserted: boolean } {
    const res = this.db
      .prepare(
        `INSERT INTO pending_interactions
           (id, session_id, kind, payload_json, source, answerable, fingerprint,
            status, asked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'asked', ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        row.id,
        row.sessionId,
        row.kind,
        JSON.stringify(row.payload),
        row.source,
        row.answerable,
        row.fingerprint,
        row.askedAt,
        row.expiresAt ?? null,
      )
    if (res.changes > 0) {
      const inserted = this.get(row.id)
      if (inserted) return { row: inserted, inserted: true }
    }
    const open = this.openByFingerprint(row.sessionId, row.fingerprint)
    if (open) return { row: open, inserted: false }
    // Neither inserted nor found: the conflicting row was resolved between the
    // two statements. Retry once — now there is nothing to conflict with.
    const retried = this.insert(row)
    return retried
  }

  get(id: string): InteractionRow | null {
    const r = this.db.prepare(`SELECT * FROM pending_interactions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return r ? toRow(r) : null
  }

  openByFingerprint(sessionId: SessionId, fingerprint: string): InteractionRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM pending_interactions
         WHERE session_id = ? AND fingerprint = ? AND status = 'asked'`,
      )
      .get(sessionId, fingerprint) as Record<string, unknown> | undefined
    return r ? toRow(r) : null
  }

  /** Every open ask, oldest first — the enumeration §4 promises. */
  listOpen(sessionId?: SessionId): InteractionRow[] {
    const rows = sessionId
      ? this.db
          .prepare(
            `SELECT * FROM pending_interactions
             WHERE status = 'asked' AND session_id = ? ORDER BY asked_at, id`,
          )
          .all(sessionId)
      : this.db
          .prepare(
            `SELECT * FROM pending_interactions WHERE status = 'asked' ORDER BY asked_at, id`,
          )
          .all()
    return (rows as Record<string, unknown>[]).map(toRow)
  }

  listForSession(sessionId: SessionId, limit = 100): InteractionRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pending_interactions
           WHERE session_id = ? ORDER BY asked_at DESC, id DESC LIMIT ?`,
        )
        .all(sessionId, limit) as Record<string, unknown>[]
    ).map(toRow)
  }

  /**
   * Resolve an open ask. Returns false when the row was not open — which is how
   * a second answer becomes a typed `already-answered` rather than a second
   * delivery. The `WHERE status = 'asked'` is the whole idempotency guarantee:
   * two concurrent answers race here and exactly one wins.
   */
  answer(input: {
    id: string
    answer: InteractionAnswer
    answeredBy: InteractionAnsweredBy
    deliveredVia: NonNullable<PendingInteractionWire['deliveredVia']>
    at: string
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE pending_interactions
         SET status = 'answered', answer_json = ?, answered_by = ?, delivered_via = ?, answered_at = ?
         WHERE id = ? AND status = 'asked'`,
      )
      .run(JSON.stringify(input.answer), input.answeredBy, input.deliveredVia, input.at, input.id)
    return res.changes > 0
  }

  /**
   * Record how the answer actually reached the agent, AFTER the row was claimed.
   *
   * A separate statement from {@link answer} because that one guards on
   * `status = 'asked'` — that guard IS the idempotency claim — and the row is
   * already `answered` by the time delivery reports. Reusing `answer` here
   * silently updated nothing, and left every successfully delivered answer
   * recorded as `unverified`.
   *
   * Guarded on `status = 'answered'` so a late delivery report cannot resurrect
   * a row that expired underneath it.
   */
  recordDelivery(
    id: string,
    deliveredVia: NonNullable<PendingInteractionWire['deliveredVia']>,
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE pending_interactions SET delivered_via = ?
         WHERE id = ? AND status = 'answered'`,
      )
      .run(deliveredVia, id)
    return res.changes > 0
  }

  /**
   * Close an open ask without answering it. NOT a decision — see
   * `InteractionStatus`.
   *
   * `expired` means the SESSION went away and took the menu with it;
   * `superseded` means the session moved on, whose usual cause is a person
   * answering at the terminal. Both share the `expired_at` column: it is the
   * moment the row stopped being open, and a second timestamp column that only
   * ever holds the same instant under a different name is a field somebody has
   * to keep in step for nothing.
   */
  close(id: string, status: 'expired' | 'superseded', at: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE pending_interactions SET status = ?, expired_at = ?
         WHERE id = ? AND status = 'asked'`,
      )
      .run(status, at, id)
    return res.changes > 0
  }

  /** Every open ask on a session closes at once. Returns the ids that moved. */
  closeSession(sessionId: SessionId, status: 'expired' | 'superseded', at: string): string[] {
    const open = this.listOpen(sessionId)
    if (open.length === 0) return []
    this.db
      .prepare(
        `UPDATE pending_interactions SET status = ?, expired_at = ?
         WHERE session_id = ? AND status = 'asked'`,
      )
      .run(status, at, sessionId)
    return open.map((r) => r.id)
  }

  /** Retention: drop RESOLVED rows older than the cutoff. Open asks are never
   *  trimmed — an ask nobody answered is the one thing this table must not
   *  forget. */
  pruneResolvedBefore(cutoffIso: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM pending_interactions
         WHERE status != 'asked' AND COALESCE(answered_at, expired_at, asked_at) < ?`,
      )
      .run(cutoffIso)
    return Number(res.changes)
  }
}
