/**
 * Sync aggregate — owns the durable read/write sync machinery:
 * the metadata oplog (`changes`, docs/spec/oplog-read-path.md), the outbox
 * write path (`applied_mutations` + `queued_messages`,
 * docs/spec/outbox-write-path.md) and the node⇄hub issue-write outbox
 * (`upstream_outbox`, docs/spec/node-hub-issues.md §2.2).
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export class SyncRepository {
  constructor(private readonly db: SqlDatabase) {}

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  /**
   * Append a batch of change rows in one transaction and return their assigned seqs
   * (contiguous — the whole batch commits inside BEGIN IMMEDIATE, so no interleaving).
   * The caller (MetadataOplog) has already diffed; rows arrive only for real changes.
   */
  appendChanges(
    rows: { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }[],
    eventTime: number,
  ): number[] {
    if (rows.length === 0) return []
    const insert = this.db.prepare(
      'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
    )
    const seqs: number[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        insert.run(r.entity, r.entityId, r.op, r.payload, eventTime)
        seqs.push(this.lastInsertSeq())
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return seqs
  }

  private lastInsertSeq(): number {
    return (this.db.prepare('SELECT last_insert_rowid() AS seq').get() as { seq: number }).seq
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
   * cursor is still within the retained range (see MetadataOplog.changesSince) —
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
   * everything at-or-below it, so the retained seq range stays contiguous (an
   * aged row can never be removed from the middle of the range).
   */
  pruneChanges(opts: { keepRows: number; maxAgeMs: number; now: number }): void {
    const rowCapSeq = this.maxChangeSeq() - opts.keepRows
    const aged = this.db
      .prepare('SELECT MAX(seq) AS seq FROM changes WHERE event_time < ?')
      .get(opts.now - opts.maxAgeMs) as { seq: number | null }
    const thresholdSeq = Math.max(rowCapSeq, aged.seq ?? 0)
    if (thresholdSeq <= 0) return
    this.db.prepare('DELETE FROM changes WHERE seq <= ?').run(thresholdSeq)
  }

  /**
   * Fold the retained log to the latest state per (entity, id) — the boot seed for
   * MetadataOplog's diff baseline, so a restart emits deltas for anything that
   * changed while the server was down instead of silently rebasing.
   */
  latestChangeStates(): { entity: string; entityId: string; op: string; payload: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT c.entity, c.entity_id, c.op, c.payload FROM changes c
         JOIN (SELECT entity, entity_id, MAX(seq) AS seq FROM changes GROUP BY entity, entity_id) m
           ON m.entity = c.entity AND m.entity_id = c.entity_id AND m.seq = c.seq`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
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
  enqueueMessage(row: { id: string; sessionId: string; text: string; queuedAt: number }): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO queued_messages (id, session_id, text, queued_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.id, row.sessionId, row.text, row.queuedAt)
    return Number(r.changes) > 0
  }

  /** FIFO head-first queue for one session. */
  listQueuedMessages(sessionId: string): { id: string; text: string; attempts: number }[] {
    const rows = this.db
      .prepare(
        'SELECT id, text, attempts FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC, rowid ASC',
      )
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      attempts: r.attempts as number,
    }))
  }

  /** Per-session queued counts — the boot seed for Session.queuedMessageCount. */
  queuedMessageCounts(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) AS n FROM queued_messages GROUP BY session_id')
      .all() as { session_id: string; n: number }[]
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

  // ---- upstream issue-write outbox (docs/spec/node-hub-issues.md §2.2) ----

  /** Enqueue an issue mutation bound for the hub. The mutationId IS the PK, so a
   *  replayed enqueue is a no-op. Returns false when the id already existed. */
  enqueueUpstreamMutation(row: {
    mutationId: string
    proc: string
    input: string
    queuedAt: number
  }): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO upstream_outbox (mutation_id, proc, input, queued_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.mutationId, row.proc, row.input, row.queuedAt)
    return Number(r.changes) > 0
  }

  /** The full outbox, FIFO (drain order — serial, oldest first). */
  listUpstreamOutbox(): { mutationId: string; proc: string; input: string; attempts: number }[] {
    const rows = this.db
      .prepare(
        'SELECT mutation_id, proc, input, attempts FROM upstream_outbox ORDER BY queued_at ASC, rowid ASC',
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      mutationId: r.mutation_id as string,
      proc: r.proc as string,
      input: r.input as string,
      attempts: r.attempts as number,
    }))
  }

  deleteUpstreamMutation(mutationId: string): void {
    this.db.prepare('DELETE FROM upstream_outbox WHERE mutation_id = ?').run(mutationId)
  }

  bumpUpstreamMutationAttempts(mutationId: string): void {
    this.db
      .prepare('UPDATE upstream_outbox SET attempts = attempts + 1 WHERE mutation_id = ?')
      .run(mutationId)
  }
}
