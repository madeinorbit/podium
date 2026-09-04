/**
 * Events/steward aggregate — owns the durable orchestrator event log
 * (`podium_events`), the steward's KV state (`steward_state`) and the
 * event-subscription tables (`subscriptions`, `subscription_deliveries`,
 * event-subscriptions design Phase B).
 */

import type { SessionId } from '@podium/model'
import { ISSUE_EVENTS_DEFAULT_LIMIT, ProviderCursor } from '@podium/protocol'
import { RuntimeEvent } from '@podium/protocol/daemon'
import { and, asc, desc, eq, gt, inArray, lte, max, not, or, sql } from 'drizzle-orm'
import {
  podiumEvents,
  runtimeEventCheckpoints,
  runtimeEventProjectionCursors,
  stewardState,
  subscriptionDeliveries,
  subscriptions,
} from '../migrations/schema'
import type { SyncDrizzle, SyncQueries } from './executor/sync-drizzle'
import { afterCommit } from './executor/synchronous-span'
import type { Subscription } from './types'

export interface PodiumEventRecord {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

/** One `podium_events` row as the schema types it. */
type PodiumEventRow = {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: string
}

function rowToEvent(r: PodiumEventRow): PodiumEventRecord {
  let payload: unknown = {}
  try {
    payload = JSON.parse(r.payload)
  } catch {}
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    subject: r.subject,
    repoPath: r.repoPath,
    payload,
  }
}

/** One `subscriptions` row as the schema types it. */
type SubscriptionRow = {
  id: string
  subscriberKind: string
  subscriberId: string
  event: string
  sourceKind: string
  sourceRef: string
  deliverNudge: boolean
  deliverNotify: boolean
  origin: string
  enabled: boolean
  createdAt: string
}

function rowToSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    // The three unions are DECISIONS, not driver artefacts: the column is a free
    // TEXT column and these narrow it to the shapes the domain accepts.
    subscriberKind: r.subscriberKind as Subscription['subscriberKind'],
    subscriberId: r.subscriberId,
    event: r.event,
    sourceKind: r.sourceKind as Subscription['sourceKind'],
    sourceRef: r.sourceRef,
    deliverNudge: r.deliverNudge,
    deliverNotify: r.deliverNotify,
    origin: r.origin as Subscription['origin'],
    enabled: r.enabled,
    createdAt: r.createdAt,
  }
}

export const RUNTIME_EVENT_LOG_KIND = 'session.runtime'

/** The projector whose head fences runtime-event pruning. */
const RUNTIME_BOARD_PROJECTOR = 'runtime.board.v1'

export interface RuntimeEventCheckpoint {
  sessionId: SessionId
  observerGeneration: number
  cursor: ProviderCursor
  turnEpoch: number
  closedTurnEpoch: number | null
  updatedAt: string
}

export interface RuntimeEventLogRecord {
  id: number
  sessionId: SessionId
  event: RuntimeEvent
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

  /** The query layer. `SyncQueries` is wiring and is named in the constructor
   *  and nowhere else (spec rule 34), so a call site reads as a query. */
  private readonly db: SyncDrizzle
  /** The transaction port. `activateJanitorSteward` is the one read-decide-write
   *  here that must not be separable by a crash. */
  private readonly transact: SyncQueries['transact']

  constructor(queries: SyncQueries) {
    this.db = queries.db
    this.transact = queries.transact
  }

  /** Install the post-append announcement. One listener: this is the feed's
   *  seam, not a general event bus (the orchestrator already has one). */
  onAppend(listener: EventAppendListener): void {
    this.appendListener = listener
  }

  // ---- coarse runtime event log + restart head ----

  runtimeEventCheckpoint(sessionId: SessionId): RuntimeEventCheckpoint | null {
    const row = this.db
      .select({
        observerGeneration: runtimeEventCheckpoints.observerGeneration,
        cursorJson: runtimeEventCheckpoints.cursorJson,
        turnEpoch: runtimeEventCheckpoints.turnEpoch,
        closedTurnEpoch: runtimeEventCheckpoints.closedTurnEpoch,
        updatedAt: runtimeEventCheckpoints.updatedAt,
      })
      .from(runtimeEventCheckpoints)
      .where(eq(runtimeEventCheckpoints.sessionId, sessionId))
      .get()
    if (!row) return null
    try {
      const cursor = ProviderCursor.parse(JSON.parse(row.cursorJson))
      return {
        sessionId,
        observerGeneration: row.observerGeneration,
        cursor,
        turnEpoch: row.turnEpoch,
        // NOT `Number(row.closedTurnEpoch)`: null means no turn has closed, and
        // `Number(null)` is 0, which reads as "turn 0 closed".
        closedTurnEpoch: row.closedTurnEpoch ?? null,
        updatedAt: row.updatedAt,
      }
    } catch {
      // A corrupt cursor quarantines the WHOLE checkpoint: the session looks
      // uncheckpointed, which is the safe direction.
      return null
    }
  }

  saveRuntimeEventCheckpoint(checkpoint: RuntimeEventCheckpoint): void {
    this.db
      .insert(runtimeEventCheckpoints)
      .values({
        sessionId: checkpoint.sessionId,
        observerGeneration: checkpoint.observerGeneration,
        cursorJson: JSON.stringify(checkpoint.cursor),
        turnEpoch: checkpoint.turnEpoch,
        closedTurnEpoch: checkpoint.closedTurnEpoch,
        updatedAt: checkpoint.updatedAt,
      })
      .onConflictDoUpdate({
        target: runtimeEventCheckpoints.sessionId,
        set: {
          observerGeneration: checkpoint.observerGeneration,
          cursorJson: JSON.stringify(checkpoint.cursor),
          turnEpoch: checkpoint.turnEpoch,
          closedTurnEpoch: checkpoint.closedTurnEpoch,
          updatedAt: checkpoint.updatedAt,
        },
      })
      .run()
  }

  listRuntimeEvents(sessionId: SessionId, limit = 64): RuntimeEvent[] {
    const rows = this.db
      .select({ payload: podiumEvents.payload })
      .from(podiumEvents)
      .where(
        and(eq(podiumEvents.kind, RUNTIME_EVENT_LOG_KIND), eq(podiumEvents.subject, sessionId)),
      )
      .orderBy(desc(podiumEvents.id))
      .limit(limit)
      .all()
    const events: RuntimeEvent[] = []
    for (const row of rows.reverse()) {
      try {
        events.push(RuntimeEvent.parse(JSON.parse(row.payload)))
      } catch {}
    }
    return events
  }

  /** Read complete transcript items committed by a runtime driver. */
  listRuntimeTranscriptEvents(sessionId: SessionId, limit = 12_000): RuntimeEvent[] {
    // The inner query takes the NEWEST `limit` matching rows and the outer one
    // puts them back in ascending order. Both orderings are load-bearing: taking
    // the newest is what bounds the read, and returning them oldest-first is what
    // the transcript reader expects.
    const recent = this.db
      .select({ id: podiumEvents.id, payload: podiumEvents.payload })
      .from(podiumEvents)
      .where(
        and(
          eq(podiumEvents.kind, RUNTIME_EVENT_LOG_KIND),
          eq(podiumEvents.subject, sessionId),
          sql`json_extract(${podiumEvents.payload}, '$.t') = 'item'`,
          sql`json_extract(${podiumEvents.payload}, '$.item.kind') = 'complete'`,
        ),
      )
      .orderBy(desc(podiumEvents.id))
      .limit(limit)
      .as('recent')
    const rows = this.db
      .select({ payload: recent.payload })
      .from(recent)
      .orderBy(asc(recent.id))
      .all()
    const events: RuntimeEvent[] = []
    for (const row of rows) {
      try {
        events.push(RuntimeEvent.parse(JSON.parse(row.payload)))
      } catch {}
    }
    return events
  }
  /**
   * Has this session's causal stream actually REPORTED A FAILURE in the turn
   * the checkpoint is sitting on (POD-2414 third pass)?
   *
   * CHECKPOINT EXISTENCE IS NOT THIS, which is the bug this replaces.
   * `RuntimeEventGate.record` writes a checkpoint for EVERY accepted coarse
   * event and {@link RuntimeEventCheckpoint} carries no kind or disposition, so
   * a session that only ever emitted `state` or `turn/completed` looked
   * failure-owned. The aggregate then suppressed the `errored` recovery ask as
   * a duplicate shadow of a causal failure THAT NEVER HAPPENED, and a session
   * needing human recovery went quiet — the exact failure this issue exists to
   * prevent, reintroduced by its own fix.
   *
   * SCOPED TO THE TURN, not the session's whole history: a failure two turns
   * ago is not evidence about the failure being materialized now, and a session
   * that recovers and fails again through the legacy path must still be able to
   * ask.
   *
   * LIVE ONLY, because `projectBoard` materializes failures only from live
   * events. A replayed or bootstrap `turn/failed` never minted an ask, so
   * counting it as ownership would silence the shadow with nothing in its
   * place.
   */
  hasCausalTurnFailure(sessionId: SessionId, turnEpoch: number): boolean {
    const row = this.db
      .select({ present: sql<number>`1` })
      .from(podiumEvents)
      .where(
        and(
          eq(podiumEvents.kind, RUNTIME_EVENT_LOG_KIND),
          eq(podiumEvents.subject, sessionId),
          sql`json_extract(${podiumEvents.payload}, '$.t') = 'turn'`,
          sql`json_extract(${podiumEvents.payload}, '$.ev.ev') = 'failed'`,
          sql`json_extract(${podiumEvents.payload}, '$.provenance') = 'live'`,
          sql`json_extract(${podiumEvents.payload}, '$.turnEpoch') >= ${turnEpoch}`,
        ),
      )
      .limit(1)
      .get()
    return row !== undefined && row !== null
  }

  listRuntimeEventsAfter(afterId: number, limit = 128): RuntimeEventLogRecord[] {
    const rows = this.db
      .select({
        id: podiumEvents.id,
        subject: podiumEvents.subject,
        payload: podiumEvents.payload,
      })
      .from(podiumEvents)
      .where(and(eq(podiumEvents.kind, RUNTIME_EVENT_LOG_KIND), gt(podiumEvents.id, afterId)))
      .orderBy(asc(podiumEvents.id))
      .limit(limit)
      .all()
    return rows.map((row) => ({
      id: row.id,
      // SERIALIZATION EDGE: `subject` is a polymorphic column and cannot carry a
      // brand; the decode belongs here, where the kind filter above has already
      // established that these subjects are session ids.
      sessionId: row.subject as SessionId,
      event: RuntimeEvent.parse(JSON.parse(row.payload)),
    }))
  }

  runtimeEventProjectionCursor(projector: string): number {
    const row = this.db
      .select({ lastEventId: runtimeEventProjectionCursors.lastEventId })
      .from(runtimeEventProjectionCursors)
      .where(eq(runtimeEventProjectionCursors.projector, projector))
      .get()
    return row ? row.lastEventId : 0
  }

  saveRuntimeEventProjectionCursor(projector: string, eventId: number, updatedAt: string): void {
    this.db
      .insert(runtimeEventProjectionCursors)
      .values({ projector, lastEventId: eventId, updatedAt })
      .onConflictDoUpdate({
        target: runtimeEventProjectionCursors.projector,
        set: { lastEventId: eventId, updatedAt },
        // MONOTONIC, and the guard belongs in the statement rather than in a
        // caller: a replaying projector must not rewind the head, because
        // `pruneEventBatch` refuses to delete runtime rows above it and a rewind
        // would make already-projected rows undeletable. `setWhere` guards the
        // UPDATE; `targetWhere` would filter which rows conflict, which is a
        // different statement.
        setWhere: sql`excluded.last_event_id > ${runtimeEventProjectionCursors.lastEventId}`,
      })
      .run()
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
      .insert(podiumEvents)
      .values({
        ts: e.ts,
        kind: e.kind,
        subject: e.subject,
        repoPath: e.repoPath ?? null,
        payload: JSON.stringify(e.payload ?? {}),
      })
      .run()
    const id = Number(r.lastInsertRowid)
    // AFTER the insert, never before: the feed must not carry a row the log does
    // not have. The listener is documented as non-throwing, and this call is not
    // guarded here on purpose — a swallow at both ends hides a wiring fault
    // behind a pane that simply never updates.
    //
    // AND AFTER THE COMMIT, when this append is inside one [POD-3260, spec §3.3
    // mechanism 3]. Publication is an EXTERNAL EFFECT, and "after the insert" is
    // not the same statement as "after the commit": a caller that appends inside
    // a transaction was announcing a row that the enclosing span could still roll
    // back, so a listener saw an event the log ended up not having — the exact
    // direction this comment was written to prevent, one level up. The 22 call
    // sites that reach this from a span body needed no change: the rule belongs
    // at the one place the announcement happens, not on a list somebody has to
    // keep complete. `persistManyWith` already did this by hand with
    // `announce: false` plus `announceEvent`, and that convention still works
    // unchanged — this makes it the default rather than the exception.
    if (options.announce !== false) {
      const announced = {
        ts: e.ts,
        kind: e.kind,
        subject: e.subject,
        repoPath: e.repoPath ?? null,
        payload: e.payload ?? {},
      }
      afterCommit(() => this.appendListener?.(id, announced), `podium-event:${e.kind}`)
    }
    return id
  }

  /** Announce an event that was inserted silently inside a wider transaction.
   * The caller invokes this only after that transaction commits. */
  announceEvent(id: number): void {
    if (!this.appendListener) return
    const row = this.db.select().from(podiumEvents).where(eq(podiumEvents.id, id)).get()
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
    const where = [gt(podiumEvents.id, sinceId)]
    if (opts?.kinds?.length) where.push(inArray(podiumEvents.kind, opts.kinds))
    if (opts?.repoPath) where.push(eq(podiumEvents.repoPath, opts.repoPath))
    if (opts?.subject) where.push(eq(podiumEvents.subject, opts.subject))
    const rows = this.db
      .select()
      .from(podiumEvents)
      .where(and(...where))
      .orderBy(asc(podiumEvents.id))
      .limit(opts?.limit ?? ISSUE_EVENTS_DEFAULT_LIMIT)
      .all()
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
      .select()
      .from(podiumEvents)
      .where(and(eq(podiumEvents.kind, kind), sql`${podiumEvents.ts} < ${since}`))
      .orderBy(desc(podiumEvents.ts), desc(podiumEvents.id))
      .limit(1)
      .get()
    const rows = this.db
      .select()
      .from(podiumEvents)
      .where(and(eq(podiumEvents.kind, kind), sql`${podiumEvents.ts} >= ${since}`))
      .orderBy(asc(podiumEvents.ts), asc(podiumEvents.id))
      .all()
    return [...(prior ? [rowToEvent(prior)] : []), ...rows.map(rowToEvent)]
  }

  /**
   * One event kind for ONE subject over a time window, plus the last row
   * before the window — the per-subject sibling of `listKindSinceWithPrior`,
   * served by `idx_podium_events_subject`. A per-session step-function reader
   * (session.phase) needs the carried-in value exactly like the fleet one does.
   */
  listKindSubjectSinceWithPrior(kind: string, subject: string, since: string): PodiumEventRecord[] {
    const prior = this.db
      .select()
      .from(podiumEvents)
      .where(
        and(
          eq(podiumEvents.kind, kind),
          eq(podiumEvents.subject, subject),
          sql`${podiumEvents.ts} < ${since}`,
        ),
      )
      .orderBy(desc(podiumEvents.ts), desc(podiumEvents.id))
      .limit(1)
      .get()
    const rows = this.db
      .select()
      .from(podiumEvents)
      .where(
        and(
          eq(podiumEvents.kind, kind),
          eq(podiumEvents.subject, subject),
          sql`${podiumEvents.ts} >= ${since}`,
        ),
      )
      .orderBy(asc(podiumEvents.ts), asc(podiumEvents.id))
      .all()
    return [...(prior ? [rowToEvent(prior)] : []), ...rows.map(rowToEvent)]
  }

  /** The highest event id in the log (0 when empty) — the "now" mark for
   *  seeding a consumer cursor that must not replay history. */
  maxEventId(): number {
    const r = this.db
      .select({ m: max(podiumEvents.id) })
      .from(podiumEvents)
      .get()
    return r?.m ?? 0
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
      .select({ id: podiumEvents.id })
      .from(podiumEvents)
      .orderBy(desc(podiumEvents.id))
      .limit(1)
      .offset(opts.maxRows)
      .get()
    return { cutoff, capThroughId: cap?.id ?? 0 }
  }

  /** [spec:SP-c29e] One bounded synchronous DELETE unit from a fixed plan. */
  pruneEventBatch(plan: EventPrunePlan, batchSize = 500): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    // The projector's head fences runtime rows: anything above it has not been
    // projected yet and must survive retention. COALESCE covers the projector
    // never having run, where the head is 0 and nothing is fenced.
    const projectedThrough = this.db
      .select({ head: runtimeEventProjectionCursors.lastEventId })
      .from(runtimeEventProjectionCursors)
      .where(eq(runtimeEventProjectionCursors.projector, RUNTIME_BOARD_PROJECTOR))
    const victims = this.db
      .select({ id: podiumEvents.id })
      .from(podiumEvents)
      .where(
        and(
          or(sql`${podiumEvents.ts} < ${plan.cutoff}`, lte(podiumEvents.id, plan.capThroughId)),
          not(
            and(
              eq(podiumEvents.kind, RUNTIME_EVENT_LOG_KIND),
              gt(podiumEvents.id, sql`COALESCE((${projectedThrough}), 0)`),
            ) ?? sql`0`,
          ),
        ),
      )
      .orderBy(asc(podiumEvents.id))
      .limit(batchSize)
    const result = this.db.delete(podiumEvents).where(inArray(podiumEvents.id, victims)).run()
    return Number(result.changes)
  }

  // ---- steward state ----

  getStewardState(key: string): string | undefined {
    const row = this.db
      .select({ value: stewardState.value })
      .from(stewardState)
      .where(eq(stewardState.key, key))
      .get()
    return row?.value
  }

  setStewardState(key: string, value: string): void {
    // `INSERT OR REPLACE` before the conversion. `steward_state` is
    // `(key PRIMARY KEY, value NOT NULL)` and carries no second uniqueness
    // constraint — checked in schema.ts and in the baseline migration — so the
    // conflict target is unambiguous and there is no third column for a replace
    // to have blanked (spec rule 27, amended checklist item 1).
    this.db
      .insert(stewardState)
      .values({ key, value })
      .onConflictDoUpdate({ target: stewardState.key, set: { value } })
      .run()
  }

  /**
   * Claim the janitor-owned steward cadence once, seeding it at the event-log
   * head in the same transaction.
   *
   * Source-run deployments retired the server timer before they gained the
   * supervisor-owned janitor. Their old cursor can therefore be weeks behind
   * even though the steward was intentionally dark. Replaying that history on
   * the first installed boot violates the existing first-enable contract and,
   * on a mature database, can monopolize the server loop for tens of seconds.
   *
   * Returns the seeded head only for the caller that made the claim. A crash
   * cannot leave a new cursor without its ownership watermark (or vice versa).
   */
  activateJanitorSteward(): number | undefined {
    return this.transact(() => {
      const ownershipKey = 'janitor-ownership-v1'
      const owned = this.db
        .select({ present: sql<number>`1` })
        .from(stewardState)
        .where(eq(stewardState.key, ownershipKey))
        .get()
      if (owned) return undefined
      const head = this.maxEventId()
      this.setStewardState('cursor', String(head))
      this.setStewardState(ownershipKey, String(head))
      return head
    })
  }

  // ---- event subscriptions (event-subscriptions design, Phase B) ----

  addSubscription(sub: Subscription): void {
    this.db
      .insert(subscriptions)
      .values({
        id: sub.id,
        subscriberKind: sub.subscriberKind,
        subscriberId: sub.subscriberId,
        event: sub.event,
        sourceKind: sub.sourceKind,
        sourceRef: sub.sourceRef,
        deliverNudge: sub.deliverNudge,
        deliverNotify: sub.deliverNotify,
        origin: sub.origin,
        enabled: sub.enabled,
        createdAt: sub.createdAt,
      })
      .run()
  }

  removeSubscription(id: string): void {
    this.db.delete(subscriptions).where(eq(subscriptions.id, id)).run()
  }

  listSubscriptions(filter?: { subscriberId?: string }): Subscription[] {
    const rows = this.db
      .select()
      .from(subscriptions)
      .where(filter?.subscriberId ? eq(subscriptions.subscriberId, filter.subscriberId) : undefined)
      .orderBy(asc(subscriptions.createdAt))
      .all()
    return rows.map(rowToSubscription)
  }

  /** Flip a subscription's enabled flag. Returns true when a row was updated. */
  setSubscriptionEnabled(id: string, enabled: boolean): boolean {
    const r = this.db.update(subscriptions).set({ enabled }).where(eq(subscriptions.id, id)).run()
    return r.changes > 0
  }

  getSubscription(id: string): Subscription | undefined {
    const row = this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).get()
    return row ? rowToSubscription(row) : undefined
  }

  listEnabledSubscriptions(): Subscription[] {
    const rows = this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.enabled, true))
      .orderBy(asc(subscriptions.createdAt))
      .all()
    return rows.map(rowToSubscription)
  }

  /** Record a (subscription, event) delivery. Returns true only when the pair was
   *  NEWLY inserted — a replay (or a same-poll double-match) returns false so the
   *  steward delivers exactly once. */
  markDelivered(subscriptionId: string, eventId: number): boolean {
    // `INSERT OR IGNORE` before the conversion, and EQUIVALENT here (spec rule
    // 31), which matters because this RETURN VALUE is the steward's
    // exactly-once guard. The forms differ only on NOT NULL and CHECK:
    // `subscription_deliveries` is `(subscription_id TEXT NOT NULL, event_id
    // INTEGER NOT NULL, PRIMARY KEY (subscription_id, event_id))` with no CHECK
    // and no foreign key, and its one production caller (`steward.ts`) passes a
    // subscription id and an event id that are both non-nullable. So the
    // primary-key conflict is the only thing OR IGNORE could have suppressed,
    // and `changes > 0` keeps meaning exactly what it meant.
    const r = this.db
      .insert(subscriptionDeliveries)
      .values({ subscriptionId, eventId })
      .onConflictDoNothing()
      .run()
    return Number(r.changes) > 0
  }
}
