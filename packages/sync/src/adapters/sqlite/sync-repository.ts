/**
 * Sync aggregate — owns the durable read/write sync machinery:
 * the feed's identity (`feed_identity`, ADR 2 D1), the metadata oplog (`changes`,
 * docs/spec/oplog-read-path.md), the outbox write path (`applied_mutations` +
 * `queued_messages`, docs/spec/outbox-write-path.md) and the node⇄hub
 * issue-write outbox (`upstream_outbox` — ARCHIVED at POD-309: read-only, see
 * `listParkedUpstreamMutations`).
 *
 * `queued_messages` and `upstream_outbox` are the two tables this repository
 * READS BUT DOES NOT OWN: they are declared in `apps/server`'s schema, and a
 * package may not import from `apps/server`. So they are INJECTED — see
 * `./server-tables.ts` for why, and the constructor for what that buys.
 *
 * The CONNECTION arrives the same way and for the same reason: the store's
 * executor, narrowed to the one member this adapter uses, through
 * `./store-executor.ts` (POD-3338, spec §6 rule 20). Before that port this was
 * the only repository in the set still handed a raw `SqlDatabase`, because the
 * executor lives in `apps/server` and a package may not import an app.
 */

import { asMutationId, type MutationId, type SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import { transaction } from '@podium/runtime/sqlite'
import { getTableName } from 'drizzle-orm'
import type { ChangeLogReadRow, ChangeLogWriteRow } from '../../authority/change-lifecycle'
import type { ChangePrunePlan } from '../../change-log'
import type { SyncServerTables } from './server-tables'
import type { SyncSqlConnection, SyncSqlParam, SyncStoreExecutor } from './store-executor'

/**
 * A table identifier for interpolation into this repository's statements.
 *
 * The name comes from a drizzle schema object, never from a caller — the
 * quoting is here so that the identifier stays an identifier no matter what the
 * schema calls the table, not as protection against input that cannot reach it.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Map a raw `changes` SELECT row onto the composed lifecycle read shape. */
function mapChangeLogReadRow(r: Record<string, unknown>): ChangeLogReadRow {
  return {
    seq: r.seq as number,
    entity: r.entity as ChangeLogReadRow['entity'],
    entityId: r.entity_id as string,
    op: r.op as ChangeLogReadRow['op'],
    payload: (r.payload as string | null) ?? null,
  }
}

export class SyncRepository {
  /**
   * The latest-state fold is a snapshot of the retained change log. Visibility
   * callbacks can ask for several rows during one synchronous delivery, so
   * retaining the materialized rows avoids folding the same table once per
   * subject. The generation is also exposed to the composition root: a
   * re-entrant append must make its next authorization read build a new view.
   */
  private latestChangeStatesCache: ChangeLogReadRow[] | undefined
  private latestChangeStatesGenerationValue = 0

  /**
   * The two server-owned tables, resolved from the objects the composition root
   * hands in rather than spelled out in the SQL below. That is the whole point of
   * the injection: this file no longer names a table `apps/server` owns, so the
   * declaration stays single and the drizzle conversion (POD-3221 Stage A) has
   * the real table objects to build its queries from.
   */
  private readonly queuedMessagesTable: string
  private readonly upstreamOutboxTable: string

  /**
   * The connection this adapter's statements run on, resolved ONCE from the
   * executor's legacy handle.
   *
   * RESOLVED AT CONSTRUCTION, NOT PER STATEMENT, and the refusal below is why.
   * `legacy` is optional on the port because it is optional on the executor: a
   * fake or a remote driver has no `bun:sqlite` connection. An adapter built
   * over one has to fail HERE, where the stack still says what was mis-wired,
   * rather than at whichever statement happened to run first.
   *
   * IT IS ALSO THE SAME OBJECT the composition root's own spans run on, which
   * is what keeps `transaction()` nesting-safe across the boundary: the helper
   * keys its depth by handle identity, so a `SessionStore.transact` wrapping an
   * `appendChanges` still degrades the inner span to a savepoint.
   */
  private readonly db: SyncSqlConnection

  constructor(executor: SyncStoreExecutor, tables: SyncServerTables) {
    const connection = executor.legacy
    if (connection === undefined) {
      throw new TypeError(
        'SyncRepository needs the executor\'s legacy connection: this adapter still issues ' +
          'synchronous statements, and the executor it was given has no raw handle to issue ' +
          'them on (POD-3338).',
      )
    }
    this.db = connection
    this.queuedMessagesTable = quoteIdentifier(getTableName(tables.queuedMessages))
    this.upstreamOutboxTable = quoteIdentifier(getTableName(tables.upstreamOutbox))
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — the whole batch commits inside BEGIN IMMEDIATE, so no interleaving).
   * The caller (Ledger) has already deduped; rows arrive only for real changes.
   *
   * Row type is {@link ChangeLogWriteRow} — composed from the lifecycle shape,
   * not restated here (POD-1251).
   */
  appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): number[] {
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
        const params: SyncSqlParam[] = []
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
        this.applyLatestChangeStates(chunk, first)
      }
    })
    this.invalidateLatestChangeStatesCache()
    return seqs
  }

  /**
   * Advance the installed world (`change_latest`) for one appended chunk, INSIDE
   * the append's transaction — so the world can never describe a change the log
   * does not hold, or miss one it does.
   *
   * ROW BY ROW, IN ORDER, and that is not a missed batching opportunity: a batch
   * may legitimately carry `upsert` then `remove` for one entity (a first-sight
   * row that is gone by the end of the same reconcile), and grouping the two ops
   * into bulk statements would apply them in op order rather than log order —
   * leaving the removed entity installed. Sequenced statements inside one
   * transaction are what make "last write in the batch wins" true here for the
   * same reason it is true in the log.
   */
  private applyLatestChangeStates(rows: readonly ChangeLogWriteRow[], firstSeq: number): void {
    const upsert = this.db.prepare(
      `INSERT INTO change_latest (entity, entity_id, seq, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(entity, entity_id) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
    )
    const remove = this.db.prepare('DELETE FROM change_latest WHERE entity = ? AND entity_id = ?')
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ChangeLogWriteRow
      // A payload-less upsert is the corrupt row every reader of the fold already
      // skips, so the world it describes is "this entity is not installed" — which
      // is what the delete arm writes. Storing it instead would put a NULL where
      // the column says NOT NULL; keeping the PREVIOUS state would be worse still,
      // since the folded log never showed it once a corrupt row landed on top.
      if (row.op === 'upsert' && row.payload !== null) {
        upsert.run(row.entity, row.entityId, firstSeq + i, row.payload)
      } else {
        remove.run(row.entity, row.entityId)
      }
    }
  }

  /**
   * Monotonic generation for the installed-world view. It changes after every
   * append; callers use it to bound a larger per-pass index without caching
   * authorization data across a durable change.
   *
   * A PRUNE NO LONGER BUMPS IT (POD-678), because a prune no longer alters what
   * `latestChangeStates` returns — retention deletes from `changes`, and the world
   * lives in `change_latest`. Invalidating on prune would only throw away a valid
   * read cache on a timer.
   */
  latestChangeStatesGeneration(): number {
    return this.latestChangeStatesGenerationValue
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
  changesSince(cursor: number, limit = 10_000): ChangeLogReadRow[] {
    const rows = this.db
      .prepare(
        'SELECT seq, entity, entity_id, op, payload FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(cursor, limit) as Record<string, unknown>[]
    return rows.map((r) => mapChangeLogReadRow(r))
  }

  /**
   * Head-only retention: drop rows beyond the row budget (keep the newest
   * `keepRows`) OR older than the age budget — whichever deletes MORE. The old
   * AND-policy never pruned under sustained write rates (rows aged past the age
   * budget only after the table had grown unboundedly). Deletion is still
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

  /**
   * [spec:SP-c29e] One bounded DELETE using the indexed seq primary key.
   *
   * Touches `changes` ONLY. The installed world is not retained data — see
   * {@link latestChangeStates} — so a prune that also swept it would be deleting
   * the answer to "what is there?" in order to bound the answer to "what changed?".
   */
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
   * THE INSTALLED WORLD — the latest state per (entity, id): the boot seed for the
   * Ledger's dedup baseline (so a restart emits deltas for anything that changed
   * while the server was down instead of silently rebasing) and the bootstrap read
   * a client's whole world is built from.
   *
   * Read from `change_latest`, NOT folded from `changes` (POD-678). The fold over
   * the log was only ever as complete as retention left it, and retention is a
   * WINDOW: on the live install the 20k row budget bit after ~27 hours, so this
   * returned 66 of 631 issues and every client that attached afterwards resolved
   * the other 565 as unknown references. The projection is maintained by the one
   * writer that appends the log and is never pruned, so "what is there?" stops
   * depending on how recently it was written.
   *
   * ONLY LIVE UPSERTS come back, where the fold used to also return `remove`
   * tombstones. No consumer read them: the bootstrap, the baseline seed and the
   * visibility read cache all skip non-upsert rows before doing anything.
   */
  latestChangeStates(): ChangeLogReadRow[] {
    if (this.latestChangeStatesCache !== undefined) return this.latestChangeStatesCache
    const rows = this.db
      .prepare('SELECT seq, entity, entity_id, payload FROM change_latest ORDER BY seq')
      .all() as Record<string, unknown>[]
    this.latestChangeStatesCache = rows.map((r) => mapChangeLogReadRow({ ...r, op: 'upsert' }))
    return this.latestChangeStatesCache
  }

  private invalidateLatestChangeStatesCache(): void {
    this.latestChangeStatesCache = undefined
    this.latestChangeStatesGenerationValue++
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  /** The stored result of an already-applied mutation, or undefined if new. */
  getAppliedMutation(mutationId: MutationId): string | undefined {
    const row = this.db
      .prepare('SELECT result FROM applied_mutations WHERE mutation_id = ?')
      .get(mutationId) as { result: string } | undefined
    return row?.result
  }

  recordAppliedMutation(
    mutationId: MutationId,
    proc: string,
    result: string,
    appliedAt: number,
  ): void {
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
    sessionId: SessionId
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
        `INSERT OR IGNORE INTO ${this.queuedMessagesTable}
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
  listQueuedMessages(sessionId: SessionId): {
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
           FROM ${this.queuedMessagesTable} WHERE session_id = ?
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
      .prepare(
        `SELECT session_id, COUNT(*) AS n FROM ${this.queuedMessagesTable} GROUP BY session_id`,
      )
      // SERIALIZATION EDGE: an untyped column re-entering the session id space.
      .all() as { session_id: SessionId; n: number }[]
    return new Map(rows.map((r) => [r.session_id, r.n]))
  }

  deleteQueuedMessage(id: string): void {
    this.db.prepare(`DELETE FROM ${this.queuedMessagesTable} WHERE id = ?`).run(id)
  }

  bumpQueuedAttempts(id: string): void {
    this.db
      .prepare(`UPDATE ${this.queuedMessagesTable} SET attempts = attempts + 1 WHERE id = ?`)
      .run(id)
  }

  /** The count bounds how many copies ONE CLI process may be typed; a fresh PTY
   *  has received none of them, so a bind clears it (POD-1242). */
  resetQueuedAttempts(id: string): void {
    this.db.prepare(`UPDATE ${this.queuedMessagesTable} SET attempts = 0 WHERE id = ?`).run(id)
  }

  /** Drop a dead session's queue (kill without resume ref, permanent delete). */
  deleteQueuedMessagesForSession(sessionId: SessionId): void {
    this.db.prepare(`DELETE FROM ${this.queuedMessagesTable} WHERE session_id = ?`).run(sessionId)
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
  listParkedUpstreamMutations(): { mutationId: MutationId; proc: string; queuedAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT mutation_id, proc, queued_at FROM ${this.upstreamOutboxTable}
          ORDER BY queued_at ASC, rowid ASC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      mutationId: asMutationId(r.mutation_id as string),
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
