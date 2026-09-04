/**
 * Messages aggregate — owns the unified `messages` table (#237)
 * [spec:SP-34d7]: one durable row per inter-agent / superagent / system / UI
 * message, with the delivery ledger as columns on the row.
 */

import {
  type ActorRef,
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asSessionId,
  asUserId,
  type IssueId,
  type SessionId,
} from '@podium/model'
import { type QueueDrainAbandonedReason, RuntimeAttachmentRef } from '@podium/protocol/daemon'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import {
  messageReads,
  messages as messagesTable,
  messageWakeCooldowns,
  sessions as sessionsTable,
} from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'
import type { MessageRow, MessageStatus, MessageToKind } from './types'

/** A message recipient principal: `issue`/`session` carry an id; `operator` has none. */
export interface MessagePrincipalRef {
  kind: MessageToKind
  id?: string | null
}

/** Stable keyset cursor for bounded queued-message scans. */
export interface MessagePageCursor {
  createdAt: string
  id: string
}

export interface PendingMessageSender {
  fromKind: MessageRow['fromKind']
  fromIssue: string | null
  fromSession: string | null
}

export interface PendingMessageSummary {
  count: number
  senders: PendingMessageSender[]
}

/** One `messages` row as the schema types it, before mapping. */
type MessageSelect = typeof messagesTable.$inferSelect

function storedActor(r: MessageSelect): ActorRef | null {
  const kind = r.actorKind
  const id = r.actorId
  if (!kind || !id) return null
  if (kind === 'user') return actorUser(asUserId(id))
  if (kind === 'agent') return actorAgent(asAgentIdentityId(id))
  return actorSystem(id)
}

function storedAttachments(value: unknown): MessageRow['attachments'] {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = RuntimeAttachmentRef.array().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function mapMessage(r: MessageSelect): MessageRow {
  const actor = storedActor(r)
  const attachments = storedAttachments(r.attachmentsJson)
  return {
    id: r.id,
    threadId: r.threadId,
    inReplyTo: r.inReplyTo ?? null,
    fromKind: r.fromKind as MessageRow['fromKind'],
    fromSession: (r.fromSession as SessionId | null) ?? null,
    ...(r.fromName !== null && r.fromName !== undefined ? { fromName: r.fromName } : {}),
    fromIssue: (r.fromIssue as IssueId | null) ?? null,
    ...(actor
      ? {
          attribution: {
            actor,
            onBehalfOf:
              r.onBehalfOf === null || r.onBehalfOf === undefined ? null : asUserId(r.onBehalfOf),
          },
        }
      : {}),
    delegationRef: r.delegationRef ?? null,
    toKind: r.toKind as MessageRow['toKind'],
    toId: r.toId ?? null,
    kind: r.kind as MessageRow['kind'],
    urgency: r.urgency as MessageRow['urgency'],
    lifecycle: r.lifecycle as MessageRow['lifecycle'],
    body: r.body,
    ...(attachments ? { attachments } : {}),
    expiresAt: r.expiresAt ?? null,
    createdAt: r.createdAt,
    status: r.status as MessageStatus,
    deliveredAt: r.deliveredAt ?? null,
    // SERIALIZATION EDGE: `delivered_to` carries no `$type` on the schema, so the
    // session id genuinely re-enters its brand space here.
    deliveredTo: (r.deliveredTo as SessionId | null) ?? null,
    readAt: r.readAt ?? null,
    injectedAt: r.injectedAt ?? null,
    deliveryDeferredAt: r.deliveryDeferredAt ?? null,
    deliveryDeferredReason:
      (r.deliveryDeferredReason as MessageRow['deliveryDeferredReason']) ?? null,
    deadLetteredAt: r.deadLetteredAt ?? null,
    ackedBy: r.ackedBy ?? null,
    hop: r.hop ?? 0,
    clampedFrom: r.clampedFrom ?? null,
    remindedAt: r.remindedAt ?? null,
    factKey: r.factKey ?? null,
    factTarget: r.factTarget ?? null,
    expectsResponse: r.expectsResponse,
  }
}

/**
 * ADDRESSED TO A PRINCIPAL. `operator` has no id, so the id clause is OMITTED
 * rather than bound to null — the two are different questions and a bound null
 * matches nothing. Declared once because seven readers ask it.
 */
function addressedTo(to: MessagePrincipalRef): SQL[] {
  const clauses: SQL[] = [eq(messagesTable.toKind, to.kind)]
  if (to.kind !== 'operator') {
    const id = to.id ?? null
    clauses.push(id === null ? isNull(messagesTable.toId) : eq(messagesTable.toId, id))
  }
  return clauses
}

/** The `(created_at, id)` delivery order every queued scan and cursor shares. */
const DELIVERY_ORDER = [asc(messagesTable.createdAt), asc(messagesTable.id)] as const

const boundedLimit = (limit: number | undefined, fallback: number, ceiling: number): number =>
  Math.min(ceiling, Math.max(1, limit ?? fallback))

export class MessagesRepository {
  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * This aggregate opens no span today, but both members are retained so adding
   * one later does not change constructor arity or the composition root.
   */
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line rather than 39 fields.
   */
  protected get db(): SyncDrizzle {
    return this.rootDb
  }

  addMessage(m: MessageRow): void {
    this.db
      .insert(messagesTable)
      .values({
        id: m.id,
        threadId: m.threadId,
        inReplyTo: m.inReplyTo,
        fromKind: m.fromKind,
        fromSession: m.fromSession,
        fromName: m.fromName ?? null,
        fromIssue: m.fromIssue,
        actorKind: m.attribution?.actor.kind ?? null,
        actorId:
          m.attribution?.actor.kind === 'user'
            ? m.attribution.actor.id
            : m.attribution?.actor.kind === 'agent'
              ? m.attribution.actor.id
              : m.attribution?.actor.kind === 'system'
                ? m.attribution.actor.job
                : null,
        onBehalfOf: m.attribution?.onBehalfOf ?? null,
        delegationRef: m.delegationRef ?? null,
        toKind: m.toKind,
        toId: m.toId,
        kind: m.kind,
        urgency: m.urgency,
        lifecycle: m.lifecycle,
        body: m.body,
        attachmentsJson: m.attachments?.length ? JSON.stringify(m.attachments) : null,
        expiresAt: m.expiresAt,
        createdAt: m.createdAt,
        status: m.status,
        deliveredAt: m.deliveredAt,
        deliveredTo: m.deliveredTo,
        ackedBy: m.ackedBy,
        hop: m.hop,
        clampedFrom: m.clampedFrom,
        expectsResponse: m.expectsResponse,
        factKey: m.factKey ?? null,
        factTarget: m.factTarget ?? null,
      })
      .run()
  }

  getMessage(id: string): MessageRow | null {
    const r = this.db.select().from(messagesTable).where(eq(messagesTable.id, id)).get()
    return r ? mapMessage(r) : null
  }

  /** All messages addressed to a principal, oldest first. */
  listMessagesFor(
    to: MessagePrincipalRef,
    opts?: { status?: MessageStatus; limit?: number },
  ): MessageRow[] {
    const where = addressedTo(to)
    if (opts?.status) where.push(eq(messagesTable.status, opts.status))
    return this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts?.limit, 200, 500))
      .all()
      .map(mapMessage)
  }

  /** Exact, unbounded safety projection of work still pending for one session. */
  pendingForSessionProof(sessionId: SessionId, now: string): MessageRow[] {
    return this.db
      .select()
      .from(messagesTable)
      .where(
        or(
          and(
            eq(messagesTable.status, 'queued'),
            or(
              and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, sessionId)),
              eq(messagesTable.deliveredTo, sessionId),
            ),
          ),
          and(
            inArray(messagesTable.status, ['delivered', 'read']),
            eq(messagesTable.deliveredTo, sessionId),
            isNull(messagesTable.ackedBy),
            eq(messagesTable.expectsResponse, true),
            or(isNull(messagesTable.expiresAt), gt(messagesTable.expiresAt, now)),
          ),
        ),
      )
      .orderBy(...DELIVERY_ORDER)
      .all()
      .map(mapMessage)
  }

  /** The delivery ledger for one issue or session (#237) [spec:SP-34d7 web]:
   *  every row the principal SENT or was ADDRESSED (issue box / session box /
   *  delivered-to), newest first — the "what happened to my message" view. */
  listLedger(q: { issueId?: IssueId; sessionId?: SessionId; limit?: number }): MessageRow[] {
    const ors: SQL[] = []
    if (q.issueId) {
      ors.push(
        eq(messagesTable.fromIssue, q.issueId),
        and(eq(messagesTable.toKind, 'issue'), eq(messagesTable.toId, q.issueId)) as SQL,
      )
    }
    if (q.sessionId) {
      ors.push(
        eq(messagesTable.fromSession, q.sessionId),
        and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, q.sessionId)) as SQL,
        eq(messagesTable.deliveredTo, q.sessionId),
      )
    }
    if (ors.length === 0) return []
    return this.db
      .select()
      .from(messagesTable)
      .where(or(...ors))
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(boundedLimit(q.limit, 200, 500))
      .all()
      .map(mapMessage)
  }

  /**
   * The current 1-based position of a queued message for one concrete session.
   * This is deliberately a read-time count, not a stored ordinal: earlier rows
   * leave the queue as soon as they are confirmed, so a receipt's enqueue-time
   * position is not an honest reload-time position.
   *
   * Rows can be waiting in either form used by the delivery service: addressed
   * directly to the session, or already injected toward it (`delivered_to`).
   * The SQL ordering is the same `(created_at, id)` ordering used by the ledger
   * and its high-water cursors.
   */
  queuedPositionForSession(sessionId: SessionId, messageId: string): number | undefined {
    const target = or(
      and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, sessionId)),
      eq(messagesTable.deliveredTo, sessionId),
    )
    const waiting = and(
      eq(messagesTable.status, 'queued'),
      isNull(messagesTable.injectedAt),
      target,
    )
    const row = this.db
      .select({ createdAt: messagesTable.createdAt, id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.id, messageId), waiting))
      .get()
    if (!row?.createdAt || !row.id) return undefined
    const ahead = this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(
        and(
          waiting,
          or(
            lt(messagesTable.createdAt, row.createdAt),
            and(eq(messagesTable.createdAt, row.createdAt), lte(messagesTable.id, row.id)),
          ),
        ),
      )
      .get()
    return Number(ahead?.n ?? 0)
  }

  /** One bounded keyset page of queued rows for a principal. */
  pendingForPage(
    to: MessagePrincipalRef,
    opts: { after?: MessagePageCursor; through?: MessagePageCursor; limit?: number } = {},
  ): MessageRow[] {
    const where = [...addressedTo(to), eq(messagesTable.status, 'queued')]
    if (opts.after) where.push(afterCursor(opts.after))
    if (opts.through) where.push(throughCursor(opts.through))
    return this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts.limit, 200, 500))
      .all()
      .map(mapMessage)
  }

  /** Last queued row in stable delivery order; captures a finite scan snapshot. */
  pendingHighWater(to: MessagePrincipalRef): MessagePageCursor | null {
    const row = this.db
      .select({ createdAt: messagesTable.createdAt, id: messagesTable.id })
      .from(messagesTable)
      .where(and(...addressedTo(to), eq(messagesTable.status, 'queued')))
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(1)
      .get()
    return row ? { createdAt: row.createdAt, id: row.id } : null
  }

  /** Most recently inserted operator chat send still held for one session.
   * `rowid` resolves sends accepted in the same clock tick; random message ids
   * do not encode creation order. */
  latestPendingOperatorForSession(sessionId: SessionId): MessageRow | undefined {
    const row = this.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.toKind, 'session'),
          eq(messagesTable.toId, sessionId),
          eq(messagesTable.fromKind, 'operator'),
          eq(messagesTable.status, 'queued'),
        ),
      )
      .orderBy(desc(messagesTable.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    return row ? mapMessage(row) : undefined
  }

  /** Complete queued-sender projection for nag/inbox aggregates. */
  listPendingSenders(to: MessagePrincipalRef): PendingMessageSender[] {
    return this.distinctSenders(and(...addressedTo(to), eq(messagesTable.status, 'queued')))
  }

  /** Count and group one queued slice in one statement for the inbox nag. */
  pendingSummary(to: MessagePrincipalRef): PendingMessageSummary {
    return this.pendingSummaryForPredicate(
      and(...addressedTo(to), eq(messagesTable.status, 'queued')),
    )
  }

  countQueued(): number {
    const row = this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(eq(messagesTable.status, 'queued'))
      .get()
    return Number(row?.n ?? 0)
  }

  countPending(to: MessagePrincipalRef): number {
    const row = this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(and(...addressedTo(to), eq(messagesTable.status, 'queued')))
      .get()
    return Number(row?.n ?? 0)
  }

  // ---- PER-READER state [POD-1379] [spec:SP-b11e] ----
  // `messages.status` is the DELIVERY ledger: one pipeline per message (queued →
  // pushed → delivered/read → terminal), shared by every session on the issue.
  // It cannot answer "has THIS session seen it", and an issue mailbox is read by
  // every agent working the issue — so consuming it on one agent's read
  // destroyed the unread status for all of them. `message_reads` is the
  // per-reader ledger the nag counts instead; the delivery ledger is untouched.

  /** Record that `sessionId` has now seen `messageId` (idempotent). */
  recordRead(messageId: string, sessionId: SessionId, readAt: string): void {
    this.db
      .insert(messageReads)
      .values({ messageId, sessionId, readAt })
      // DO NOTHING, never DO UPDATE: the FIRST sighting is the one that happened.
      .onConflictDoNothing({ target: [messageReads.messageId, messageReads.sessionId] })
      .run()
  }

  /**
   * Which of `messageIds` exist on the substrate — the batched form of asking
   * {@link getMessage} whether a row has a twin (POD-3257).
   *
   * Chunked at 500 like the other id-set readers here: SQLITE_MAX_VARIABLE_NUMBER
   * is 999 on the builds this ships against, and an unread backlog is not bounded
   * by anything this method can see.
   *
   * Existence only. A caller that needs the ROW still wants `getMessage`; this is
   * for the predicate, which is where the one-query-per-row cost was.
   */
  existingMessageIds(messageIds: string[]): Set<string> {
    const unique = [...new Set(messageIds)]
    const out = new Set<string>()
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      for (const r of this.db
        .select({ id: messagesTable.id })
        .from(messagesTable)
        .where(inArray(messagesTable.id, chunk))
        .all()) {
        out.add(r.id)
      }
    }
    return out
  }

  /** Which of `messageIds` this session has already seen. */
  readReceipts(sessionId: SessionId, messageIds: string[]): Set<string> {
    if (messageIds.length === 0) return new Set()
    const rows = this.db
      .select({ messageId: messageReads.messageId })
      .from(messageReads)
      .where(
        and(eq(messageReads.sessionId, sessionId), inArray(messageReads.messageId, messageIds)),
      )
      .all()
    return new Set(rows.map((r) => r.messageId))
  }

  /** Which of `messageIds` this session SENT — never its own unread mail
   *  [POD-1379], the same notion of self delivery already applies. */
  selfSentIds(sessionId: SessionId, messageIds: string[]): Set<string> {
    if (messageIds.length === 0) return new Set()
    const rows = this.db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.fromSession, sessionId), inArray(messagesTable.id, messageIds)))
      .all()
    return new Set(rows.map((r) => r.id))
  }

  /**
   * Pending-for-ONE-READER predicate. A row still nags `sessionId` when it is
   * non-terminal, the session did not send it, and the session has no receipt
   * or durable delivery stamp for it. The last clause bounds history: a session
   * is only responsible for mail that arrived while it existed — EXCEPT a
   * still-`queued` row, which
   * nobody has consumed, so it is exactly the held handoff a newly-arrived
   * session must be told about. A session row that is gone (tests, pre-substrate
   * ids) falls back to the message's own timestamp, i.e. counts.
   */
  private pendingForSession(issueId: IssueId, sessionId: SessionId): SQL {
    return and(
      eq(messagesTable.toKind, 'issue'),
      eq(messagesTable.toId, issueId),
      inArray(messagesTable.status, ['queued', 'delivered', 'read']),
      or(isNull(messagesTable.fromSession), ne(messagesTable.fromSession, sessionId)),
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(messageReads)
          .where(
            and(
              eq(messageReads.messageId, messagesTable.id),
              eq(messageReads.sessionId, sessionId),
            ),
          ),
      ),
      or(
        eq(messagesTable.status, 'queued'),
        isNull(messagesTable.deliveredTo),
        ne(messagesTable.deliveredTo, sessionId),
      ),
      or(
        eq(messagesTable.status, 'queued'),
        gte(
          messagesTable.createdAt,
          sql`COALESCE((SELECT ${sessionsTable.createdAt} FROM ${sessionsTable} WHERE ${sessionsTable.id} = ${sessionId}), ${sql.identifier('messages')}.${sql.identifier('created_at')})`,
        ),
      ),
    ) as SQL
  }

  /** Count and group one reader-scoped pending slice in one statement. */
  pendingSummaryForSession(issueId: IssueId, sessionId: SessionId): PendingMessageSummary {
    return this.pendingSummaryForPredicate(this.pendingForSession(issueId, sessionId))
  }

  private pendingSummaryForPredicate(predicate: SQL | undefined): PendingMessageSummary {
    const rows = this.db
      .select({
        fromKind: messagesTable.fromKind,
        fromIssue: messagesTable.fromIssue,
        fromSession: messagesTable.fromSession,
        n: count(),
      })
      .from(messagesTable)
      .where(predicate)
      .groupBy(messagesTable.fromKind, messagesTable.fromIssue, messagesTable.fromSession)
      .orderBy(
        asc(messagesTable.fromKind),
        asc(messagesTable.fromIssue),
        asc(messagesTable.fromSession),
      )
      .all()
    return {
      count: rows.reduce((total, row) => total + Number(row.n), 0),
      senders: rows.map((row) => ({
        fromKind: row.fromKind as MessageRow['fromKind'],
        fromIssue: row.fromIssue,
        fromSession: row.fromSession,
      })),
    }
  }

  /** The DISTINCT sender projection both queued-sender readers share. */
  private distinctSenders(predicate: SQL | undefined): PendingMessageSender[] {
    return this.db
      .selectDistinct({
        fromKind: messagesTable.fromKind,
        fromIssue: messagesTable.fromIssue,
        fromSession: messagesTable.fromSession,
      })
      .from(messagesTable)
      .where(predicate)
      .orderBy(
        asc(messagesTable.fromKind),
        asc(messagesTable.fromIssue),
        asc(messagesTable.fromSession),
      )
      .all()
      .map((row) => ({
        fromKind: row.fromKind as MessageRow['fromKind'],
        fromIssue: row.fromIssue,
        fromSession: row.fromSession,
      }))
  }

  countPendingForSession(issueId: IssueId, sessionId: SessionId): number {
    const row = this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(this.pendingForSession(issueId, sessionId))
      .get()
    return Number(row?.n ?? 0)
  }

  listPendingSendersForSession(issueId: IssueId, sessionId: SessionId): PendingMessageSender[] {
    return this.distinctSenders(this.pendingForSession(issueId, sessionId))
  }

  /** True if a message FROM `fromIssue` reached `to` at/after `sinceIso` — the
   *  steward's "already-communicated" arbiter check [POD-913, design §07b/§10]:
   *  before firing an automated fact to a target, has the producer already told
   *  it directly? Existence-only (any status), since even a still-queued row
   *  proves the producer already acted — the steward's notice would just be a
   *  duplicate waiting to happen. */
  alreadyCommunicated(fromIssue: string, to: MessagePrincipalRef, sinceIso: string): boolean {
    const row = this.db
      .select({ hit: sql<number>`1` })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.fromIssue, fromIssue),
          gte(messagesTable.createdAt, sinceIso),
          ...addressedTo(to),
        ),
      )
      .limit(1)
      .get()
    return row !== undefined
  }

  /** Record a PUSH toward a live PTY without claiming the agent saw it [POD-834]:
   *  stamps injected_at + delivered_to but keeps status='queued'. This replaces
   *  the old "mark delivered on enqueue" lie — `delivered` is now reserved for a
   *  transcript echo. A queued row that was injected but never echoed within the
   *  window is auto-requeued (clearInjected). Guarded on status='queued'. */
  markInjected(id: string, deliveredTo: SessionId | null, injectedAt: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ injectedAt, deliveredTo })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    return r.changes === 1
  }

  /**
   * queued → dead_letter, because a driver queue gave up: the session never went
   * live before its ready deadline (`never-live`), it was torn down with the turn
   * still undelivered (`teardown`), or a server-family driver took the turn off
   * its own queue and the send failed (`delivery-failed`) [POD-2132, POD-2202,
   * POD-2297]. TERMINAL — this is the write
   * that ends the stale `queued` receipt the sender was left holding, and after it
   * the server never re-sends this row (`countPending` drops it, the sweep skips
   * it, a blocked `waitFor` gets its answer).
   *
   * The `delivery_deferred_*` stamps record WHEN the driver reported giving up and
   * WHICH report said so, next to the terminal status and `dead_lettered_at`.
   *
   * THE `status = 'queued'` GUARD IS THE DEDUPE. Abandonment reports are retryable
   * and repeat across restarts, so the same turn id arrives more than once; the
   * second one finds a row that is no longer queued and returns false, which is how
   * the caller emits exactly one transition per turn.
   */
  markDeliveryAbandoned(
    id: string,
    deliveredTo: SessionId,
    at: string,
    reason: QueueDrainAbandonedReason,
  ): boolean {
    const r = this.db
      .update(messagesTable)
      .set({
        status: 'dead_letter',
        deadLetteredAt: at,
        deliveryDeferredAt: at,
        deliveryDeferredReason: reason,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${deliveredTo})`,
      })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    return r.changes === 1
  }

  /**
   * THE PUSH THIS ROW IS RESTING ON WAS REFUSED, SO THE ROW GOES BACK IN THE
   * QUEUE [POD-2298].
   *
   * The optimistic half of the receipt migration is that a send toward a live
   * driver records its ledger state IMMEDIATELY — `delivered` for a body that is
   * confirmed on injection, `injected_at` for one still owed an echo — and the
   * driver's receipt arrives afterwards to correct it. When that receipt is a
   * refusal whose cause CLEARS ON ITS OWN (a turn was open, a person owes an
   * answer, a human holds the lease), the correction is to undo the optimism and
   * let the ordinary retry machinery run again: status back to `queued`,
   * `delivered_at` and `injected_at` erased so the idle drain and the sweep both
   * see an un-pushed row.
   *
   * `delivered_to` STAYS. It is the last place this row was aimed, the sweep
   * re-reads it rather than trusting it, and clearing it would erase the only
   * evidence of which session refused.
   *
   * THE READ RECEIPT GOES WITH THE DELIVERY. `markDelivered` records one, and a
   * per-reader receipt saying this session saw a message it never got is the same
   * lie one table over — it hides the row from that session's own pending set.
   *
   * {@link MessagesRepository.restingOnAPush} IS THE GUARD AND THE IDEMPOTENCY.
   * A repeat finds the row already `queued` with no `injected_at`, matches
   * nothing and changes nothing.
   */
  retractOptimisticDelivery(id: string, deliveredTo: SessionId): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ status: 'queued', deliveredAt: null, injectedAt: null })
      .where(restingOnAPush(id, deliveredTo))
      .run()
    if (r.changes !== 1) return false
    this.db
      .delete(messageReads)
      .where(and(eq(messageReads.messageId, id), eq(messageReads.sessionId, deliveredTo)))
      .run()
    return true
  }

  /**
   * queued|delivered → dead_letter, because the driver REFUSED the push this row
   * was already resting on [POD-2298].
   *
   * The sibling of {@link markDeliveryAbandoned}, and it exists rather than
   * widening it because that one is guarded `status = 'queued'` — the whole point
   * here is a row that optimistic delivery already moved past `queued`, which
   * that guard silently skips. Both write the same `delivery_deferred_*` stamps
   * so one undelivered turn reads the same way whichever route reported it.
   *
   * `reason` is deliberately the EXISTING abandonment vocabulary rather than the
   * refusal's own: the wire enum stays three arms wide (widening it is a
   * rolling-upgrade event, POD-2297) and the precise `RefusalReason` is already on
   * the `message.receipt` event emitted beside this write.
   *
   * Guarded through the same {@link restingOnAPush} predicate as
   * {@link retractOptimisticDelivery}, for the same reason — a refusal corrects
   * the push it answers, never a row that has since moved on.
   */
  markSendRefused(
    id: string,
    deliveredTo: SessionId,
    at: string,
    reason: QueueDrainAbandonedReason,
  ): boolean {
    const r = this.db
      .update(messagesTable)
      .set({
        status: 'dead_letter',
        deadLetteredAt: at,
        deliveryDeferredAt: at,
        deliveryDeferredReason: reason,
      })
      .where(restingOnAPush(id, deliveredTo))
      .run()
    return r.changes === 1
  }

  /** queued → delivered: the PUSH is CONFIRMED — the message's envelope appeared
   *  as a turn in the target's transcript (transcript echo, [POD-834]). Only now
   *  does the ledger claim the agent has it in context. Guarded on status so a
   *  duplicate/late echo is a no-op (returns false). */
  markDelivered(id: string, deliveredTo: string | null, deliveredAt: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ status: 'delivered', deliveredAt, deliveredTo })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    // The echo proves it is in THAT session's context [POD-1379] — receipt it,
    // or the per-reader nag keeps asking the session to read what it just saw.
    if (deliveredTo) this.recordRead(id, asSessionId(deliveredTo), deliveredAt)
    return r.changes === 1
  }

  /** queued → cancelled: the sender retracted work before it reached the
   * recipient. The queued-input drain re-reads this status immediately before
   * touching the PTY, so a cancelled row cannot be applied later. */
  markCancelled(id: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ status: 'cancelled' })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    return r.changes === 1
  }

  /** queued → delivered via the PULL path (an issue-mailbox read/claim) [POD-1420].
   *  Same ledger advance as `markDelivered`, with one difference that matters:
   *  `delivered_to` is COALESCEd, never overwritten. `markInjected` stamps the
   *  session a message was PUSHED to while leaving status `queued`, so a plain
   *  overwrite here erased that target the moment the agent opened its inbox —
   *  the row then read as "delivered to nobody" despite having been routed
   *  correctly and landed in a transcript. That erase is why the delivery ledger
   *  could not be trusted to answer "did this reach anyone?". */
  markDeliveredByPull(id: string, reader: string | null, deliveredAt: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({
        status: 'delivered',
        deliveredAt,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${reader})`,
      })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    // The pull proves THIS reader has it, whoever the row was pushed to.
    if (reader) this.recordRead(id, asSessionId(reader), deliveredAt)
    return r.changes === 1
  }

  /** queued|delivered → read: the recipient opened its inbox and consumed it (the
   *  PULL path, [POD-834]). Distinct from delivered (push): `read` proves the
   *  agent pulled it. A delivered row can still be marked read if later pulled. */
  markRead(id: string, deliveredTo: string | null, readAt: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({
        status: 'read',
        readAt,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${deliveredTo})`,
      })
      .where(and(eq(messagesTable.id, id), inArray(messagesTable.status, ['queued', 'delivered'])))
      .run()
    // The PULL proves this reader has it [POD-1379]. Recorded even when the
    // guarded UPDATE lost (a peer consumed the shared row first): the receipt is
    // about THIS reader, not about who moved the shared delivery ledger.
    if (deliveredTo) this.recordRead(id, asSessionId(deliveredTo), readAt)
    return r.changes === 1
  }

  /** queued → dead_letter: the target was gone before the message could land
   *  (issue closed/archived, session deleted with nowhere to re-route) [POD-834].
   *  Terminal; the sender is told once. Guarded on status='queued'.
   *
   *  `cause` RECORDS WHY, FOR THE ROWS WHERE "GONE" IS NOT THE ANSWER [POD-2574].
   *  A dead letter with no cause reads, downstream, as a vanished target — which
   *  is right for the callsites this was written for and wrong for a driver that
   *  refused the send. Passing a cause stamps the same two columns
   *  {@link markDeliveryAbandoned} uses, so both refusal paths — the late one the
   *  daemon reports and the synchronous one answered inside the send — leave a row
   *  a reader can tell apart from a target that disappeared. */
  markDeadLetter(id: string, at: string, cause?: QueueDrainAbandonedReason): boolean {
    // TWO DIFFERENT WRITES, not one with nulls: without a cause the two
    // `delivery_deferred_*` columns are LEFT ALONE rather than cleared.
    const r = this.db
      .update(messagesTable)
      .set(
        cause
          ? {
              status: 'dead_letter',
              deadLetteredAt: at,
              deliveryDeferredAt: at,
              deliveryDeferredReason: cause,
            }
          : { status: 'dead_letter', deadLetteredAt: at },
      )
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    return r.changes === 1
  }

  /** Auto-requeue seam [POD-834]: a queued row was injected but no echo confirmed
   *  it within the window — the push was lost. Clear injected_at so the next
   *  delivery attempt re-pushes. Guarded on status='queued' so a row that raced to
   *  delivered/read in the meantime is left alone. */
  clearInjected(id: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ injectedAt: null })
      .where(and(eq(messagesTable.id, id), eq(messagesTable.status, 'queued')))
      .run()
    return r.changes === 1
  }

  /** Every queued (undelivered) row, oldest first — the slow sweep's retry set. */
  listQueued(limit = 500): MessageRow[] {
    return this.listQueuedPage({ limit })
  }

  /** One bounded keyset page of the global queued delivery set. */
  listQueuedPage(opts: { after?: MessagePageCursor; limit?: number } = {}): MessageRow[] {
    const where: SQL[] = [eq(messagesTable.status, 'queued')]
    if (opts.after) where.push(afterCursor(opts.after))
    return this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts.limit, 500, 2000))
      .all()
      .map(mapMessage)
  }

  /** Persist a keyed wake attempt before its external side effect. */
  recordWakeCooldown(key: string, attemptedAt: string): void {
    this.db
      .insert(messageWakeCooldowns)
      .values({ key, attemptedAt })
      .onConflictDoUpdate({ target: messageWakeCooldowns.key, set: { attemptedAt } })
      .run()
  }

  getWakeCooldown(key: string): string | null {
    const row = this.db
      .select({ attemptedAt: messageWakeCooldowns.attemptedAt })
      .from(messageWakeCooldowns)
      .where(eq(messageWakeCooldowns.key, key))
      .get()
    return row?.attemptedAt ?? null
  }

  /** Apply one janitor-observed expiry only if every observed durable fact is
   * still current. Server time eligibility is checked by MaintenanceService
   * immediately before this conditional write in the same transaction. */
  expireObserved(input: {
    id: string
    createdAt: string
    lifecycle: MessageRow['lifecycle']
    expiresAt: string | null
  }): boolean {
    const result = this.db
      .update(messagesTable)
      .set({ status: 'expired' })
      .where(
        and(
          eq(messagesTable.id, input.id),
          eq(messagesTable.status, 'queued'),
          eq(messagesTable.createdAt, input.createdAt),
          eq(messagesTable.lifecycle, input.lifecycle),
          // `IS`, NOT `=`. SQL `=` never matches null, and most rows have no
          // expiry — emitting `=` here would silently stop expiring them while
          // the non-null case kept working. `isNull` is the `IS ?` null arm.
          input.expiresAt === null
            ? isNull(messagesTable.expiresAt)
            : eq(messagesTable.expiresAt, input.expiresAt),
        ),
      )
      .run()
    return result.changes === 1
  }

  /** Stamp the ack message id onto the original (first ack wins). */
  markAcked(id: string, ackedBy: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ ackedBy })
      .where(and(eq(messagesTable.id, id), isNull(messagesTable.ackedBy)))
      .run()
    return r.changes === 1
  }

  /** Delivered-to-`sessionId`, unfulfilled, unexpired rows that REQUESTED a
   *  response [POD-835 §04b] — `expects_response = 1` is the sole gate (a
   *  `--expect-response` send or a `question`); an ordinary message owes no reply,
   *  so receipt alone never lands here. `acked_by IS NULL` is the unfulfilled test:
   *  it is stamped by any in-thread reply (semantic-reply-as-ack), not just a
   *  `kind:'ack'`. The stop-hook reminder and the steward's deterministic fallback
   *  both read this set (#237) [spec:SP-34d7 acks]. */
  listDeliveredUnacked(sessionId: SessionId, now: string): MessageRow[] {
    return (
      this.db
        .select()
        .from(messagesTable)
        // The agent has it either way — pushed (delivered) or pulled (read).
        .where(and(this.unackedRequest(sessionId, now)))
        .orderBy(...DELIVERY_ORDER)
        .all()
        .map(mapMessage)
    )
  }

  /** The shared "still owes a reply" predicate of the two ack readers. */
  private unackedRequest(sessionId: SessionId, now: string): SQL {
    return and(
      inArray(messagesTable.status, ['delivered', 'read']),
      eq(messagesTable.deliveredTo, sessionId),
      isNull(messagesTable.ackedBy),
      eq(messagesTable.expectsResponse, true),
      or(isNull(messagesTable.expiresAt), gt(messagesTable.expiresAt, now)),
    ) as SQL
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
  listSettleNotifiable(sessionId: SessionId, now: string): MessageRow[] {
    const notice = alias(messagesTable, 'n')
    return this.db
      .select()
      .from(messagesTable)
      .where(
        and(
          this.unackedRequest(sessionId, now),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(notice)
              .where(and(eq(notice.kind, 'notification'), eq(notice.inReplyTo, messagesTable.id))),
          ),
        ),
      )
      .orderBy(...DELIVERY_ORDER)
      .all()
      .map(mapMessage)
  }

  /** Stamp the ONE stop-hook reminder (never repeats: guarded on NULL). */
  markReminded(id: string, at: string): boolean {
    const r = this.db
      .update(messagesTable)
      .set({ remindedAt: at })
      .where(and(eq(messagesTable.id, id), isNull(messagesTable.remindedAt)))
      .run()
    return r.changes === 1
  }
}

/** `(created_at, id) > cursor` — the keyset step both forward pagers share. */
function afterCursor(cursor: MessagePageCursor): SQL {
  return or(
    gt(messagesTable.createdAt, cursor.createdAt),
    and(eq(messagesTable.createdAt, cursor.createdAt), gt(messagesTable.id, cursor.id)),
  ) as SQL
}

/** `(created_at, id) <= cursor` — INCLUSIVE, which is what makes a high-water
 *  snapshot a finite scan rather than one that races new arrivals. */
function throughCursor(cursor: MessagePageCursor): SQL {
  return or(
    lt(messagesTable.createdAt, cursor.createdAt),
    and(eq(messagesTable.createdAt, cursor.createdAt), lte(messagesTable.id, cursor.id)),
  ) as SQL
}

/**
 * IS THIS ROW STILL RESTING ON AN UNANSWERED PUSH TO `delivered_to`? The
 * predicate both refusal writers correct through, written once so they cannot
 * drift apart [POD-2298].
 *
 * Optimistic delivery leaves exactly two fingerprints, and they are what the two
 * arms name. `delivered` WITH NO `injected_at` is a body confirmed on injection
 * — an unwrapped operator chat line or a best-effort ack, which `injectAndMark`
 * marks delivered outright because no echo will ever come. `queued` WITH an
 * `injected_at` is an enveloped body whose bytes were dispatched and whose echo
 * is still owed.
 *
 * WHAT THE TWO ARMS TOGETHER EXCLUDE IS THE POINT. A row that is `delivered` AND
 * carries `injected_at` was confirmed by the transcript echo or the turn
 * boundary — the agent demonstrably has it — and a driver's refusal arriving
 * afterwards is late evidence about a question the transcript already answered.
 * Walking that row backwards would be the mirror image of the defect this
 * predicate exists to fix. `read`, `cancelled` and `dead_letter` are terminal or
 * retracted and match neither arm.
 */
function restingOnAPush(id: string, deliveredTo: SessionId): SQL {
  return and(
    eq(messagesTable.id, id),
    eq(messagesTable.deliveredTo, deliveredTo),
    or(
      and(eq(messagesTable.status, 'delivered'), isNull(messagesTable.injectedAt)),
      and(eq(messagesTable.status, 'queued'), isNotNull(messagesTable.injectedAt)),
    ),
  ) as SQL
}
