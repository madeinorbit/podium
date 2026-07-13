/**
 * Locks aggregate [spec:SP-85d1] — owns the `locks` and `lock_waiters` tables
 * (advisory named lease locks, migration 011). Pure persistence: lease/queue
 * SEMANTICS (grant, renew, FIFO advance, expiry sweep, steal) live in
 * modules/lock/service.ts.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Waiter session sentinel for direct-HTTP operator callers (no session id). */
export const OPERATOR_LOCK_SESSION = 'operator'

export interface LockRow {
  repoId: string
  name: string
  /** NULL = held by the operator (no session to bind the lease to). */
  holderSessionId: string | null
  holderIssueId: string | null
  holderLabel: string
  note: string | null
  acquiredAt: string
  expiresAt: string
}

export interface LockWaiterRow {
  /** rowid — FIFO queue order. */
  id: number
  repoId: string
  name: string
  sessionId: string
  issueId: string | null
  label: string
  enqueuedAt: string
}

export class LocksRepository {
  constructor(private readonly db: SqlDatabase) {}

  private mapLock(r: Record<string, unknown>): LockRow {
    return {
      repoId: r.repo_id as string,
      name: r.name as string,
      holderSessionId: (r.holder_session_id as string | null) ?? null,
      holderIssueId: (r.holder_issue_id as string | null) ?? null,
      holderLabel: r.holder_label as string,
      note: (r.note as string | null) ?? null,
      acquiredAt: r.acquired_at as string,
      expiresAt: r.expires_at as string,
    }
  }

  private mapWaiter(r: Record<string, unknown>): LockWaiterRow {
    return {
      id: r.id as number,
      repoId: r.repo_id as string,
      name: r.name as string,
      sessionId: r.session_id as string,
      issueId: (r.issue_id as string | null) ?? null,
      label: r.label as string,
      enqueuedAt: r.enqueued_at as string,
    }
  }

  getLock(repoId: string, name: string): LockRow | null {
    const r = this.db
      .prepare('SELECT * FROM locks WHERE repo_id = ? AND name = ?')
      .get(repoId, name) as Record<string, unknown> | undefined
    return r ? this.mapLock(r) : null
  }

  listLocks(repoId: string): LockRow[] {
    const rows = this.db
      .prepare('SELECT * FROM locks WHERE repo_id = ? ORDER BY name')
      .all(repoId) as Record<string, unknown>[]
    return rows.map((r) => this.mapLock(r))
  }

  /** Locks in `repoId` whose lease has expired at `nowIso` (lazy-expiry sweep). */
  listExpiredLocks(repoId: string, nowIso: string): LockRow[] {
    const rows = this.db
      .prepare('SELECT * FROM locks WHERE repo_id = ? AND expires_at <= ?')
      .all(repoId, nowIso) as Record<string, unknown>[]
    return rows.map((r) => this.mapLock(r))
  }

  /** Every lock a session currently holds (session-bound auto-release). */
  listLocksHeldBySession(sessionId: string): LockRow[] {
    const rows = this.db
      .prepare('SELECT * FROM locks WHERE holder_session_id = ?')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => this.mapLock(r))
  }

  /** Write (insert or replace) the current lease for (repo_id, name). */
  upsertLock(row: LockRow): void {
    this.db
      .prepare(
        `INSERT INTO locks
           (repo_id, name, holder_session_id, holder_issue_id, holder_label, note, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, name) DO UPDATE SET
           holder_session_id = excluded.holder_session_id,
           holder_issue_id = excluded.holder_issue_id,
           holder_label = excluded.holder_label,
           note = excluded.note,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        row.repoId,
        row.name,
        row.holderSessionId,
        row.holderIssueId,
        row.holderLabel,
        row.note,
        row.acquiredAt,
        row.expiresAt,
      )
  }

  /** Extend the current lease. Guarded on the holder session (atomic renew —
   *  same shape as claimIssueMessage): false when the caller no longer holds it. */
  renewLock(
    repoId: string,
    name: string,
    holderSessionId: string | null,
    expiresAt: string,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE locks SET expires_at = ?
         WHERE repo_id = ? AND name = ? AND holder_session_id IS ?`,
      )
      .run(expiresAt, repoId, name, holderSessionId)
    return r.changes === 1
  }

  deleteLock(repoId: string, name: string): void {
    this.db.prepare('DELETE FROM locks WHERE repo_id = ? AND name = ?').run(repoId, name)
  }

  /** FIFO queue for one lock, in grant order. */
  listWaiters(repoId: string, name: string): LockWaiterRow[] {
    const rows = this.db
      .prepare('SELECT * FROM lock_waiters WHERE repo_id = ? AND name = ? ORDER BY id')
      .all(repoId, name) as Record<string, unknown>[]
    return rows.map((r) => this.mapWaiter(r))
  }

  /** Enqueue a waiter. Idempotent per (repo_id, name, session_id): re-acquiring
   *  while queued keeps the original position (INSERT OR IGNORE). */
  enqueueWaiter(w: Omit<LockWaiterRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lock_waiters (repo_id, name, session_id, issue_id, label, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(w.repoId, w.name, w.sessionId, w.issueId, w.label, w.enqueuedAt)
  }

  removeWaiter(id: number): void {
    this.db.prepare('DELETE FROM lock_waiters WHERE id = ?').run(id)
  }

  removeWaiterBySession(repoId: string, name: string, sessionId: string): void {
    this.db
      .prepare('DELETE FROM lock_waiters WHERE repo_id = ? AND name = ? AND session_id = ?')
      .run(repoId, name, sessionId)
  }

  /** Locks a session is queued on (session-exit queue pruning). */
  listWaitsBySession(sessionId: string): LockWaiterRow[] {
    const rows = this.db
      .prepare('SELECT * FROM lock_waiters WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => this.mapWaiter(r))
  }
}
