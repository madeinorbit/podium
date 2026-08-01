/**
 * Sync aggregate — owns the durable read/write sync machinery:
 * the feed's identity (`feed_identity`, ADR 2 D1), the metadata oplog (`changes`,
 * docs/spec/oplog-read-path.md), the outbox write path (`applied_mutations` +
 * `queued_messages`, docs/spec/outbox-write-path.md) and the node⇄hub
 * issue-write outbox (`upstream_outbox` — ARCHIVED at POD-309: read-only, see
 * `listParkedUpstreamMutations`).
 */

import type { SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import { type SqlDatabase, type SqlParam, transaction } from '@podium/runtime/sqlite'
import type { ChangePrunePlan } from '../../change-log'

export class SyncRepository {
  constructor(private readonly db: SqlDatabase) {}

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — the whole batch commits inside BEGIN IMMEDIATE, so no interleaving).
   * The caller (Ledger) has already deduped; rows arrive only for real changes.
   */
  appendChanges(
    rows: { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }[],
    eventTime: number,
  ): number[] {
    if (rows.length === 0) return []
    const seqs: number[] = []
    // Stay below SQLite's conservative 999-parameter builds (100 × 5 = 500)
    // while collapsing a live-scale reconcile from hundreds of statements to a
    // handful. One outer transaction preserves the contiguous, non-interleaved
    // sequence contract across every chunk.
    const chunkSize = 100
    transaction(this.db, () => {
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize)
        const params: SqlParam[] = []
        for (const row of chunk) {
          params.push(row.entity, row.entityId, row.op, row.payload, eventTime)
        }
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')
        const result = this.db
          .prepare(
            `INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES ${placeholders}`,
          )
          .run(...params)
        const last = Number(result.lastInsertRowid)
        const first = last - chunk.length + 1
        for (let i = 0; i < chunk.length; i++) seqs.push(first + i)
      }
    })
    return seqs
  }

  /** Highest assigned seq ever (survives head-pruning via sqlite_sequence). 0 = none. */
  maxChangeSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get() as
      | { seq: number }
      | undefined
    return row?.seq ?? 0
  }

  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): number | null {
    const row = this.db.prepare('SELECT MIN(seq) AS seq FROM changes').get() as {
      seq: number | null
    }
    return row.seq
  }

  /**
   * Change rows with seq > cursor, in seq order. The CALLER decides whether the
   * cursor is still within the retained range (see Ledger.changesSince) —
   * this is a plain range read.
   */
  changesSince(
    cursor: number,
    limit = 10_000,
  ): { seq: number; entity: string; entityId: string; op: string; payload: string | null }[] {
    const rows = this.db
      .prepare(
        'SELECT seq, entity, entity_id, op, payload FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(cursor, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      entity: r.entity as string,
      entityId: r.entity_id as string,
      op: r.op as string,
      payload: (r.payload as string | null) ?? null,
    }))
  }

  /**
   * Head-only retention: drop rows beyond the row budget (keep the newest
   * `keepRows`) OR older than the age budget — whichever deletes MORE. The old
   * AND-policy never pruned under sustained write rates (rows aged past 14 days
   * only after the table had grown unboundedly for weeks). Deletion is still
   * head-only: we compute the highest seq that satisfies either budget and delete
   * snapshot it once per job, so even the indexed age-threshold scan does not
   * recur inside every bounded delete unit. Rows appended after the snapshot are
   * intentionally handled by the next job.
   */
  planChangePrune(opts: { keepRows: number; maxAgeMs: number; now: number }): ChangePrunePlan {
    const rowCapSeq = this.maxChangeSeq() - opts.keepRows
    const aged = this.db
      .prepare(
        'SELECT MAX(seq) AS seq FROM changes INDEXED BY changes_event_time WHERE event_time < ?',
      )
      .get(opts.now - opts.maxAgeMs) as { seq: number | null }
    return { thresholdSeq: Math.max(rowCapSeq, aged.seq ?? 0) }
  }

  /** [spec:SP-c29e] One bounded DELETE using the indexed seq primary key. */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize = 500): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    if (plan.thresholdSeq <= 0) return 0
    const result = this.db
      .prepare(
        `DELETE FROM changes
         WHERE seq IN (
           SELECT seq FROM changes WHERE seq <= ? ORDER BY seq ASC LIMIT ?
         )`,
      )
      .run(plan.thresholdSeq, batchSize)
    return Number(result.changes)
  }

  /**
   * Fold the retained log to the latest state per (entity, id) — the boot seed for
   * the Ledger's dedup baseline, so a restart emits deltas for anything that
   * changed while the server was down instead of silently rebasing.
   */
  latestChangeStates(): {
    seq: number
    entity: string
    entityId: string
    op: string
    payload: string | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT c.seq, c.entity, c.entity_id, c.op, c.payload FROM changes c
         JOIN (SELECT entity, entity_id, MAX(seq) AS seq FROM changes GROUP BY entity, entity_id) m
           ON m.entity = c.entity AND m.entity_id = c.entity_id AND m.seq = c.seq
         ORDER BY c.seq`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      entity: r.entity as string,
      entityId: r.entity_id as string,
      op: r.op as string,
      payload: (r.payload as string | null) ?? null,
    }))
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(mutationId: string): string | undefined {
    const row = this.db
      .prepare('SELECT result FROM applied_mutations WHERE mutation_id = ?')
      .get(mutationId) as { result: string } | undefined
    return row?.result
  }

  recordAppliedMutation(mutationId: string, proc: string, result: string, appliedAt: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO applied_mutations (mutation_id, proc, result, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run(mutationId, proc, result, appliedAt)
  }

  pruneAppliedMutations(opts: { maxAgeMs: number; now: number }): void {
    this.db
      .prepare('DELETE FROM applied_mutations WHERE applied_at < ?')
      .run(opts.now - opts.maxAgeMs)
  }

  /** Enqueue a message; the id IS the mutationId, so a replayed enqueue is a no-op.
   *  Returns false when the id already existed (replay). */
  enqueueMessage(row: {
    id: string
    sessionId: string
    text: string
    queuedAt: number
    inputOrigin?: ObservationInputOrigin
    principalKind?: 'user' | 'agent' | 'system'
    principalRef?: string
    delegationRef?: string | null
    actorKind?: 'user' | 'agent' | 'system'
    actorId?: string
    onBehalfOf?: string | null
    sourceMessageId?: string | null
  }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO queued_messages
          (id, session_id, text, queued_at, input_origin, principal_kind,
           principal_ref, delegation_ref, actor_kind, actor_id, on_behalf_of,
           source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.sessionId,
        row.text,
        row.queuedAt,
        row.inputOrigin ?? 'unknown',
        row.principalKind ?? 'system',
        row.principalRef ?? 'legacy-session-inbox',
        row.delegationRef ?? null,
        row.actorKind ?? 'system',
        row.actorId ?? 'legacy-session-inbox',
        row.onBehalfOf ?? null,
        row.sourceMessageId ?? null,
      )
    return Number(r.changes) > 0
  }

  /** FIFO head-first queue for one session. */
  listQueuedMessages(sessionId: string): {
    id: string
    text: string
    attempts: number
    inputOrigin: ObservationInputOrigin
    principalKind: 'user' | 'agent' | 'system'
    principalRef: string
    delegationRef: string | null
    actorKind: 'user' | 'agent' | 'system'
    actorId: string
    onBehalfOf: string | null
    sourceMessageId: string | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, attempts, input_origin, principal_kind, principal_ref,
                delegation_ref, actor_kind, actor_id, on_behalf_of, source_message_id
           FROM queued_messages WHERE session_id = ?
          ORDER BY queued_at ASC, rowid ASC`,
      )
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      attempts: r.attempts as number,
      inputOrigin: (r.input_origin as ObservationInputOrigin | null) ?? 'unknown',
      principalKind: r.principal_kind as 'user' | 'agent' | 'system',
      principalRef: r.principal_ref as string,
      delegationRef: (r.delegation_ref as string | null) ?? null,
      actorKind: r.actor_kind as 'user' | 'agent' | 'system',
      actorId: r.actor_id as string,
      onBehalfOf: (r.on_behalf_of as string | null) ?? null,
      sourceMessageId: (r.source_message_id as string | null) ?? null,
    }))
  }

  /** Per-session queued counts — the boot seed for Session.queuedMessageCount. */
  queuedMessageCounts(): Map<SessionId, number> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) AS n FROM queued_messages GROUP BY session_id')
      // SERIALIZATION EDGE: an untyped column re-entering the session id space.
      .all() as { session_id: SessionId; n: number }[]
    return new Map(rows.map((r) => [r.session_id, r.n]))
  }

  deleteQueuedMessage(id: string): void {
    this.db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id)
  }

  bumpQueuedAttempts(id: string): void {
    this.db.prepare('UPDATE queued_messages SET attempts = attempts + 1 WHERE id = ?').run(id)
  }

  /** Drop a dead session's queue (kill without resume ref, permanent delete). */
  deleteQueuedMessagesForSession(sessionId: string): void {
    this.db.prepare('DELETE FROM queued_messages WHERE session_id = ?').run(sessionId)
  }

  // ---- ARCHIVED: the retired node→hub issue-write outbox (POD-309) ----

  /**
   * Rows still sitting in `upstream_outbox` — issue mutations a NODE queued for a hub
   * it could not reach, at the moment federation was deferred ([spec:SP-0371]).
   *
   * The enqueue / delete / attempt-bump half of this table is GONE with
   * `UpstreamForwarder`; this read survives alone, and deliberately. ADR 5 D8 permits
   * archiving the schema but forbids "silent discard of poison/pending work", so the
   * rows are parked exactly where they are and `reportParkedUpstreamMutations` (server
   * boot) tells the operator they exist. A read with no writer cannot resurrect the
   * forwarding path; a table quietly dropped would have taken the evidence with it.
   */
  listParkedUpstreamMutations(): { mutationId: string; proc: string; queuedAt: number }[] {
    const rows = this.db
      .prepare(
        'SELECT mutation_id, proc, queued_at FROM upstream_outbox ORDER BY queued_at ASC, rowid ASC',
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      mutationId: r.mutation_id as string,
      proc: r.proc as string,
      queuedAt: Number(r.queued_at),
    }))
  }

  // ---- feed identity (ADR 2 D1) ----

  /**
   * The durable half of `FeedIdentityStore`, so the kernel port has a real
   * implementation rather than only a shape.
   *
   * The kernel owns the SEMANTICS — minting, the never-a-counter rule, and the
   * refusal to bump to the epoch it is replacing — and this owns only the row.
   * That split is why `assertOpaqueEpoch` is not repeated here: a second copy of
   * the rule in SQL would be a second definition able to disagree with the first,
   * and the one that runs would depend on which door the write came through.
   */
  readFeedIdentity(): { feedId: string; epoch: string } | null {
    const row = this.db
      .prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1')
      .get() as { feed_id: string; epoch: string } | undefined
    return row === undefined ? null : { feedId: row.feed_id, epoch: row.epoch }
  }

  /**
   * Persist the identity. UPSERT on the singleton key, so a bump REPLACES rather
   * than appends: there is exactly one current generation, and a table that could
   * hold two would leave "which epoch is this feed on?" answered by whichever row
   * a query happened to return first.
   */
  writeFeedIdentity(identity: { feedId: string; epoch: string }, mintedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?) ' +
          'ON CONFLICT(singleton) DO UPDATE SET feed_id = excluded.feed_id, ' +
          'epoch = excluded.epoch, minted_at = excluded.minted_at',
      )
      .run(identity.feedId, identity.epoch, mintedAt)
  }
}
