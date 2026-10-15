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
import {
  type InteractionAnswer,
  type InteractionAnsweredBy,
  type InteractionKind,
  type InteractionSource,
  InteractionStatus,
  type PendingInteractionWire,
} from '@podium/protocol'
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { pendingInteractions } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

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

/**
 * WHAT STILL NEEDS MAPPING [spec §6 rules 3, 4 and 6].
 *
 * Drizzle returns the schema's TypeScript names and the `SessionId` brand, so
 * the per-column decode is gone. Two things are decisions and stay:
 *
 *   THE JSON COLUMNS QUARANTINE. `payload_json` and `answer_json` are plain
 *   `text()` and NOT `mode: 'json'`, deliberately: a payload we cannot parse is
 *   a row we cannot render, but its EXISTENCE still says a session is blocked,
 *   which is the part that keeps somebody from waiting forever. `mode: 'json'`
 *   would throw and drop the row instead (spec §6 rule 4).
 *
 *   `policyVerdict` reads a NULL column as `undefined`, not `null`, because the
 *   wire type has it optional. The other nullable columns stay null.
 *
 * The remaining lines narrow CHECK-constrained text onto the domain's unions,
 * which is the database enforcing the invariant (spec §6 rule 5).
 */
type InteractionSelect = typeof pendingInteractions.$inferSelect

function toRow(r: InteractionSelect): InteractionRow {
  return {
    id: r.id,
    sessionId: r.sessionId,
    kind: r.kind as InteractionKind,
    payload: parseJson(r.payloadJson),
    source: r.source as InteractionSource,
    answerable: r.answerable as PendingInteractionWire['answerable'],
    fingerprint: r.fingerprint,
    status: r.status as InteractionStatus,
    policyVerdict: (r.policyVerdict as PendingInteractionWire['policyVerdict']) ?? undefined,
    askedAt: r.askedAt,
    expiresAt: r.expiresAt,
    answeredAt: r.answeredAt,
    answeredBy: r.answeredBy as InteractionAnsweredBy | null,
    answer: parseJson(r.answerJson) as InteractionAnswer | null,
    deliveredVia: r.deliveredVia as NonNullable<PendingInteractionWire['deliveredVia']> | null,
    expiredAt: r.expiredAt,
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const t = pendingInteractions
const idIs = () => eq(t.id, param(t.id, 'id'))

const insertInteraction = prepared((db: StoreDrizzle) =>
  db
    .insert(t)
    .values({
      id: sql.placeholder('id'),
      sessionId: sql.placeholder('sessionId'),
      kind: sql.placeholder('kind'),
      payloadJson: sql.placeholder('payloadJson'),
      source: sql.placeholder('source'),
      answerable: sql.placeholder('answerable'),
      fingerprint: sql.placeholder('fingerprint'),
      status: 'asked',
      askedAt: sql.placeholder('askedAt'),
      expiresAt: sql.placeholder('expiresAt'),
    })
    // NO TARGET, exactly as the raw form had none: the conflict this collapses
    // is the PARTIAL unique index on (session_id, fingerprint) WHERE status =
    // 'asked', which is not a target drizzle can name.
    .onConflictDoNothing()
    .prepare(),
)

const enrichInteraction = prepared((db: StoreDrizzle) =>
  db.update(t).set({ payloadJson: sql.placeholder('payloadJson') })
    .where(and(idIs(), eq(t.status, 'asked'))).prepare(),
)

const interactionById = prepared((db: StoreDrizzle) => db.select().from(t).where(idIs()).prepare())

const openInteractionByFingerprint = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(t)
    .where(
      and(
        eq(t.sessionId, param(t.sessionId, 'sessionId')),
        eq(t.fingerprint, param(t.fingerprint, 'fingerprint')),
        // OPEN ROWS ONLY, which is what makes the same question asked again
        // after the first was answered a genuinely new ask.
        eq(t.status, 'asked'),
      ),
    )
    .prepare(),
)

/** Every open ask, or one session's: two statement texts, as the fluent form had. */
const openInteractions = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(t)
    .where(and(eq(t.status, 'asked'), undefined))
    .orderBy(asc(t.askedAt), asc(t.id))
    .prepare(),
)

const openInteractionsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(t)
    .where(and(eq(t.status, 'asked'), eq(t.sessionId, param(t.sessionId, 'sessionId'))))
    .orderBy(asc(t.askedAt), asc(t.id))
    .prepare(),
)

const interactionsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(t)
    .where(eq(t.sessionId, param(t.sessionId, 'sessionId')))
    .orderBy(desc(t.askedAt), desc(t.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const answerInteraction = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({
      status: 'answered',
      answerJson: sql.placeholder('answerJson'),
      answeredBy: sql.placeholder('answeredBy'),
      deliveredVia: sql.placeholder('deliveredVia'),
      answeredAt: sql.placeholder('answeredAt'),
    })
    .where(and(idIs(), eq(t.status, 'asked')))
    .prepare(),
)

const recordInteractionDelivery = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({ deliveredVia: sql.placeholder('deliveredVia') })
    .where(and(idIs(), eq(t.status, 'answered')))
    .prepare(),
)

const answeredBy = () => eq(t.answeredBy, param(t.answeredBy, 'answeredBy'))

const reopenInteraction = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({
      status: 'asked',
      // FOUR CLEARS. A reopened ask that still carried its answer would be
      // back on the list and already answered at the same time.
      answerJson: null,
      answeredBy: null,
      deliveredVia: null,
      answeredAt: null,
      policyVerdict: 'escalated',
    })
    .where(and(idIs(), eq(t.status, 'answered'), answeredBy()))
    .prepare(),
)

const retireClaimedInteraction = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({ status: sql.placeholder('status'), expiredAt: sql.placeholder('at') })
    .where(and(idIs(), eq(t.status, 'answered'), answeredBy()))
    .prepare(),
)

const closeInteraction = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({ status: sql.placeholder('status'), expiredAt: sql.placeholder('at') })
    .where(and(idIs(), eq(t.status, 'asked')))
    .prepare(),
)

const closeSessionInteractions = prepared((db: StoreDrizzle) =>
  db
    .update(t)
    .set({ status: sql.placeholder('status'), expiredAt: sql.placeholder('at') })
    .where(and(eq(t.sessionId, param(t.sessionId, 'sessionId')), eq(t.status, 'asked')))
    .prepare(),
)

/** Every status but `asked`: the rows retention may drop. */
const RESOLVED_STATUSES = InteractionStatus.options.filter((status) => status !== 'asked')

const pruneResolvedInteractions = prepared((db: StoreDrizzle) =>
  db
    .delete(t)
    .where(
      and(
        inArray(t.status, RESOLVED_STATUSES),
        // What idx_pending_interactions_open seeks [POD-6173]. A row resolves
        // after it is asked, so a row resolved before the cutoff was asked
        // before it too: this takes nothing out of what the next clause
        // selects, and bounds the read to the resolved rows asked before the
        // cutoff. A row whose clocks stamped its ask after its resolution is
        // dropped once its ask passes the cutoff instead.
        lt(t.askedAt, param(t.askedAt, 'cutoffIso')),
        // The cutoff is compared against the RESOLUTION time, falling back to
        // the ask time only when a row has neither — not against asked_at.
        lt(
          sql`COALESCE(${t.answeredAt}, ${t.expiredAt}, ${t.askedAt})`,
          sql.placeholder('cutoffIso'),
        ),
      ),
    )
    .prepare(),
)

export class InteractionsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db() {
    return this.rootDb
  }

  /**
   * Record an ask. Returns the row that is now open for this fingerprint —
   * either the freshly inserted one or the existing duplicate.
   *
   * `inserted` is what the caller needs to decide whether to publish an `asked`
   * event: a collapsed duplicate must NOT re-announce, or every re-render of a
   * classified menu would ping every surface again.
   */
  async insert(row: InteractionInsert): Promise<{ row: InteractionRow; inserted: boolean }> {
    const res = await insertInteraction(this.db).run({
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      payloadJson: JSON.stringify(row.payload),
      source: row.source,
      answerable: row.answerable,
      fingerprint: row.fingerprint,
      askedAt: row.askedAt,
      expiresAt: row.expiresAt ?? null,
    })
    if (res.changes > 0) {
      const inserted = await this.get(row.id)
      if (inserted) return { row: inserted, inserted: true }
    }
    const existing = await this.get(row.id)
    if (existing) return { row: existing, inserted: false }
    const open = await this.openByFingerprint(row.sessionId, row.fingerprint)
    if (open) return { row: open, inserted: false }
    // Neither inserted nor found: the conflicting row was resolved between the
    // two statements. Retry once — now there is nothing to conflict with.
    const retried = await this.insert(row)
    return retried
  }

  async enrich(id: string, payload: unknown): Promise<void> {
    await enrichInteraction(this.db).run({ id, payloadJson: JSON.stringify(payload) })
  }

  async get(id: string): Promise<InteractionRow | null> {
    const r = await interactionById(this.db).get({ id })
    return r ? toRow(r) : null
  }

  async openByFingerprint(sessionId: SessionId, fingerprint: string): Promise<InteractionRow | null> {
    const r = await openInteractionByFingerprint(this.db).get({ sessionId, fingerprint })
    return r ? toRow(r) : null
  }

  /** Every open ask, oldest first — the enumeration §4 promises. */
  async listOpen(sessionId?: SessionId): Promise<InteractionRow[]> {
    const rows = sessionId
      ? await openInteractionsOfSession(this.db).all({ sessionId })
      : await openInteractions(this.db).all()
    return rows.map(toRow)
  }

  async listForSession(sessionId: SessionId, limit = 100): Promise<InteractionRow[]> {
    return (await interactionsOfSession(this.db).all({ sessionId, limit })).map(toRow)
  }

  /**
   * Resolve an open ask. Returns false when the row was not open — which is how
   * a second answer becomes a typed `already-answered` rather than a second
   * delivery. The `WHERE status = 'asked'` is the whole idempotency guarantee:
   * two concurrent answers race here and exactly one wins.
   */
  async answer(input: {
    id: string
    answer: InteractionAnswer
    answeredBy: InteractionAnsweredBy
    deliveredVia: NonNullable<PendingInteractionWire['deliveredVia']>
    at: string
  }): Promise<boolean> {
    const res = await answerInteraction(this.db).run({
      id: input.id,
      answerJson: JSON.stringify(input.answer),
      answeredBy: input.answeredBy,
      deliveredVia: input.deliveredVia,
      answeredAt: input.at,
    })
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
  async recordDelivery(
    id: string,
    deliveredVia: NonNullable<PendingInteractionWire['deliveredVia']>,
  ): Promise<boolean> {
    const res = await recordInteractionDelivery(this.db).run({ id, deliveredVia })
    return res.changes > 0
  }

  /**
   * PUT AN ANSWERED ROW BACK ON THE LIST — the escalation half of the policy
   * table (POD-2414, spec §4 "Who answers": policy, then triage, then a human).
   *
   * The default-answer table claims a row BEFORE it tries to deliver, and that
   * order is right for a human answer: claiming first is what stops two
   * concurrent answers from both typing at the same menu. For a POLICY answer
   * applied at ask time there is no such race — the row was minted microseconds
   * ago and nobody else holds it — and the order had the opposite effect: a
   * default that could not be delivered left the ask marked `answered`, out of
   * `listOpen` and off the feed, so a session stuck at a startup recovery prompt
   * became a session stuck with NOTHING on any surface saying so. That is the
   * exact bug the aggregate exists to prevent, produced by the aggregate.
   *
   * So an undeliverable policy answer reopens the row. `answeredBy` is a
   * parameter rather than a hardcoded `'policy'` because a second case earns
   * the same treatment (POD-2414 review, P1/4): a STRUCTURED delivery that came
   * back as a typed refusal is a PROVEN non-delivery — the driver told us the
   * request is still open on its side — which is categorically different from
   * a keystroke answer that merely could not be confirmed. The unprovable case
   * still stays resolved as `unverified`; only a proven one reopens.
   *
   * Guarded on `status = 'answered'` and on WHO answered, so a reopen aimed at
   * one class can never resurrect the other's row underneath it.
   *
   * Returns false when the row moved underneath us, which is the caller's cue
   * that somebody else settled it.
   */
  async reopen(id: string, answeredBy: InteractionAnsweredBy): Promise<boolean> {
    const res = await reopenInteraction(this.db).run({ id, answeredBy })
    return res.changes > 0
  }

  /**
   * RETIRE A ROW THIS FLOW ITSELF CLAIMED (POD-2414 re-verdict, P0/1).
   *
   * `answer()` claims the row BEFORE it delivers, so when the driver replies
   * that the request is `already-answered` or `expired`, the row is sitting in
   * `answered` — where {@link close} cannot reach it, since that one guards on
   * `asked` and rightly so. This is the narrow correction of a claim that turned
   * out to be answering something no longer there.
   *
   * Guarded on `answered_by` exactly like {@link reopen}, for the same reason: a
   * correction aimed at one class must never retire the other's row underneath
   * it. Returns false when the row moved first.
   */
  async retireClaimed(
    id: string,
    status: 'expired' | 'superseded',
    at: string,
    answeredBy: InteractionAnsweredBy,
  ): Promise<boolean> {
    const res = await retireClaimedInteraction(this.db).run({ id, status, at, answeredBy })
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
  async close(id: string, status: 'expired' | 'superseded', at: string): Promise<boolean> {
    const res = await closeInteraction(this.db).run({ id, status, at })
    return res.changes > 0
  }

  /** Every open ask on a session closes at once. Returns the ids that moved. */
  async closeSession(sessionId: SessionId, status: 'expired' | 'superseded', at: string): Promise<string[]> {
    const open = await this.listOpen(sessionId)
    if (open.length === 0) return []
    await closeSessionInteractions(this.db).run({ sessionId, status, at })
    return open.map((r) => r.id)
  }

  /** Retention: drop RESOLVED rows older than the cutoff. Open asks are never
   *  trimmed — an ask nobody answered is the one thing this table must not
   *  forget. */
  async pruneResolvedBefore(cutoffIso: string): Promise<number> {
    const res = await pruneResolvedInteractions(this.db).run({ cutoffIso })
    return Number(res.changes)
  }
}
