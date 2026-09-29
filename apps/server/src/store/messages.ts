import { CommittedRows } from './committed-rows'
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
  asIssueId,
  asSessionId,
  asUserId,
  type IssueId,
  MESSAGE_HANDED_ON,
  MESSAGE_ON_ITS_WAY,
  MESSAGE_PENDING,
  MessageDelivery,
  type MessageDeliveryStatus,
  type MoveOutcome,
  type SessionId,
  type TranscriptItemRef,
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
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { alias, type SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import {
  messageReads,
  messages as messagesTable,
  messageWakeCooldowns,
  sessions as sessionsTable,
} from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'
import { moveStatus } from './guarded-move'
import type { LegacyMessageStatus, MessageRow, MessageToKind } from './types'

/** Bodies past this render as a pointer, not inline (issue-addressed only —
 *  they are readable via `podium issue mail inbox`). Here, below the renderer,
 *  so the pending-mail count can tell a pointer row from an inline one. */
export const INLINE_BODY_MAX = 6_000

/** A pointer row — fyi, or a body too long to paste — shows no body inline, so
 *  only an inbox read confirms it and it keeps nagging until then. */
const isPointerRow = (): SQL =>
  or(eq(messagesTable.urgency, 'fyi'), sql`length(${messagesTable.body}) > ${INLINE_BODY_MAX}`) as SQL

/** Handed on toward a session and not confirmed, or handed on and lost track
 *  of: either way the server has done its part and nothing re-pushes it. */
const HANDED_ON: readonly MessageDeliveryStatus[] = MESSAGE_HANDED_ON

/** Still worth a "you have mail" nag: not an INLINE row that was handed to
 *  `handedTo` (any session when omitted) and is on its way into that session's
 *  context as a turn [POD-4661]. Written branch by branch so a NULL column reads
 *  as "not handed on", never as "exclude". */
const notOnItsWay = (handedTo?: SessionId): SQL =>
  or(
    notInArray(messagesTable.deliveryStatus, [...HANDED_ON]),
    isNull(messagesTable.deliveredTo),
    ...(handedTo ? [ne(messagesTable.deliveredTo, handedTo)] : []),
    isPointerRow(),
  ) as SQL

/** Not ended: held, on its way, or lost track of. */
const pending = (): SQL => inArray(messagesTable.deliveryStatus, [...MESSAGE_PENDING])

/**
 * THE LEGACY `status` VALUE for a delivery status (POD-4765). Written beside
 * every move so a one-release rollback reads rows it understands; decided on by
 * nothing current. A confirmed row reads `read` once its read_at is stamped,
 * as the old pull path wrote it.
 */
export function legacyMessageStatus(status: MessageDeliveryStatus, read: boolean): LegacyMessageStatus {
  switch (status) {
    case 'stored':
    case 'dispatched':
    case 'reached-machine':
    case 'typing':
    case 'typed':
    case 'unknown':
      return 'queued'
    case 'confirmed':
      return read ? 'read' : 'delivered'
    case 'failed':
      return 'dead_letter'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'cancelled'
  }
}

/** The columns a move may set besides the status pair the move owns. */
type MoveSet = Omit<SQLiteUpdateSetSource<typeof messagesTable>, 'deliveryStatus' | 'legacyStatus' | 'id'>

/** Did the move change the row? The one reading most callers need. */
export const moved = (outcome: MoveOutcome<MessageDeliveryStatus>): boolean =>
  outcome.kind === 'applied'

/** RETAINED EXTERNAL/POLYMORPHIC BRAND CASTS: delivery receipt methods accept
 * reader ids as strings, while actor_id is decoded by actor_kind. All
 * monomorphic selected message ids flow from the schema without casts. */
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

/** Receives every message row a write touched, inside that write's transaction. */
export type MessageFeedCapture = (rows: readonly MessageRow[]) => Promise<void>

/** One `messages` row as the schema types it, before mapping. */
type MessageSelect = typeof messagesTable.$inferSelect

function storedActor(r: MessageSelect): ActorRef | null {
  const kind = r.actorKind
  const id = r.actorId
  if (!kind || !id) return null
  // POLYMORPHIC BRAND DECODE: actor_id is a UserId, AgentIdentityId, or system
  // job according to actor_kind, so one schema brand would be a lie.
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
    fromSession: r.fromSession ?? null,
    ...(r.fromName !== null && r.fromName !== undefined ? { fromName: r.fromName } : {}),
    fromIssue: r.fromIssue ?? null,
    ...(actor
      ? {
          attribution: {
            actor,
            onBehalfOf: r.onBehalfOf ?? null,
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
    deliveryStatus: r.deliveryStatus,
    deliveredAt: r.deliveredAt ?? null,
    deliveredTo: r.deliveredTo ?? null,
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
    ...(r.transcriptItemId
      ? {
          transcriptItem: {
            id: r.transcriptItemId,
            ...(r.transcriptItemCursor ? { cursor: r.transcriptItemCursor } : {}),
          },
        }
      : {}),
    ...(r.noticeDismissedAt ? { noticeDismissedAt: r.noticeDismissedAt } : {}),
    ...(r.retractRequestedAt ? { retractRequestedAt: r.retractRequestedAt } : {}),
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

export type MessageQueueFact = Pick<typeof messagesTable.$inferSelect, 'id' | 'toKind' | 'toId' | 'deliveryStatus'>

export class MessagesRepository {
  readonly committed: CommittedRows<MessageQueueFact>

  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * This aggregate opens no span today, but both members are retained so adding
   * one later does not change constructor arity or the composition root.
   */
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  /** The chat feed's capture, run inside every write's transaction [POD-4764]. */
  private feedCapture: MessageFeedCapture | undefined

  constructor(queries: StoreQueries) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'messages')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * INSTALL THE FEED CAPTURE [POD-4764]. Every write below returns the rows it
   * touched, whole, and hands them to `capture` INSIDE the same transaction,
   * so "the row changed" and "the feed says so" commit or roll back together:
   * no status move can reach the table without reaching every device, and no
   * device can see a status the table never held. Composition installs it once;
   * the answer uninstalls it.
   */
  setFeedCapture(capture: MessageFeedCapture): () => void {
    this.feedCapture = capture
    return () => {
      if (this.feedCapture === capture) this.feedCapture = undefined
    }
  }

  /** The one write funnel: the committed-rows publication plus the feed capture. */
  private async write(
    query: () => Promise<MessageSelect[]>,
    operation: 'upsert' | 'delete',
  ): Promise<{ changes: number }> {
    return await this.committed.write(async () => {
      const rows = await query()
      const capture = this.feedCapture
      if (capture !== undefined && rows.length > 0) await capture(rows.map(mapMessage))
      return rows
    }, operation)
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line rather than 39 fields.
   */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
  }

  /** Store a new message, ONCE PER ID (POD-4763). Every row starts `stored`:
   *  any later status is a move through {@link MessagesRepository.move}, never
   *  an insert.
   *
   *  The id is the sender's, and a sender that never heard back repeats its
   *  attempt under the same one. So an id that is already stored is not an
   *  error and not a second row: the insert does nothing and this answers
   *  `false`, in the same statement, so two attempts racing each other cannot
   *  both see "absent". The caller reads the stored row to answer the repeat. */
  async addMessage(m: MessageRow): Promise<boolean> {
    if (m.deliveryStatus !== 'stored') {
      throw new Error(`message ${m.id} must be stored before it moves (got ${m.deliveryStatus})`)
    }
    const { changes } = await this.write(async () => (this.db
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
        deliveryStatus: 'stored',
        legacyStatus: legacyMessageStatus('stored', false),
        deliveredAt: m.deliveredAt,
        deliveredTo: m.deliveredTo,
        ackedBy: m.ackedBy,
        hop: m.hop,
        clampedFrom: m.clampedFrom,
        expectsResponse: m.expectsResponse,
        factKey: m.factKey ?? null,
        factTarget: m.factTarget ?? null,
      })).onConflictDoNothing({ target: messagesTable.id }).returning().all(), 'upsert')
    return changes > 0
  }

  /** Queued identities let apply distinguish mixed queued/delivered predicates
   * without a before-image SELECT. Still one statement, grouped by target. */
  async loadWorldPending(): Promise<{ toKind: string; toId: string | null; count: number; ids: string[] }[]> {
    const rows = await this.db.select({
      toKind: messagesTable.toKind, toId: messagesTable.toId,
      count: sql<number>`count(*)`, ids: sql<string>`json_group_array(${messagesTable.id})`,
    }).from(messagesTable).where(pending())
      .groupBy(messagesTable.toKind, messagesTable.toId).all()
    return rows.map((row) => ({ ...row, ids: JSON.parse(row.ids) as string[] }))
  }

  async getMessage(id: string): Promise<MessageRow | null> {
    const r = await this.db.select().from(messagesTable).where(eq(messagesTable.id, id)).get()
    return r ? mapMessage(r) : null
  }

  /** All messages addressed to a principal, oldest first. */
  async listMessagesFor(
    to: MessagePrincipalRef,
    opts?: { limit?: number },
  ): Promise<MessageRow[]> {
    const where = addressedTo(to)
    return (await this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts?.limit, 200, 500))
      .all())
      .map(mapMessage)
  }

  /** Exact, unbounded safety projection of work still pending for one session. */
  async pendingForSessionProof(sessionId: SessionId, now: string): Promise<MessageRow[]> {
    return (await this.db
      .select()
      .from(messagesTable)
      .where(
        or(
          and(
            pending(),
            or(
              and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, sessionId)),
              eq(messagesTable.deliveredTo, sessionId),
            ),
          ),
          and(
            eq(messagesTable.deliveryStatus, 'confirmed'),
            eq(messagesTable.deliveredTo, sessionId),
            isNull(messagesTable.ackedBy),
            eq(messagesTable.expectsResponse, true),
            or(isNull(messagesTable.expiresAt), gt(messagesTable.expiresAt, now)),
          ),
        ),
      )
      .orderBy(...DELIVERY_ORDER)
      .all())
      .map(mapMessage)
  }

  /** The delivery ledger for one issue or session (#237) [spec:SP-34d7 web]:
   *  every row the principal SENT or was ADDRESSED (issue box / session box /
   *  delivered-to), newest first — the "what happened to my message" view. */
  async listLedger(q: { issueId?: IssueId; sessionId?: SessionId; limit?: number }): Promise<MessageRow[]> {
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
    return (await this.db
      .select()
      .from(messagesTable)
      .where(or(...ors))
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(boundedLimit(q.limit, 200, 500))
      .all())
      .map(mapMessage)
  }

  /**
   * The current 1-based position of a queued message for one concrete session.
   * This is deliberately a read-time count, not a stored ordinal: earlier rows
   * leave the queue as soon as they are confirmed, so a receipt's enqueue-time
   * position is not an honest reload-time position.
   *
   * A row waits while it is `stored`: addressed directly to the session, or
   * aimed at it by `delivered_to`. A handed-on row has left this queue.
   * The SQL ordering is the same `(created_at, id)` ordering used by the ledger
   * and its high-water cursors.
   */
  async queuedPositionForSession(sessionId: SessionId, messageId: string): Promise<number | undefined> {
    const target = or(
      and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, sessionId)),
      eq(messagesTable.deliveredTo, sessionId),
    )
    const waiting = and(eq(messagesTable.deliveryStatus, 'stored'), target)
    const row = await this.db
      .select({ createdAt: messagesTable.createdAt, id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.id, messageId), waiting))
      .get()
    if (!row?.createdAt || !row.id) return undefined
    const ahead = await this.db
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

  /** One bounded keyset page of pending rows for a principal. */
  async pendingForPage(
    to: MessagePrincipalRef,
    opts: { after?: MessagePageCursor; limit?: number } = {},
  ): Promise<MessageRow[]> {
    const where = [...addressedTo(to), pending()]
    if (opts.after) where.push(afterCursor(opts.after))
    return (await this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts.limit, 200, 500))
      .all())
      .map(mapMessage)
  }

  /** Most recently inserted operator chat send still held for one session.
   * `rowid` resolves sends accepted in the same clock tick; random message ids
   * do not encode creation order. */
  async latestPendingOperatorForSession(sessionId: SessionId): Promise<MessageRow | undefined> {
    const row = await this.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.toKind, 'session'),
          eq(messagesTable.toId, sessionId),
          eq(messagesTable.fromKind, 'operator'),
          pending(),
        ),
      )
      .orderBy(desc(messagesTable.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    return row ? mapMessage(row) : undefined
  }

  /** Complete queued-sender projection for nag/inbox aggregates. */
  async listPendingSenders(to: MessagePrincipalRef): Promise<PendingMessageSender[]> {
    return await this.distinctSenders(and(...addressedTo(to), pending()))
  }

  /** Count and group one queued slice in one statement for the inbox nag. */
  async pendingSummary(to: MessagePrincipalRef): Promise<PendingMessageSummary> {
    return await this.pendingSummaryForPredicate(
      and(...addressedTo(to), pending(), notOnItsWay()),
    )
  }

  async countQueued(): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(pending())
      .get()
    return Number(row?.n ?? 0)
  }

  async countPending(to: MessagePrincipalRef): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(and(...addressedTo(to), pending()))
      .get()
    return Number(row?.n ?? 0)
  }

  // ---- PER-READER state [POD-1379] [spec:SP-b11e] ----
  // `delivery_status` is the DELIVERY ledger: one pipeline per message (stored →
  // handed on → confirmed, or another end), shared by every session on the issue.
  // It cannot answer "has THIS session seen it", and an issue mailbox is read by
  // every agent working the issue — so consuming it on one agent's read
  // destroyed the unread status for all of them. `message_reads` is the
  // per-reader ledger the nag counts instead; the delivery ledger is untouched.

  /** Record that `sessionId` has now seen `messageId` (idempotent). */
  async recordRead(messageId: string, sessionId: SessionId, readAt: string): Promise<void> {
    ;await (this.db
      .insert(messageReads)
      .values({ messageId, sessionId, readAt }))
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
  async existingMessageIds(messageIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(messageIds)]
    const out = new Set<string>()
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      for (const r of await this.db
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
  async readReceipts(sessionId: SessionId, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const rows = await this.db
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
  async selfSentIds(sessionId: SessionId, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const rows = await this.db
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
   * still-pending row, which
   * nobody has consumed, so it is exactly the held handoff a newly-arrived
   * session must be told about. A session row that is gone (tests, pre-substrate
   * ids) falls back to the message's own timestamp, i.e. counts.
   */
  private async pendingForSession(issueId: IssueId, sessionId: SessionId): Promise<SQL> {
    return and(
      eq(messagesTable.toKind, 'issue'),
      eq(messagesTable.toId, issueId),
      inArray(messagesTable.deliveryStatus, [...MESSAGE_PENDING, 'confirmed']),
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
        pending(),
        isNull(messagesTable.deliveredTo),
        ne(messagesTable.deliveredTo, sessionId),
      ),
      notOnItsWay(sessionId),
      or(
        pending(),
        gte(
          messagesTable.createdAt,
          sql`COALESCE((SELECT ${sessionsTable.createdAt} FROM ${sessionsTable} WHERE ${sessionsTable.id} = ${sessionId}), ${sql.identifier('messages')}.${sql.identifier('created_at')})`,
        ),
      ),
    ) as SQL
  }

  /** Count and group one reader-scoped pending slice in one statement. */
  async pendingSummaryForSession(issueId: IssueId, sessionId: SessionId): Promise<PendingMessageSummary> {
    return await this.pendingSummaryForPredicate(await this.pendingForSession(issueId, sessionId))
  }

  private async pendingSummaryForPredicate(predicate: SQL | undefined): Promise<PendingMessageSummary> {
    const rows = await this.db
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
  private async distinctSenders(predicate: SQL | undefined): Promise<PendingMessageSender[]> {
    return (await this.db
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
      .all())
      .map((row) => ({
        fromKind: row.fromKind as MessageRow['fromKind'],
        fromIssue: row.fromIssue,
        fromSession: row.fromSession,
      }))
  }

  async countPendingForSession(issueId: IssueId, sessionId: SessionId): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(messagesTable)
      .where(await this.pendingForSession(issueId, sessionId))
      .get()
    return Number(row?.n ?? 0)
  }

  async listPendingSendersForSession(issueId: IssueId, sessionId: SessionId): Promise<PendingMessageSender[]> {
    return await this.distinctSenders(await this.pendingForSession(issueId, sessionId))
  }

  /** True if a message FROM `fromIssue` reached `to` at/after `sinceIso` — the
   *  steward's "already-communicated" arbiter check [POD-913, design §07b/§10]:
   *  before firing an automated fact to a target, has the producer already told
   *  it directly? Existence-only (any status), since even a still-queued row
   *  proves the producer already acted — the steward's notice would just be a
   *  duplicate waiting to happen. */
  async alreadyCommunicated(fromIssue: string, to: MessagePrincipalRef, sinceIso: string): Promise<boolean> {
    // EXTERNAL INPUT BRAND DECODE: the steward compatibility port supplies a
    // raw issue id; schema-branded from_issue makes this query narrow it here.
    const brandedFromIssue = asIssueId(fromIssue)
    const row = await this.db
      .select({ hit: sql<number>`1` })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.fromIssue, brandedFromIssue),
          gte(messagesTable.createdAt, sinceIso),
          ...addressedTo(to),
        ),
      )
      .limit(1)
      .get()
    return row !== undefined
  }

  /**
   * THE ONE STATUS WRITE [POD-4765]. Every change to `delivery_status` is this
   * guarded UPDATE: it applies only from a state {@link MessageDelivery} allows a
   * move from, sets the legacy `status` mirror in the same statement, and says
   * what happened — applied, already there (a repeat: nothing written, nothing
   * to announce), or refused with where the row actually is. `where` narrows the
   * row further (which push a report answers); `set` carries the stamps that
   * travel with the move.
   */
  private async move(
    id: string,
    to: MessageDeliveryStatus,
    opts: { set?: MoveSet; where?: readonly SQL[] } = {},
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    const readNow = opts.set?.readAt != null
    return await moveStatus({
      machine: MessageDelivery,
      column: messagesTable.deliveryStatus,
      to,
      write: async (guard) =>
        (
          await this.write(async () => this.db
            .update(messagesTable)
            .set({
              ...opts.set,
              deliveryStatus: to,
              legacyStatus:
                to === 'confirmed' && !readNow
                  ? sql`CASE WHEN ${messagesTable.readAt} IS NULL THEN 'delivered' ELSE 'read' END`
                  : legacyMessageStatus(to, readNow),
            })
            .where(and(eq(messagesTable.id, id), guard, ...(opts.where ?? [])))
            .returning()
            .all(), 'upsert')
        ).changes,
      read: async () =>
        (await this.db
          .select({ status: messagesTable.deliveryStatus })
          .from(messagesTable)
          .where(eq(messagesTable.id, id))
          .get())?.status ?? null,
    })
  }

  /** stored → dispatched: handed to `deliveredTo`'s delivery path (its durable
   *  queue, or a direct push toward its machine) without claiming the agent has
   *  it [POD-834]. The server never pushes a dispatched row again; the daemon's
   *  settlement, a receipt, the transcript echo, a turn boundary or an inbox
   *  read moves it on. */
  async markDispatched(
    id: string,
    deliveredTo: SessionId | null,
    at: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'dispatched', { set: { injectedAt: at, deliveredTo } })
  }

  /** → typed: its bytes crossed into `deliveredTo`'s CLI, which may still park
   *  them until the running turn ends (POD-1242). Only for the session it was
   *  handed to, or an unaimed row. */
  async markTyped(
    id: string,
    deliveredTo: SessionId,
    at: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'typed', {
      set: {
        deliveredTo,
        injectedAt: sql`COALESCE(${messagesTable.injectedAt}, ${at})`,
      },
      where: [or(isNull(messagesTable.deliveredTo), eq(messagesTable.deliveredTo, deliveredTo)) as SQL],
    })
  }

  /**
   * → unknown: the row was handed to `deliveredTo` and nobody can say any more
   * whether it arrived — the forward timed out, or the machine reported that it
   * cannot prove the text landed (POD-4775). Never `failed`: the machine may
   * still type it, and a later report or the echo still moves it on. Guarded on
   * the push it answers, like {@link markSendRefused}.
   */
  async markUnknown(
    id: string,
    deliveredTo: SessionId,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'unknown', { where: [eq(messagesTable.deliveredTo, deliveredTo)] })
  }

  /**
   * → failed, because a driver queue gave up: the session never went live
   * before its ready deadline (`never-live`), it was torn down with the turn
   * still undelivered (`teardown`), or a server-family driver took the turn off
   * its own queue and the send failed (`delivery-failed`) [POD-2132, POD-2202,
   * POD-2297]. After it the server never re-sends this row (`countPending` drops
   * it, the sweep skips it, a blocked `waitFor` gets its answer).
   *
   * The `delivery_deferred_*` stamps record WHEN the driver reported giving up and
   * WHICH report said so, next to `dead_lettered_at`.
   *
   * Abandonment reports are retryable and repeat across restarts; a repeat finds
   * the row already `failed` and changes nothing, which is how the caller emits
   * exactly one transition per turn.
   */
  async markDeliveryAbandoned(
    id: string,
    deliveredTo: SessionId,
    at: string,
    reason: QueueDrainAbandonedReason,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'failed', {
      set: {
        deadLetteredAt: at,
        deliveryDeferredAt: at,
        deliveryDeferredReason: reason,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${deliveredTo})`,
      },
    })
  }

  /**
   * → failed, because the driver REFUSED the push this row is on its way on and
   * the refusal will not clear by waiting [POD-2298]. Guarded on the row still
   * being handed to `deliveredTo`: a refusal answers that push, never a row that
   * has since been confirmed, cancelled or aimed elsewhere.
   *
   * `reason` is deliberately the EXISTING abandonment vocabulary rather than the
   * refusal's own: the wire enum stays three arms wide (widening it is a
   * rolling-upgrade event, POD-2297) and the precise `RefusalReason` is already on
   * the `message.receipt` event emitted beside this write.
   */
  async markSendRefused(
    id: string,
    deliveredTo: SessionId,
    at: string,
    reason: QueueDrainAbandonedReason,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'failed', {
      set: {
        deadLetteredAt: at,
        deliveryDeferredAt: at,
        deliveryDeferredReason: reason,
      },
      where: [
        eq(messagesTable.deliveredTo, deliveredTo),
        inArray(messagesTable.deliveryStatus, [...MESSAGE_ON_ITS_WAY]),
      ],
    })
  }

  /** → confirmed: the PUSH is CONFIRMED — the transcript echo, a clean turn
   *  boundary, the driver's acceptance or settlement, an ack [POD-834]. A
   *  duplicate or late confirmation is "already there" and changes nothing. */
  async markDelivered(
    id: string,
    deliveredTo: string | null,
    deliveredAt: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    // EXTERNAL INPUT BRAND DECODE: transcript echo compatibility callers still
    // supply strings, so narrow once before writing the branded column.
    const brandedDeliveredTo = deliveredTo ? asSessionId(deliveredTo) : null
    const outcome = await this.move(id, 'confirmed', {
      set: { deliveredAt, deliveredTo: brandedDeliveredTo },
    })
    // The echo proves it is in THAT session's context [POD-1379] — receipt it,
    // or the per-reader nag keeps asking the session to read what it just saw.
    if (brandedDeliveredTo) await this.recordRead(id, brandedDeliveredTo, deliveredAt)
    return outcome
  }

  /**
   * NAME THE ENTRY THIS MESSAGE BECAME IN `deliveredTo`'S HISTORY [POD-4774].
   *
   * A stamp, not a move: `delivery_status` is untouched, so it lands whether
   * the naming arrives with the confirmation or after it (a hook proves the
   * send before the harness records it). Written once — the first naming wins
   * and a repeat changes nothing — and only for the push this report answers:
   * a row handed to another session is not named by this one's history.
   * Answers whether THIS call wrote it.
   */
  async nameTranscriptItem(
    id: string,
    deliveredTo: SessionId,
    item: TranscriptItemRef,
  ): Promise<boolean> {
    const written = await this.write(
      async () =>
        this.db
          .update(messagesTable)
          .set({ transcriptItemId: item.id, transcriptItemCursor: item.cursor ?? null })
          .where(
            and(
              eq(messagesTable.id, id),
              isNull(messagesTable.transcriptItemId),
              or(isNull(messagesTable.deliveredTo), eq(messagesTable.deliveredTo, deliveredTo)),
            ),
          )
          .returning()
          .all(),
      'upsert',
    )
    return written.changes === 1
  }

  /** → cancelled: withdrawn before it was typed — the daemon holding it said
   *  so, or nothing past the server ever held it (POD-4776). */
  async markCancelled(
    id: string,
    opts: { onlyFrom?: MessageDeliveryStatus } = {},
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'cancelled', {
      ...(opts.onlyFrom ? { where: [eq(messagesTable.deliveryStatus, opts.onlyFrom)] } : {}),
    })
  }

  /** → typing: the agent's machine said it has started typing it — today only
   *  in its answer to a retract that came too late (POD-4776). */
  async markTyping(id: string): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'typing')
  }

  /**
   * THE SENDER ASKED TO RETRACT IT [POD-4776]. A stamp, not a move: only the
   * daemon's answer (or the server being the only holder) moves the status to
   * `cancelled`. Stamped only while the message is still pending, and the first
   * request's time is kept. Answers whether the row carries a stamp now.
   */
  async requestRetract(id: string, at: string): Promise<boolean> {
    const r = await this.write(
      async () =>
        this.db
          .update(messagesTable)
          .set({ retractRequestedAt: sql`COALESCE(${messagesTable.retractRequestedAt}, ${at})` })
          .where(and(eq(messagesTable.id, id), pending()))
          .returning()
          .all(),
      'upsert',
    )
    return r.changes === 1
  }

  /** → confirmed via the PULL path (an issue-mailbox read/claim) [POD-1420].
   *  `delivered_to` is COALESCEd, never overwritten: the push target stays the
   *  answer to "where was this aimed".
   *
   *  A peer's pull never advances the ledger [POD-4680]: when the row was pushed
   *  to another session (`delivered_to` set, not the reader), the pull records
   *  only the READER's receipt. Confirm ONLY the push this reader answers:
   *  unpushed (name the reader) or pushed to this reader. */
  async markDeliveredByPull(
    id: string,
    reader: string | null,
    deliveredAt: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    const brandedReader = reader ? asSessionId(reader) : null
    const outcome = await this.move(id, 'confirmed', {
      set: {
        deliveredAt,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${reader})`,
      },
      where: [
        brandedReader
          ? (or(isNull(messagesTable.deliveredTo), eq(messagesTable.deliveredTo, brandedReader)) as SQL)
          : isNull(messagesTable.deliveredTo),
      ],
    })
    // The pull proves THIS reader has it, whoever the row was pushed to.
    // Recorded even when the guarded move declines (a peer's pull of a row
    // pushed to another session): the receipt is about THIS reader, not about
    // who moved the shared delivery ledger.
    if (brandedReader) await this.recordRead(id, brandedReader, deliveredAt)
    return outcome
  }

  /** The recipient opened its inbox and consumed it (the PULL path, [POD-834]).
   *  An unconfirmed row → confirmed with `read_at`; an already-confirmed row
   *  keeps its status and only gains `read_at` — a read is a stamp on a
   *  delivered message, not a state after it. `firstRead` says whether THIS call
   *  stamped the first read, which is what a caller announces. */
  async markRead(
    id: string,
    deliveredTo: string | null,
    readAt: string,
  ): Promise<{ outcome: MoveOutcome<MessageDeliveryStatus>; firstRead: boolean }> {
    const outcome = await this.move(id, 'confirmed', {
      set: {
        readAt,
        deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${deliveredTo})`,
      },
    })
    let firstRead = outcome.kind === 'applied'
    if (outcome.kind === 'already-there') {
      // A stamp, not a move: `delivery_status` is untouched. First read wins.
      const stamped = await this.write(async () => this.db
        .update(messagesTable)
        .set({ readAt, legacyStatus: legacyMessageStatus('confirmed', true) })
        .where(and(eq(messagesTable.id, id), isNull(messagesTable.readAt)))
        .returning()
        .all(), 'upsert')
      firstRead = stamped.changes === 1
    }
    // The PULL proves this reader has it [POD-1379]. Recorded even when the
    // guarded move lost (a peer consumed the shared row first): the receipt is
    // about THIS reader, not about who moved the shared delivery ledger.
    if (deliveredTo) await this.recordRead(id, asSessionId(deliveredTo), readAt)
    return { outcome, firstRead }
  }

  /** → failed: the target was gone before the message could land (issue
   *  closed/archived, session deleted with nowhere to re-route) [POD-834].
   *  Terminal; the sender is told once.
   *
   *  `cause` RECORDS WHY, FOR THE ROWS WHERE "GONE" IS NOT THE ANSWER [POD-2574].
   *  Without a cause a failure reads, downstream, as a vanished target — right
   *  for the callsites this was written for and wrong for a driver that refused
   *  the send. Passing a cause stamps the same two columns
   *  {@link markDeliveryAbandoned} uses. Without one they are LEFT ALONE rather
   *  than cleared. */
  async markDeadLetter(
    id: string,
    at: string,
    cause?: QueueDrainAbandonedReason,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(id, 'failed', {
      set: cause
        ? { deadLetteredAt: at, deliveryDeferredAt: at, deliveryDeferredReason: cause }
        : { deadLetteredAt: at },
    })
  }

  /**
   * THE SENDER DISMISSED THE NOTICE of a chat message that will not arrive or
   * that nobody can vouch for [POD-4764]. A stamp, not a move: the delivery
   * status stays what happened; only the feed lets the message go. Only a
   * failed, expired or unknown row has a notice, and the first dismissal wins —
   * a repeat changes nothing. Who may dismiss is the caller's question (the
   * sender only). Answers whether THIS call wrote it.
   */
  async dismissNotice(id: string, at: string): Promise<boolean> {
    const r = await this.write(async () => this.db
      .update(messagesTable)
      .set({ noticeDismissedAt: at })
      .where(
        and(
          eq(messagesTable.id, id),
          isNull(messagesTable.noticeDismissedAt),
          inArray(messagesTable.deliveryStatus, ['failed', 'expired', 'unknown']),
        ),
      )
      .returning()
      .all(), 'upsert')
    return r.changes === 1
  }

  /**
   * The people's chat messages the feed carries as OPEN [POD-4764]: sent into a
   * session, not confirmed or cancelled, and not dismissed. Oldest first, and
   * read through `idx_messages_open_chat` so the confirmed history is never
   * touched. The feed's boot read.
   */
  async listOpenChat(limit = 2000): Promise<MessageRow[]> {
    return (await this.db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.fromKind, 'operator'),
          eq(messagesTable.toKind, 'session'),
          isNull(messagesTable.noticeDismissedAt),
          notInArray(messagesTable.deliveryStatus, ['confirmed', 'cancelled']),
        ),
      )
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(limit, 2000, 10_000))
      .all())
      .map(mapMessage)
  }

  /** Every pending row, oldest first — the slow sweep's retry set. */
  async listQueued(limit = 500): Promise<MessageRow[]> {
    return await this.listQueuedPage({ limit })
  }

  /** One bounded keyset page of the global pending delivery set. */
  async listQueuedPage(opts: { after?: MessagePageCursor; limit?: number } = {}): Promise<MessageRow[]> {
    const where: SQL[] = [pending()]
    if (opts.after) where.push(afterCursor(opts.after))
    return (await this.db
      .select()
      .from(messagesTable)
      .where(and(...where))
      .orderBy(...DELIVERY_ORDER)
      .limit(boundedLimit(opts.limit, 500, 2000))
      .all())
      .map(mapMessage)
  }

  /** Persist a keyed wake attempt before its external side effect. */
  async recordWakeCooldown(key: string, attemptedAt: string): Promise<void> {
    ;await (this.db
      .insert(messageWakeCooldowns)
      .values({ key, attemptedAt }))
      .onConflictDoUpdate({ target: messageWakeCooldowns.key, set: { attemptedAt } })
      .run()
  }

  async getWakeCooldown(key: string): Promise<string | null> {
    const row = await this.db
      .select({ attemptedAt: messageWakeCooldowns.attemptedAt })
      .from(messageWakeCooldowns)
      .where(eq(messageWakeCooldowns.key, key))
      .get()
    return row?.attemptedAt ?? null
  }

  /** Apply one janitor-observed expiry only if every observed durable fact is
   * still current. Server time eligibility is checked by MaintenanceService
   * immediately before this conditional write in the same transaction. */
  async expireObserved(input: {
    id: string
    createdAt: string
    lifecycle: MessageRow['lifecycle']
    expiresAt: string | null
  }): Promise<MoveOutcome<MessageDeliveryStatus>> {
    // Only a row the server still holds can expire: once handed on, the machine
    // may still type it, so a timer cannot say it will not arrive [POD-4765].
    return await this.move(input.id, 'expired', {
      where: [
        eq(messagesTable.createdAt, input.createdAt),
        eq(messagesTable.lifecycle, input.lifecycle),
        // `IS`, NOT `=`. SQL `=` never matches null, and most rows have no
        // expiry — emitting `=` here would silently stop expiring them while
        // the non-null case kept working. `isNull` is the `IS ?` null arm.
        input.expiresAt === null
          ? isNull(messagesTable.expiresAt)
          : eq(messagesTable.expiresAt, input.expiresAt),
      ],
    })
  }

  /** Stamp the ack message id onto the original (first ack wins). */
  async markAcked(id: string, ackedBy: string): Promise<boolean> {
    const r = await this.write(async () => this.db
      .update(messagesTable)
      .set({ ackedBy })
      .where(and(eq(messagesTable.id, id), isNull(messagesTable.ackedBy))).returning().all(), 'upsert')
    return r.changes === 1
  }

  /** Delivered-to-`sessionId`, unfulfilled, unexpired rows that REQUESTED a
   *  response [POD-835 §04b] — `expects_response = 1` is the sole gate (a
   *  `--expect-response` send or a `question`); an ordinary message owes no reply,
   *  so receipt alone never lands here. `acked_by IS NULL` is the unfulfilled test:
   *  it is stamped by any in-thread reply (semantic-reply-as-ack), not just a
   *  `kind:'ack'`. The stop-hook reminder and the steward's deterministic fallback
   *  both read this set (#237) [spec:SP-34d7 acks]. */
  async listDeliveredUnacked(sessionId: SessionId, now: string): Promise<MessageRow[]> {
    return (
      (await this.db
        .select()
        .from(messagesTable)
        // The agent has it either way — pushed or pulled; both confirm.
        .where(and(await this.unackedRequest(sessionId, now)))
        .orderBy(...DELIVERY_ORDER)
        .all())
        .map(mapMessage)
    )
  }

  /** The shared "still owes a reply" predicate of the two ack readers. */
  private async unackedRequest(sessionId: SessionId, now: string): Promise<SQL> {
    return and(
      eq(messagesTable.deliveryStatus, 'confirmed'),
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
  async listSettleNotifiable(sessionId: SessionId, now: string): Promise<MessageRow[]> {
    const notice = alias(messagesTable, 'n')
    return (await this.db
      .select()
      .from(messagesTable)
      .where(
        and(
          await this.unackedRequest(sessionId, now),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(notice)
              .where(and(eq(notice.kind, 'notification'), eq(notice.inReplyTo, messagesTable.id))),
          ),
        ),
      )
      .orderBy(...DELIVERY_ORDER)
      .all())
      .map(mapMessage)
  }

  /** Stamp the ONE stop-hook reminder (never repeats: guarded on NULL). */
  async markReminded(id: string, at: string): Promise<boolean> {
    const r = await this.write(async () => this.db
      .update(messagesTable)
      .set({ remindedAt: at })
      .where(and(eq(messagesTable.id, id), isNull(messagesTable.remindedAt))).returning().all(), 'upsert')
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
