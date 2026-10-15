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
  MESSAGE_PENDING,
  MessageDelivery,
  type MessageDeliveryStatus,
  type MessageHeld,
  type MoveOutcome,
  type SessionId,
  HarnessRef,
  type HarnessRefEntry,
  mergeHarnessRefs,
  type TranscriptItemRef,
} from '@podium/model'
import {
  type MessageFailedCause,
  type QueueDrainAbandonedReason,
  RuntimeAttachmentRef,
} from '@podium/protocol/daemon'
import {
  and,
  asc,
  count,
  desc,
  eq,
  getColumns,
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
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
} from './executor/sync-drizzle'
import { moveStatus } from './guarded-move'
import type { MessageRow, MessageToKind } from './types'

/** Bodies past this many characters render as a pointer, not inline
 *  (issue-addressed only — they are readable via `podium issue mail inbox`). */
export const INLINE_BODY_MAX = 6_000

/** Longer than {@link INLINE_BODY_MAX} counted as SQLite's `length()` counts
 *  text: in characters (code points), where `.length` counts UTF-16 units and so
 *  counts an emoji twice. Units are never fewer than characters and never more
 *  than twice as many, so only a body between the two bounds is walked. SQLite
 *  also stops counting at a NUL; a body holding one is the one it can misjudge. */
const longerThanInline = (body: string): boolean => {
  if (body.length <= INLINE_BODY_MAX) return false
  if (body.length > 2 * INLINE_BODY_MAX) return true
  let chars = 0
  for (let i = 0; i < body.length; i += body.codePointAt(i)! > 0xffff ? 2 : 1) {
    if (++chars > INLINE_BODY_MAX) return true
  }
  return false
}

/**
 * THE POINTER RULE — one definition, in code and in SQL, here below the
 * renderer so the pending-mail count reads the same rule the renderer types by.
 *
 * A pointer is exactly a row the renderer types as a pointer to the inbox: an
 * issue-addressed body too long to type inline. It shows no body, so only an
 * inbox read confirms it and it keeps nagging until then. Nothing else is one:
 * fyi mail short enough to type is typed inline in its envelope like any other
 * row, and the daemon's settlement confirms it [POD-4845].
 */
export const isPointerMessage = (message: Pick<MessageRow, 'toKind' | 'body'>): boolean =>
  message.toKind === 'issue' && longerThanInline(message.body)

/** {@link isPointerMessage} as a row predicate. */
const isPointerRow = (): SQL =>
  and(
    eq(messagesTable.toKind, 'issue'),
    sql`length(${messagesTable.body}) > ${INLINE_BODY_MAX}`,
  ) as SQL

/** Handed on toward a session and not confirmed, or handed on and lost track
 *  of: either way the server has done its part and nothing re-pushes it. */
const HANDED_ON: readonly MessageDeliveryStatus[] = MESSAGE_HANDED_ON

/** Still worth a "you have mail" nag: not an INLINE row that was handed to
 *  the `sessionId` placeholder (any session when `handedToSession` is false) and
 *  is on its way into that session's context as a turn [POD-4661]. Written
 *  branch by branch so a NULL column reads as "not handed on", never as
 *  "exclude". */
const notOnItsWay = (handedToSession: boolean): SQL =>
  or(
    notInArray(messagesTable.deliveryStatus, [...HANDED_ON]),
    isNull(messagesTable.deliveredTo),
    ...(handedToSession ? [ne(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId'))] : []),
    isPointerRow(),
  ) as SQL

/** Not ended: held, on its way, or lost track of. */
const pending = (): SQL => inArray(messagesTable.deliveryStatus, [...MESSAGE_PENDING])

/**
 * CONFIRMED INTO `sessionId`, read through `idx_messages_delivered_to_time` (POD-5941).
 *
 * The database carries no `sqlite_stat1`, so the planner cannot know that
 * `confirmed` is nearly every row. Given `delivery_status = ?` it picked
 * `idx_messages_delivery_expiry_explicit` and walked every confirmed row — 32k
 * of 37k on ludovico, ~90 ms a statement — for the reply-owed readers that the
 * daemon path runs about once a second. The unary `+` takes the status term out
 * of index selection, so the session's own delivered rows are the scan: 2 ms,
 * 11 ms for the busiest recipient. `messages-golden.test.ts` pins the plan.
 * The session is the `sessionId` placeholder.
 */
const confirmedInto = (): SQL =>
  and(
    sql`+${messagesTable.deliveryStatus} = ${'confirmed'}`,
    eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId')),
  ) as SQL

/** The columns a move may set besides the status the move owns. */
type MoveSet = Omit<SQLiteUpdateSetSource<typeof messagesTable>, 'deliveryStatus' | 'id'>

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

/** The stored ids, or undefined when there are none or they cannot be read:
 *  a lookup key the record can live without, so never a failed read. */
function storedHarnessRef(value: unknown): HarnessRefEntry[] | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = HarnessRef.safeParse(JSON.parse(value))
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function mapMessage(r: MessageSelect): MessageRow {
  const actor = storedActor(r)
  const attachments = storedAttachments(r.attachmentsJson)
  const harnessRef = storedHarnessRef(r.harnessRefJson)
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
    ...(r.deliveryHeld ? { held: r.deliveryHeld } : {}),
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
    ...(harnessRef ? { harnessRef } : {}),
    ...(r.noticeDismissedAt ? { noticeDismissedAt: r.noticeDismissedAt } : {}),
    ...(r.retractRequestedAt ? { retractRequestedAt: r.retractRequestedAt } : {}),
  }
}

/**
 * ADDRESSED TO A PRINCIPAL. A principal with no id is `to_id IS NULL`, never a
 * bound null, which matches nothing. Declared once because seven readers ask it.
 *
 * `operator` has no id, and every row addressed to the operator stores none:
 * the send path and the failure notice both write `to_id` null for it, as the
 * substrate has since it began. So the operator is the `no-id` shape, and its
 * reads seek the recipient indexes on `(to_kind, to_id)`; asking `to_kind`
 * alone read every message of that kind [POD-6173].
 *
 * Prepared by SHAPE [POD-6147]: whether the principal has an id is the key,
 * and the kind and id are the `toKind` / `toId` placeholders
 * ({@link addressValues}).
 */
type AddressShape = 'no-id' | 'id'

const addressShape = (to: MessagePrincipalRef): AddressShape =>
  to.kind === 'operator' || (to.id ?? null) === null ? 'no-id' : 'id'

function addressedTo(shape: AddressShape): SQL[] {
  return [
    eq(messagesTable.toKind, param(messagesTable.toKind, 'toKind')),
    shape === 'no-id' ? isNull(messagesTable.toId) : eq(messagesTable.toId, param(messagesTable.toId, 'toId')),
  ]
}

/** The placeholder values {@link addressedTo} reads. */
const addressValues = (to: MessagePrincipalRef): { toKind: MessageToKind; toId: string | null } => ({
  toKind: to.kind,
  toId: to.id ?? null,
})

/** The `(created_at, id)` delivery order every queued scan and cursor shares. */
const DELIVERY_ORDER = [asc(messagesTable.createdAt), asc(messagesTable.id)] as const

const boundedLimit = (limit: number | undefined, fallback: number, ceiling: number): number =>
  Math.min(ceiling, Math.max(1, limit ?? fallback))

export type MessageQueueFact = Pick<typeof messagesTable.$inferSelect, 'id' | 'toKind' | 'toId' | 'deliveryStatus'>

// Every query this repository runs, prepared once per store [POD-6147].

/** The row a new message stores; its set keys are its shape (see {@link MessagesRepository.addMessage}). */
const insertMessage = preparedFamily((db: StoreDrizzle, shape: string) =>
  db
    .insert(messagesTable)
    .values(placeholdersFor(shape) as unknown as typeof messagesTable.$inferInsert)
    .onConflictDoNothing({ target: messagesTable.id })
    .returning()
    .prepare(),
)

const messageById = prepared((db: StoreDrizzle) =>
  db.select().from(messagesTable).where(eq(messagesTable.id, param(messagesTable.id, 'id'))).prepare(),
)

/** Keyed by the IN list's prepared size ({@link inListSize}); the ids are `ids0`, `ids1`, ... */
const messagesWithIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select().from(messagesTable).where(inListOf(messagesTable.id, size, 'ids')).prepare(),
)

const messagesAddressedTo = preparedFamily((db: StoreDrizzle, shape: AddressShape) =>
  db
    .select()
    .from(messagesTable)
    .where(and(...addressedTo(shape)))
    .orderBy(...DELIVERY_ORDER)
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const pendingForSessionProof = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagesTable)
    .where(
      or(
        and(
          pending(),
          or(
            and(
              eq(messagesTable.toKind, 'session'),
              eq(messagesTable.toId, param(messagesTable.toId, 'sessionId')),
            ),
            eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId')),
          ),
        ),
        and(
          confirmedInto(),
          isNull(messagesTable.ackedBy),
          eq(messagesTable.expectsResponse, true),
          or(isNull(messagesTable.expiresAt), gt(messagesTable.expiresAt, param(messagesTable.expiresAt, 'now'))),
        ),
      ),
    )
    .orderBy(...DELIVERY_ORDER)
    .prepare(),
)

/** Which principals a ledger read names: an issue, a session, or both. */
type LedgerShape = 'issue' | 'session' | 'both'

/**
 * THE DELIVERY LEDGER, ONE ARM PER WAY A ROW CAN NAME THE PRINCIPAL [POD-6148].
 *
 * A row belongs to an issue's ledger when the issue sent it or it was
 * addressed to the issue; to a session's when the session sent it, it was
 * addressed to the session, or it was handed to the session (`delivered_to`).
 * Written as one `WHERE a OR b OR ...` this read every message and sorted it:
 * SQLite takes the OR-by-union path only when EVERY arm has an index, and even
 * then it sorts the union. Written as a `UNION` of one SELECT per arm, each
 * arm reads its own index newest first (`idx_messages_from_issue`,
 * `idx_messages_recipient_time`, `idx_messages_from_session_time`,
 * `idx_messages_delivered_to_time`, all ending in `created_at, id`), SQLite
 * merges the arms in that order and stops at the limit. `UNION`, not `UNION
 * ALL`: a row an issue both sent and received appears once, as it did.
 */
const ledger = preparedFamily((db: StoreDrizzle, shape: LedgerShape) => {
  const arms: SQL[] = []
  if (shape !== 'session') {
    arms.push(
      eq(messagesTable.fromIssue, param(messagesTable.fromIssue, 'issueId')),
      and(eq(messagesTable.toKind, 'issue'), eq(messagesTable.toId, param(messagesTable.toId, 'issueId'))) as SQL,
    )
  }
  if (shape !== 'issue') {
    arms.push(
      eq(messagesTable.fromSession, param(messagesTable.fromSession, 'sessionId')),
      and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, param(messagesTable.toId, 'sessionId'))) as SQL,
      eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId')),
    )
  }
  const [first, ...rest] = arms.map((where) => db.select().from(messagesTable).where(where))
  let union = first!.$dynamic()
  for (const arm of rest) union = union.union(arm).$dynamic()
  return union
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
    .limit(sql.placeholder('limit'))
    .prepare()
})

/** Still waiting in the `sessionId` placeholder's queue: `stored`, and addressed
 *  to it or aimed at it by `delivered_to`. */
const waitingForSession = (): SQL | undefined =>
  and(
    eq(messagesTable.deliveryStatus, 'stored'),
    or(
      and(eq(messagesTable.toKind, 'session'), eq(messagesTable.toId, param(messagesTable.toId, 'sessionId'))),
      eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId')),
    ),
  )

const queuedMessageKey = prepared((db: StoreDrizzle) =>
  db
    .select({ createdAt: messagesTable.createdAt, id: messagesTable.id })
    .from(messagesTable)
    .where(and(eq(messagesTable.id, param(messagesTable.id, 'messageId')), waitingForSession()))
    .prepare(),
)

const queuedAheadOf = prepared((db: StoreDrizzle) =>
  db
    .select({ n: count() })
    .from(messagesTable)
    .where(
      and(
        waitingForSession(),
        or(
          lt(messagesTable.createdAt, param(messagesTable.createdAt, 'createdAt')),
          and(
            eq(messagesTable.createdAt, param(messagesTable.createdAt, 'createdAt')),
            lte(messagesTable.id, param(messagesTable.id, 'id')),
          ),
        ),
      ),
    )
    .prepare(),
)

/** Keyed by the principal's shape and whether a cursor is given (`|after`). */
const pendingPage = preparedFamily((db: StoreDrizzle, key: `${AddressShape}${'' | '|after'}`) => {
  const [shape, after] = key.split('|') as [AddressShape, string | undefined]
  const where = [...addressedTo(shape), pending()]
  if (after !== undefined) where.push(afterCursor())
  return db
    .select()
    .from(messagesTable)
    .where(and(...where))
    .orderBy(...DELIVERY_ORDER)
    .limit(sql.placeholder('limit'))
    .prepare()
})

const latestPendingOperator = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.toKind, 'session'),
        eq(messagesTable.toId, param(messagesTable.toId, 'sessionId')),
        eq(messagesTable.fromKind, 'operator'),
        pending(),
      ),
    )
    .orderBy(desc(messagesTable.createdAt), desc(sql`rowid`))
    .limit(1)
    .prepare(),
)

/**
 * "The `sessionId` placeholder has a receipt for this row", the subquery of
 * {@link pendingForSession}. A builder, not a statement: built once per store
 * and rendered into the statements that embed it.
 */
const readBySession = prepared((db: StoreDrizzle) =>
  db
    .select({ one: sql`1` })
    .from(messageReads)
    .where(
      and(
        eq(messageReads.messageId, messagesTable.id),
        eq(messageReads.sessionId, param(messageReads.sessionId, 'sessionId')),
      ),
    ),
)

/**
 * Pending-for-ONE-READER predicate, over the `issueId` and `sessionId`
 * placeholders. A row still nags the session when it is non-terminal, the
 * session did not send it, and the session has no receipt or durable delivery
 * stamp for it. The last clause bounds history: a session is only responsible
 * for mail that arrived while it existed — EXCEPT a still-pending row, which
 * nobody has consumed, so it is exactly the held handoff a newly-arrived
 * session must be told about. A session row that is gone (tests, pre-substrate
 * ids) falls back to the message's own timestamp, i.e. counts.
 */
function pendingForSession(db: StoreDrizzle, handedToSession: boolean): SQL {
  return and(
    eq(messagesTable.toKind, 'issue'),
    eq(messagesTable.toId, param(messagesTable.toId, 'issueId')),
    inArray(messagesTable.deliveryStatus, [...MESSAGE_PENDING, 'confirmed']),
    or(isNull(messagesTable.fromSession), ne(messagesTable.fromSession, param(messagesTable.fromSession, 'sessionId'))),
    notExists(readBySession(db)),
    or(
      pending(),
      isNull(messagesTable.deliveredTo),
      ne(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'sessionId')),
    ),
    notOnItsWay(handedToSession),
    or(
      pending(),
      gte(
        messagesTable.createdAt,
        sql`COALESCE((SELECT ${sessionsTable.createdAt} FROM ${sessionsTable} WHERE ${sessionsTable.id} = ${sql.placeholder('sessionId')}), ${sql.identifier('messages')}.${sql.identifier('created_at')})`,
      ),
    ),
  ) as SQL
}

/** A pending slice by principal shape, or one reader's slice of an issue (`session`). */
// `session-blank` is a reader whose session id is the empty string: the fluent
// form dropped its "handed to another session" clause for a falsy id, so that
// call keeps its own statement.
type PendingSlice = AddressShape | 'session' | 'session-blank'

const isSessionSlice = (slice: PendingSlice): slice is 'session' | 'session-blank' =>
  slice === 'session' || slice === 'session-blank'

const sessionSlice = (sessionId: SessionId): 'session' | 'session-blank' =>
  sessionId ? 'session' : 'session-blank'

/** Count and group one queued slice in one statement for the inbox nag. */
const pendingSummaryOf = preparedFamily((db: StoreDrizzle, slice: PendingSlice) =>
  db
    .select({
      fromKind: messagesTable.fromKind,
      fromIssue: messagesTable.fromIssue,
      fromSession: messagesTable.fromSession,
      n: count(),
    })
    .from(messagesTable)
    .where(isSessionSlice(slice) ? pendingForSession(db, slice === 'session') : and(...addressedTo(slice), pending(), notOnItsWay(false)))
    .groupBy(messagesTable.fromKind, messagesTable.fromIssue, messagesTable.fromSession)
    .orderBy(
      asc(messagesTable.fromKind),
      asc(messagesTable.fromIssue),
      asc(messagesTable.fromSession),
    )
    .prepare(),
)

/** The DISTINCT sender projection both queued-sender readers share. */
const pendingSendersOf = preparedFamily((db: StoreDrizzle, slice: PendingSlice) =>
  db
    .selectDistinct({
      fromKind: messagesTable.fromKind,
      fromIssue: messagesTable.fromIssue,
      fromSession: messagesTable.fromSession,
    })
    .from(messagesTable)
    .where(isSessionSlice(slice) ? pendingForSession(db, slice === 'session') : and(...addressedTo(slice), pending()))
    .orderBy(
      asc(messagesTable.fromKind),
      asc(messagesTable.fromIssue),
      asc(messagesTable.fromSession),
    )
    .prepare(),
)

const pendingCountOf = preparedFamily((db: StoreDrizzle, slice: PendingSlice) =>
  db
    .select({ n: count() })
    .from(messagesTable)
    .where(isSessionSlice(slice) ? pendingForSession(db, slice === 'session') : and(...addressedTo(slice), pending()))
    .prepare(),
)

const queuedCount = prepared((db: StoreDrizzle) =>
  db.select({ n: count() }).from(messagesTable).where(pending()).prepare(),
)

const insertRead = prepared((db: StoreDrizzle) =>
  db
    .insert(messageReads)
    .values({
      messageId: sql.placeholder('messageId'),
      sessionId: sql.placeholder('sessionId'),
      readAt: sql.placeholder('readAt'),
    })
    // DO NOTHING, never DO UPDATE: the FIRST sighting is the one that happened.
    .onConflictDoNothing({ target: [messageReads.messageId, messageReads.sessionId] })
    .prepare(),
)

const existingIdsAmong = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select({ id: messagesTable.id }).from(messagesTable).where(inListOf(messagesTable.id, size, 'ids')).prepare(),
)

const receiptsAmong = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ messageId: messageReads.messageId })
    .from(messageReads)
    .where(
      and(
        eq(messageReads.sessionId, param(messageReads.sessionId, 'sessionId')),
        inListOf(messageReads.messageId, size, 'ids'),
      ),
    )
    .prepare(),
)

const sentAmong = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.fromSession, param(messagesTable.fromSession, 'sessionId')),
        inListOf(messagesTable.id, size, 'ids'),
      ),
    )
    .prepare(),
)

const communicatedSince = preparedFamily((db: StoreDrizzle, shape: AddressShape) =>
  db
    .select({ hit: sql<number>`1` })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.fromIssue, param(messagesTable.fromIssue, 'fromIssue')),
        gte(messagesTable.createdAt, param(messagesTable.createdAt, 'sinceIso')),
        ...addressedTo(shape),
      ),
    )
    .limit(1)
    .prepare(),
)

/**
 * THE GUARD {@link moveStatus} ANDs INTO A MOVE, built where the move is
 * prepared [POD-6147]. `moveStatus` builds this same expression on every call
 * and hands it to `write`; a statement prepared once cannot take it there, so
 * the definition builds it from the same machine. Keep the two identical.
 */
/** One move's statement: the status it writes, the stamps that travel with it,
 *  and the conditions that narrow the row past its id and the guard. */
interface MoveSpec {
  readonly to: MessageDeliveryStatus
  readonly set?: () => MoveSet
  readonly where?: () => readonly SQL[]
}

/** Unaimed, or aimed at the `deliveredTo` placeholder's session. */
const unaimedOrAimedAt = (): SQL =>
  or(
    isNull(messagesTable.deliveredTo),
    eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'deliveredTo')),
  ) as SQL

/** Every move this repository makes, one prepared statement each. */
const MOVES = {
  dispatched: {
    to: 'dispatched',
    set: () => ({ injectedAt: sql.placeholder('at'), deliveredTo: sql.placeholder('deliveredTo') }),
  },
  typed: {
    to: 'typed',
    set: () => ({
      deliveredTo: sql.placeholder('deliveredTo'),
      injectedAt: sql`COALESCE(${messagesTable.injectedAt}, ${sql.placeholder('at')})`,
    }),
    where: () => [unaimedOrAimedAt()],
  },
  accepted: {
    to: 'accepted',
    set: () => ({
      deliveredTo: sql.placeholder('deliveredTo'),
      deliveryHeld: sql.placeholder('held'),
      injectedAt: sql`COALESCE(${messagesTable.injectedAt}, ${sql.placeholder('at')})`,
    }),
    where: () => [unaimedOrAimedAt()],
  },
  unknown: {
    to: 'unknown',
    where: () => [
      eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'deliveredTo')),
      or(isNull(messagesTable.deliveryHeld), ne(messagesTable.deliveryHeld, 'durable')) as SQL,
    ],
  },
  abandoned: {
    to: 'failed',
    set: () => ({
      deadLetteredAt: sql.placeholder('at'),
      deliveryDeferredAt: sql.placeholder('at'),
      deliveryDeferredReason: sql.placeholder('reason'),
      deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${sql.placeholder('deliveredTo')})`,
    }),
  },
  delivered: {
    to: 'confirmed',
    set: () => ({ deliveredAt: sql.placeholder('deliveredAt'), deliveredTo: sql.placeholder('deliveredTo') }),
  },
  cancelled: { to: 'cancelled' },
  cancelledFrom: {
    to: 'cancelled',
    where: () => [eq(messagesTable.deliveryStatus, param(messagesTable.deliveryStatus, 'onlyFrom'))],
  },
  typing: { to: 'typing' },
  pulledByReader: {
    to: 'confirmed',
    set: () => ({
      deliveredAt: sql.placeholder('deliveredAt'),
      deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${sql.placeholder('reader')})`,
    }),
    where: () => [
      or(
        isNull(messagesTable.deliveredTo),
        eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'brandedReader')),
      ) as SQL,
    ],
  },
  pulledUnnamed: {
    to: 'confirmed',
    set: () => ({
      deliveredAt: sql.placeholder('deliveredAt'),
      deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${sql.placeholder('reader')})`,
    }),
    where: () => [isNull(messagesTable.deliveredTo)],
  },
  read: {
    to: 'confirmed',
    set: () => ({
      readAt: sql.placeholder('readAt'),
      deliveredTo: sql`COALESCE(${messagesTable.deliveredTo}, ${sql.placeholder('deliveredTo')})`,
    }),
  },
  deadLetter: {
    to: 'failed',
    set: () => ({ deadLetteredAt: sql.placeholder('at') }),
  },
  deadLetterWithCause: {
    to: 'failed',
    set: () => ({
      deadLetteredAt: sql.placeholder('at'),
      deliveryDeferredAt: sql.placeholder('at'),
      deliveryDeferredReason: sql.placeholder('cause'),
    }),
  },
  expired: {
    to: 'expired',
    where: () => [
      eq(messagesTable.createdAt, param(messagesTable.createdAt, 'createdAt')),
      eq(messagesTable.lifecycle, param(messagesTable.lifecycle, 'lifecycle')),
      eq(messagesTable.expiresAt, param(messagesTable.expiresAt, 'expiresAt')),
    ],
  },
  expiredWithoutExpiry: {
    to: 'expired',
    where: () => [
      eq(messagesTable.createdAt, param(messagesTable.createdAt, 'createdAt')),
      eq(messagesTable.lifecycle, param(messagesTable.lifecycle, 'lifecycle')),
      // `IS`, NOT `=`: see {@link MessagesRepository.expireObserved}.
      isNull(messagesTable.expiresAt),
    ],
  },
} as const satisfies Record<string, MoveSpec>

type MoveVariant = keyof typeof MOVES

/** A prepared status write: the moved rows come back, as `CommittedRows.write` needs. */
interface MoveWrite {
  all(values: Record<string, unknown>): Promise<(typeof messagesTable.$inferSelect)[]>
}

const statusOf = prepared((db: StoreDrizzle) =>
  db
    .select({ status: messagesTable.deliveryStatus })
    .from(messagesTable)
    .where(eq(messagesTable.id, param(messagesTable.id, 'id')))
    .prepare(),
)

const nameTranscriptItemOnce = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ transcriptItemId: sql.placeholder('transcriptItemId'), transcriptItemCursor: sql.placeholder('transcriptItemCursor') })
    .where(
      and(
        eq(messagesTable.id, param(messagesTable.id, 'id')),
        isNull(messagesTable.transcriptItemId),
        or(isNull(messagesTable.deliveredTo), eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'deliveredTo'))),
        notInArray(messagesTable.deliveryStatus, ['failed', 'cancelled', 'expired']),
      ),
    )
    .returning()
    .prepare(),
)

const harnessRefOf = prepared((db: StoreDrizzle) =>
  db
    .select({ harnessRefJson: messagesTable.harnessRefJson })
    .from(messagesTable)
    .where(eq(messagesTable.id, param(messagesTable.id, 'id')))
    .prepare(),
)

/** Compare-and-set on the stored text; keyed by whether there is any (`null`). */
const swapHarnessRef = preparedFamily((db: StoreDrizzle, stored: 'null' | 'text') =>
  db
    .update(messagesTable)
    .set({ harnessRefJson: sql.placeholder('harnessRefJson') })
    .where(
      and(
        eq(messagesTable.id, param(messagesTable.id, 'id')),
        stored === 'null'
          ? isNull(messagesTable.harnessRefJson)
          : eq(messagesTable.harnessRefJson, param(messagesTable.harnessRefJson, 'stored')),
        or(isNull(messagesTable.deliveredTo), eq(messagesTable.deliveredTo, param(messagesTable.deliveredTo, 'deliveredTo'))),
        notInArray(messagesTable.deliveryStatus, ['cancelled', 'expired']),
      ),
    )
    .returning()
    .prepare(),
)

const stampRetractRequest = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ retractRequestedAt: sql`COALESCE(${messagesTable.retractRequestedAt}, ${sql.placeholder('at')})` })
    .where(and(eq(messagesTable.id, param(messagesTable.id, 'id')), pending()))
    .returning()
    .prepare(),
)

const stampFirstRead = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ readAt: sql.placeholder('readAt') })
    .where(and(eq(messagesTable.id, param(messagesTable.id, 'id')), isNull(messagesTable.readAt)))
    .returning()
    .prepare(),
)

/**
 * Keyed by the session list's prepared size (0: no sessions) and whether an
 * ended issue is named (`|issue`). The sessions fill `sessions0`, `sessions1`,
 * ... in both IN lists.
 */
const openBoundTo = preparedFamily((db: StoreDrizzle, key: `${number}${'' | '|issue'}`) => {
  const [sizeText, ended] = key.split('|')
  const size = Number(sizeText)
  const bound = [
    ...(size === 0
      ? []
      : [
          and(eq(messagesTable.toKind, 'session'), inListOf(messagesTable.toId, size, 'sessions')),
          and(
            inListOf(messagesTable.deliveredTo, size, 'sessions'),
            inArray(messagesTable.deliveryStatus, [...HANDED_ON]),
          ),
        ]),
    ...(ended === undefined
      ? []
      : [and(eq(messagesTable.toKind, 'issue'), eq(messagesTable.toId, param(messagesTable.toId, 'endedIssueId')))]),
  ]
  return db
    .select()
    .from(messagesTable)
    .where(and(pending(), or(...bound)))
    .orderBy(...DELIVERY_ORDER)
    .prepare()
})

const dismissNoticeOnce = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ noticeDismissedAt: sql.placeholder('at') })
    .where(
      and(
        eq(messagesTable.id, param(messagesTable.id, 'id')),
        isNull(messagesTable.noticeDismissedAt),
        inArray(messagesTable.deliveryStatus, ['failed', 'expired', 'unknown']),
      ),
    )
    .returning()
    .prepare(),
)

/**
 * Every column of `messages` by its bare name, decoded as the column decodes:
 * what `select()` returns, for a FROM drizzle cannot express. Drizzle refuses a
 * table's own columns over a raw FROM, so each is a fragment mapped with its
 * column.
 */
const MESSAGE_COLUMNS = Object.fromEntries(
  Object.entries(getColumns(messagesTable)).map(([key, column]) => [
    key,
    sql`${sql.identifier(column.name)}`.mapWith(column),
  ]),
) as { [K in keyof MessageSelect]: SQL<MessageSelect[K]> }

/**
 * The chat feed's boot read, through the partial index idx_messages_open_chat
 * [POD-6173]. Two things kept it off that index. SQLite uses a partial index
 * only when the query states its WHERE terms with the same LITERALS, and
 * `eq(column, 'operator')` binds a parameter, a value the planner cannot see:
 * so the terms are written as the schema writes the index. And even then the
 * planner costs a walk of a partial index as a walk of the whole table, so it
 * seeks `to_kind = 'session'` instead, a large share of every message: so the
 * index is named with INDEXED BY, which also makes SQLite refuse to prepare the
 * statement if the query and the index ever stop matching. Ordered as the
 * index is, by `created_at` then rowid, so the walk needs no sort; the feed
 * keys the rows by id, so the order of rows tied on `created_at` does not
 * matter there. The query-plan audit asserts this plan.
 */
const openChat = prepared((db: StoreDrizzle) =>
  db
    .select(MESSAGE_COLUMNS)
    .from(sql`${messagesTable} INDEXED BY idx_messages_open_chat`)
    .where(
      sql`${messagesTable.fromKind} = 'operator' AND ${messagesTable.toKind} = 'session' AND ${messagesTable.noticeDismissedAt} IS NULL AND ${messagesTable.deliveryStatus} NOT IN ('confirmed', 'cancelled')`,
    )
    .orderBy(asc(messagesTable.createdAt), asc(sql`rowid`))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** Keyed by whether a cursor is given. */
const queuedPage = preparedFamily((db: StoreDrizzle, from: 'start' | 'after') => {
  const where: SQL[] = [pending()]
  if (from === 'after') where.push(afterCursor())
  return db
    .select()
    .from(messagesTable)
    .where(and(...where))
    .orderBy(...DELIVERY_ORDER)
    .limit(sql.placeholder('limit'))
    .prepare()
})

const upsertWakeCooldown = prepared((db: StoreDrizzle) =>
  db
    .insert(messageWakeCooldowns)
    .values({ key: sql.placeholder('key'), attemptedAt: sql.placeholder('attemptedAt') })
    .onConflictDoUpdate({ target: messageWakeCooldowns.key, set: { attemptedAt: sql.placeholder('attemptedAt') } })
    .prepare(),
)

const wakeCooldownOf = prepared((db: StoreDrizzle) =>
  db
    .select({ attemptedAt: messageWakeCooldowns.attemptedAt })
    .from(messageWakeCooldowns)
    .where(eq(messageWakeCooldowns.key, param(messageWakeCooldowns.key, 'key')))
    .prepare(),
)

const stampAckOnce = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ ackedBy: sql.placeholder('ackedBy') })
    .where(and(eq(messagesTable.id, param(messagesTable.id, 'id')), isNull(messagesTable.ackedBy))).returning().prepare(),
)

/** The shared "still owes a reply" predicate of the two ack readers, over the
 *  `sessionId` and `now` placeholders. */
const unackedRequest = (): SQL =>
  and(
    confirmedInto(),
    isNull(messagesTable.ackedBy),
    eq(messagesTable.expectsResponse, true),
    or(isNull(messagesTable.expiresAt), gt(messagesTable.expiresAt, param(messagesTable.expiresAt, 'now'))),
  ) as SQL

const deliveredUnacked = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagesTable)
    // The agent has it either way — pushed or pulled; both confirm.
    .where(and(unackedRequest()))
    .orderBy(...DELIVERY_ORDER)
    .prepare(),
)

const settleNotifiable = prepared((db: StoreDrizzle) => {
  const notice = alias(messagesTable, 'n')
  return db
    .select()
    .from(messagesTable)
    .where(
      and(
        unackedRequest(),
        notExists(
          db
            .select({ one: sql`1` })
            .from(notice)
            .where(and(eq(notice.kind, 'notification'), eq(notice.inReplyTo, messagesTable.id))),
        ),
      ),
    )
    .orderBy(...DELIVERY_ORDER)
    .prepare()
})

const stampRemindedOnce = prepared((db: StoreDrizzle) =>
  db
    .update(messagesTable)
    .set({ remindedAt: sql.placeholder('at') })
    .where(and(eq(messagesTable.id, param(messagesTable.id, 'id')), isNull(messagesTable.remindedAt))).returning().prepare(),
)

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
    return this.rootDb
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
    // The operator's reads ask `to_id IS NULL` ({@link addressedTo}).
    if (m.toKind === 'operator' && m.toId !== null) {
      throw new Error(`message ${m.id} to the operator must carry no recipient id (got ${m.toId})`)
    }
    const values: typeof messagesTable.$inferInsert = {
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
      deliveredAt: m.deliveredAt,
      deliveredTo: m.deliveredTo,
      ackedBy: m.ackedBy,
      hop: m.hop,
      clampedFrom: m.clampedFrom,
      expectsResponse: m.expectsResponse,
      factKey: m.factKey ?? null,
      factTarget: m.factTarget ?? null,
    }
    const { changes } = await this.write(
      async () => await insertMessage(this.db, shapeOf(values)).all(values),
      'upsert',
    )
    return changes > 0
  }

  /** Queued identities let apply distinguish mixed queued/delivered predicates
   * without a before-image SELECT. Still one statement, grouped by target. */
  async getMessage(id: string): Promise<MessageRow | null> {
    const r = await messageById(this.db).get({ id })
    return r ? mapMessage(r) : null
  }

  /** The rows with these ids, in one read; an id with no row is absent. The
   *  caller bounds how many it asks for. */
  async getMessages(ids: readonly string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return []
    const unique = [...new Set(ids)]
    const size = inListSize(unique.length)
    return (await messagesWithIds(this.db, size).all(inListValues(unique, size, 'ids')))
      .map(mapMessage)
  }

  /** All messages addressed to a principal, oldest first. */
  async listMessagesFor(
    to: MessagePrincipalRef,
    opts?: { limit?: number },
  ): Promise<MessageRow[]> {
    return (await messagesAddressedTo(this.db, addressShape(to)).all({
      ...addressValues(to),
      limit: boundedLimit(opts?.limit, 200, 500),
    }))
      .map(mapMessage)
  }

  /** Exact, unbounded safety projection of work still pending for one session. */
  async pendingForSessionProof(sessionId: SessionId, now: string): Promise<MessageRow[]> {
    return (await pendingForSessionProof(this.db).all({ sessionId, now })).map(mapMessage)
  }

  /** The delivery ledger for one issue or session (#237) [spec:SP-34d7 web]:
   *  every row the principal SENT or was ADDRESSED (issue box / session box /
   *  delivered-to), newest first — the "what happened to my message" view. */
  async listLedger(q: { issueId?: IssueId; sessionId?: SessionId; limit?: number }): Promise<MessageRow[]> {
    const shape: LedgerShape | undefined = q.issueId
      ? q.sessionId ? 'both' : 'issue'
      : q.sessionId ? 'session' : undefined
    if (shape === undefined) return []
    return (await ledger(this.db, shape).all({
      issueId: q.issueId,
      sessionId: q.sessionId,
      limit: boundedLimit(q.limit, 200, 500),
    }))
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
    const row = await queuedMessageKey(this.db).get({ sessionId, messageId })
    if (!row?.createdAt || !row.id) return undefined
    const ahead = await queuedAheadOf(this.db).get({ sessionId, createdAt: row.createdAt, id: row.id })
    return Number(ahead?.n ?? 0)
  }

  /** One bounded keyset page of pending rows for a principal. */
  async pendingForPage(
    to: MessagePrincipalRef,
    opts: { after?: MessagePageCursor; limit?: number } = {},
  ): Promise<MessageRow[]> {
    const shape = addressShape(to)
    return (await pendingPage(this.db, opts.after ? `${shape}|after` : shape).all({
      ...addressValues(to),
      ...(opts.after ? afterCursorValues(opts.after) : {}),
      limit: boundedLimit(opts.limit, 200, 500),
    }))
      .map(mapMessage)
  }

  /** Most recently inserted operator chat send still held for one session.
   * `rowid` resolves sends accepted in the same clock tick; random message ids
   * do not encode creation order. */
  async latestPendingOperatorForSession(sessionId: SessionId): Promise<MessageRow | undefined> {
    const row = await latestPendingOperator(this.db).get({ sessionId })
    return row ? mapMessage(row) : undefined
  }

  /** Complete queued-sender projection for nag/inbox aggregates. */
  async listPendingSenders(to: MessagePrincipalRef): Promise<PendingMessageSender[]> {
    return await this.distinctSenders(addressShape(to), addressValues(to))
  }

  /** Count and group one queued slice in one statement for the inbox nag. */
  async pendingSummary(to: MessagePrincipalRef): Promise<PendingMessageSummary> {
    return await this.pendingSummaryOf(addressShape(to), addressValues(to))
  }

  async countQueued(): Promise<number> {
    const row = await queuedCount(this.db).get()
    return Number(row?.n ?? 0)
  }

  async countPending(to: MessagePrincipalRef): Promise<number> {
    const row = await pendingCountOf(this.db, addressShape(to)).get(addressValues(to))
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
    await insertRead(this.db).run({ messageId, sessionId, readAt })
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
      const size = inListSize(chunk.length)
      for (const r of await existingIdsAmong(this.db, size).all(inListValues(chunk, size, 'ids'))) {
        out.add(r.id)
      }
    }
    return out
  }

  /** Which of `messageIds` this session has already seen. */
  async readReceipts(sessionId: SessionId, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const size = inListSize(messageIds.length)
    const rows = await receiptsAmong(this.db, size).all(inListValues(messageIds, size, 'ids', { sessionId }))
    return new Set(rows.map((r) => r.messageId))
  }

  /** Which of `messageIds` this session SENT — never its own unread mail
   *  [POD-1379], the same notion of self delivery already applies. */
  async selfSentIds(sessionId: SessionId, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const size = inListSize(messageIds.length)
    const rows = await sentAmong(this.db, size).all(inListValues(messageIds, size, 'ids', { sessionId }))
    return new Set(rows.map((r) => r.id))
  }

  /** Count and group one reader-scoped pending slice in one statement. */
  async pendingSummaryForSession(issueId: IssueId, sessionId: SessionId): Promise<PendingMessageSummary> {
    return await this.pendingSummaryOf(sessionSlice(sessionId), { issueId, sessionId })
  }

  private async pendingSummaryOf(slice: PendingSlice, values: Record<string, unknown>): Promise<PendingMessageSummary> {
    const rows = await pendingSummaryOf(this.db, slice).all(values)
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
  private async distinctSenders(slice: PendingSlice, values: Record<string, unknown>): Promise<PendingMessageSender[]> {
    return (await pendingSendersOf(this.db, slice).all(values))
      .map((row) => ({
        fromKind: row.fromKind as MessageRow['fromKind'],
        fromIssue: row.fromIssue,
        fromSession: row.fromSession,
      }))
  }

  async countPendingForSession(issueId: IssueId, sessionId: SessionId): Promise<number> {
    const row = await pendingCountOf(this.db, sessionSlice(sessionId)).get({ issueId, sessionId })
    return Number(row?.n ?? 0)
  }

  async listPendingSendersForSession(issueId: IssueId, sessionId: SessionId): Promise<PendingMessageSender[]> {
    return await this.distinctSenders(sessionSlice(sessionId), { issueId, sessionId })
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
    const row = await communicatedSince(this.db, addressShape(to)).get({
      fromIssue: brandedFromIssue,
      sinceIso,
      ...addressValues(to),
    })
    return row !== undefined
  }

  /**
   * THE ONE STATUS WRITE [POD-4765]. Every change to `delivery_status` is this
   * guarded UPDATE: it applies only from a state {@link MessageDelivery} allows a
   * move from, and says what happened — applied, already there (a repeat:
   * nothing written, nothing to announce), or refused with where the row
   * actually is. `variant` names the {@link MOVES} entry whose stamps travel
   * with the move and whose conditions narrow the row further (which push a
   * report answers); `values` fills their placeholders.
   *
   * PREPARED ONCE PER (variant, to) [POD-6147]. The guard `moveStatus` builds
   * depends on `to` alone, so the statement built from the first call's guard is
   * the statement every later call with the same key would have built.
   */
  private async move(
    id: string,
    to: MessageDeliveryStatus,
    opts: { variant?: MoveVariant; values?: Record<string, unknown> } = {},
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    const spec: MoveSpec = opts.variant ? MOVES[opts.variant] : { to }
    const key = `${opts.variant ?? 'plain'}|${to}`
    return await moveStatus({
      machine: MessageDelivery,
      column: messagesTable.deliveryStatus,
      to,
      write: async (guard) => {
        let statement = this.moveWrites.get(key)
        if (statement === undefined) {
          statement = prepared((db: StoreDrizzle) =>
            db
              .update(messagesTable)
              .set({ ...spec.set?.(), deliveryStatus: to })
              .where(and(eq(messagesTable.id, param(messagesTable.id, 'id')), guard, ...(spec.where?.() ?? [])))
              .returning()
              .prepare(),
          )
          this.moveWrites.set(key, statement)
        }
        const write = statement
        return (await this.write(async () => await write(this.db).all({ ...opts.values, id }), 'upsert')).changes
      },
      read: async () => (await statusOf(this.db).get({ id }))?.status ?? null,
    })
  }

  /** {@link move} by its {@link MOVES} entry, which names the target status. */
  private async moveBy(
    variant: MoveVariant,
    values: { id: string } & Record<string, unknown>,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.move(values.id, MOVES[variant].to, { variant, values })
  }

  /** The prepared status writes, one per (variant, to); see {@link move}. */
  private readonly moveWrites = new Map<string, (db: StoreDrizzle) => MoveWrite>()

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
    return await this.moveBy('dispatched', { id, at, deliveredTo })
  }

  /** → typed: its bytes crossed into `deliveredTo`'s CLI, which may still park
   *  them until the running turn ends (POD-1242). Only for the session it was
   *  handed to, or an unaimed row. */
  async markTyped(
    id: string,
    deliveredTo: SessionId,
    at: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.moveBy('typed', { id, deliveredTo, at })
  }

  /**
   * → accepted: the agent program in `deliveredTo` took it but it is not yet in
   * the program's history (POD-4885, POD-4819 §4), and `held` says how the
   * program holds it. Only for the session it was handed to, or an unaimed row.
   * A repeat finds the row there already and changes nothing, `held` included.
   */
  async markAccepted(
    id: string,
    deliveredTo: SessionId,
    held: MessageHeld,
    at: string,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.moveBy('accepted', { id, deliveredTo, held, at })
  }

  /**
   * → unknown: the row was handed to `deliveredTo` and nobody can say any more
   * whether it arrived — the forward timed out, or the machine reported that it
   * cannot prove the text landed (POD-4775). Never `failed`: the machine may
   * still type it, and a later report or the echo still moves it on. Guarded on
   * the push it answers.
   *
   * NEVER A MESSAGE THE PROGRAM HOLDS DURABLY (POD-4885, POD-4819 §3.5). It is
   * in the program's own queue, survives a restart and may still run; every
   * move to `unknown` is a time limit or an unproven write, and neither says
   * anything about that queue. The refusal is in the SQL, so no caller can
   * forget it.
   */
  async markUnknown(
    id: string,
    deliveredTo: SessionId,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.moveBy('unknown', { id, deliveredTo })
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
   * exactly one transition — and stores at most one `notice` — per turn.
   */
  async markDeliveryAbandoned(
    id: string,
    deliveredTo: SessionId,
    at: string,
    reason: QueueDrainAbandonedReason,
    notice?: MessageRow | null,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.failWith(
      notice,
      async () =>
        await this.moveBy('abandoned', { id, at, reason, deliveredTo }),
    )
  }

  /**
   * THE FAILURE AND ITS NOTICE ARE ONE WRITE (POD-4778). A message moves to
   * `failed` at most once, and the notice telling its sender is stored in the
   * same transaction, only when this call made the move. So a crash can never
   * leave a failure nobody was told about, and a repeated failure report can
   * never store a second notice. The notice is an ordinary `stored` message;
   * the delivery path takes it from there, across restarts, once per id.
   */
  private async failWith(
    notice: MessageRow | null | undefined,
    fail: () => Promise<MoveOutcome<MessageDeliveryStatus>>,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.createOrJoinTransaction(async () => {
      const outcome = await fail()
      if (notice && moved(outcome)) await this.addMessage(notice)
      return outcome
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
    const outcome = await this.moveBy('delivered', { id, deliveredAt, deliveredTo: brandedDeliveredTo })
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
   * a row handed to another session is not named by this one's history, and
   * a message that ended without being typed — failed, cancelled, expired —
   * became no entry at all (POD-4840). Answers whether THIS call wrote it.
   */
  async nameTranscriptItem(
    id: string,
    deliveredTo: SessionId,
    item: TranscriptItemRef,
  ): Promise<boolean> {
    const written = await this.write(
      async () =>
        await nameTranscriptItemOnce(this.db).all({
          id,
          deliveredTo,
          transcriptItemId: item.id,
          transcriptItemCursor: item.cursor ?? null,
        }),
      'upsert',
    )
    return written.changes === 1
  }

  /**
   * KEEP THE AGENT PROGRAM'S OWN IDS FOR THIS MESSAGE [POD-4841].
   *
   * A stamp beside the status, like the entry above, and a list that only
   * grows: the ids already kept stay as they are and new ones are added once
   * each, in the order learned ({@link mergeHarnessRefs}). Only for the push
   * this report answers — never a row handed to another session — and never
   * for a message withdrawn or expired before anything typed it. A failed or
   * unknown message keeps them: finding it later is what they are for.
   * Compare-and-set on the stored text, so two reports never lose each
   * other's ids. Answers whether THIS call changed the list.
   */
  async recordHarnessRef(
    id: string,
    deliveredTo: SessionId,
    harnessRef: HarnessRef,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await harnessRefOf(this.db).get({ id })
      if (!current) return false
      const known = storedHarnessRef(current.harnessRefJson)
      const merged = mergeHarnessRefs(known, harnessRef)
      if (!merged || merged.length === (known?.length ?? 0)) return false
      const stored = current.harnessRefJson ?? null
      const written = await this.write(
        async () =>
          await swapHarnessRef(this.db, stored === null ? 'null' : 'text').all({
            id,
            stored,
            deliveredTo,
            harnessRefJson: JSON.stringify(merged),
          }),
        'upsert',
      )
      if (written.changes === 1) return true
      // Lost the race, or refused: a refusal reads the same row again and
      // refuses again; a lost race merges with what the winner wrote.
      const after = await harnessRefOf(this.db).get({ id })
      if ((after?.harnessRefJson ?? null) === stored) return false
    }
    return false
  }

  /** → cancelled: withdrawn before it was typed — the daemon holding it said
   *  so, or nothing past the server ever held it (POD-4776). */
  async markCancelled(
    id: string,
    opts: { onlyFrom?: MessageDeliveryStatus } = {},
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await (opts.onlyFrom
      ? this.moveBy('cancelledFrom', { id, onlyFrom: opts.onlyFrom })
      : this.moveBy('cancelled', { id }))
  }

  /** → typing: the agent's machine said it has started typing it — today only
   *  in its answer to a retract that came too late (POD-4776). */
  async markTyping(id: string): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.moveBy('typing', { id })
  }

  /**
   * THE SENDER ASKED TO RETRACT IT [POD-4776]. A stamp, not a move: only the
   * daemon's answer (or the server being the only holder) moves the status to
   * `cancelled`. Stamped only while the message is still pending, and the first
   * request's time is kept. Answers whether the row carries a stamp now.
   */
  async requestRetract(id: string, at: string): Promise<boolean> {
    const r = await this.write(async () => await stampRetractRequest(this.db).all({ id, at }), 'upsert')
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
    const outcome = await (brandedReader
      ? this.moveBy('pulledByReader', { id, deliveredAt, reader, brandedReader })
      : this.moveBy('pulledUnnamed', { id, deliveredAt, reader }))
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
    const outcome = await this.moveBy('read', { id, readAt, deliveredTo })
    let firstRead = outcome.kind === 'applied'
    if (outcome.kind === 'already-there') {
      // A stamp, not a move: `delivery_status` is untouched. First read wins.
      const stamped = await this.write(async () => await stampFirstRead(this.db).all({ id, readAt }), 'upsert')
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
   *  Terminal; the sender is told once, by the `notice` stored with the move.
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
    cause?: MessageFailedCause,
    notice?: MessageRow | null,
  ): Promise<MoveOutcome<MessageDeliveryStatus>> {
    return await this.failWith(
      notice,
      async () =>
        await (cause
          ? this.moveBy('deadLetterWithCause', { id, at, cause })
          : this.moveBy('deadLetter', { id, at })),
    )
  }

  /**
   * EVERY OPEN MESSAGE BOUND TO WHAT IS BEING REMOVED, in delivery order
   * (POD-4816, POD-4817): addressed to one of these sessions, or handed on to
   * one of them, and, when their issue is deleted with them (`endedIssueId`),
   * addressed to that issue. A session going away strands the first two,
   * because its queue goes with it and nothing re-pushes a row that was handed
   * on. An issue-addressed row still `stored` is bound to its issue, not to a
   * session: it stays for whoever works the issue next, unless the issue is the
   * thing going away.
   */
  async listOpenBoundTo(
    sessionIds: readonly SessionId[],
    endedIssueId?: IssueId,
  ): Promise<MessageRow[]> {
    if (sessionIds.length === 0 && endedIssueId === undefined) return []
    const size = inListSize(sessionIds.length)
    const rows = await openBoundTo(this.db, endedIssueId === undefined ? `${size}` : `${size}|issue`).all(
      inListValues(sessionIds, size, 'sessions', { endedIssueId }),
    )
    return rows.map(mapMessage)
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
    const r = await this.write(async () => await dismissNoticeOnce(this.db).all({ id, at }), 'upsert')
    return r.changes === 1
  }

  /**
   * The people's chat messages the feed carries as OPEN [POD-4764]: sent into a
   * session, not confirmed or cancelled, and not dismissed. Oldest first, and
   * read through `idx_messages_open_chat` so the confirmed history is never
   * touched. The feed's boot read.
   */
  async listOpenChat(limit = 2000): Promise<MessageRow[]> {
    return (await openChat(this.db).all({ limit: boundedLimit(limit, 2000, 10_000) })).map(mapMessage)
  }

  /** Every pending row, oldest first — the slow sweep's retry set. */
  async listQueued(limit = 500): Promise<MessageRow[]> {
    return await this.listQueuedPage({ limit })
  }

  /** One bounded keyset page of the global pending delivery set. */
  async listQueuedPage(opts: { after?: MessagePageCursor; limit?: number } = {}): Promise<MessageRow[]> {
    return (await queuedPage(this.db, opts.after ? 'after' : 'start').all({
      ...(opts.after ? afterCursorValues(opts.after) : {}),
      limit: boundedLimit(opts.limit, 500, 2000),
    }))
      .map(mapMessage)
  }

  /** Persist a keyed wake attempt before its external side effect. */
  async recordWakeCooldown(key: string, attemptedAt: string): Promise<void> {
    await upsertWakeCooldown(this.db).run({ key, attemptedAt })
  }

  async getWakeCooldown(key: string): Promise<string | null> {
    const row = await wakeCooldownOf(this.db).get({ key })
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
    const values = { id: input.id, createdAt: input.createdAt, lifecycle: input.lifecycle, expiresAt: input.expiresAt }
    // `IS`, NOT `=`. SQL `=` never matches null, and most rows have no
    // expiry — emitting `=` here would silently stop expiring them while
    // the non-null case kept working. `isNull` is the `IS ?` null arm.
    return await this.moveBy(input.expiresAt === null ? 'expiredWithoutExpiry' : 'expired', values)
  }

  /** Stamp the ack message id onto the original (first ack wins). */
  async markAcked(id: string, ackedBy: string): Promise<boolean> {
    const r = await this.write(async () => await stampAckOnce(this.db).all({ id, ackedBy }), 'upsert')
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
    return (await deliveredUnacked(this.db).all({ sessionId, now })).map(mapMessage)
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
    return (await settleNotifiable(this.db).all({ sessionId, now })).map(mapMessage)
  }

  /** Stamp the ONE stop-hook reminder (never repeats: guarded on NULL). */
  async markReminded(id: string, at: string): Promise<boolean> {
    const r = await this.write(async () => await stampRemindedOnce(this.db).all({ id, at }), 'upsert')
    return r.changes === 1
  }
}

/** `(created_at, id) > cursor` — the keyset step both forward pagers share,
 *  over the `afterCreatedAt` / `afterId` placeholders ({@link afterCursorValues}). */
function afterCursor(): SQL {
  return or(
    gt(messagesTable.createdAt, param(messagesTable.createdAt, 'afterCreatedAt')),
    and(
      eq(messagesTable.createdAt, param(messagesTable.createdAt, 'afterCreatedAt')),
      gt(messagesTable.id, param(messagesTable.id, 'afterId')),
    ),
  ) as SQL
}

function afterCursorValues(cursor: MessagePageCursor): { afterCreatedAt: string; afterId: string } {
  return { afterCreatedAt: cursor.createdAt, afterId: cursor.id }
}
