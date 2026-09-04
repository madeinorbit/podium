/**
 * Locks aggregate [spec:SP-85d1] — owns the `locks` and `lock_waiters` tables
 * (advisory named lease locks, migration 011). Pure persistence: lease/queue
 * SEMANTICS (grant, renew, FIFO advance, expiry sweep, steal) live in
 * modules/lock/service.ts.
 */

import type { IssueId, RepoId, SessionId } from '@podium/model'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { locks, lockWaiters } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/** Waiter session sentinel for direct-HTTP operator callers (no session id). */
export const OPERATOR_LOCK_SESSION = 'operator'

/**
 * A lock holder's / waiter's key (POD-362): a real `SessionId`, or a documented
 * non-session identity —
 * {@link OPERATOR_LOCK_SESSION} here, and `UNKNOWN_RELAY_SESSION` in
 * `modules/lock/registry.ts` (a relayed caller the live map does not know, kept
 * distinct from the operator's null so it can never release an operator lock),
 * plus `system:<job>` for an in-process server job that no transport can mint.
 *
 * A UNION, not `SessionId`: this file's own `sessionAlive` check special-cases
 * the operator sentinel precisely because it is not a session, so branding it
 * would launder a non-id into the session space. Same discipline as the
 * `MachineId` 'local' carve-out.
 */
export type SystemLockSession = `system:${string}`
export type LockSessionKey =
  | SessionId
  | typeof OPERATOR_LOCK_SESSION
  | 'unknown-session'
  | SystemLockSession

export function isSystemLockSession(value: LockSessionKey): value is SystemLockSession {
  return value.startsWith('system:')
}

export interface LockRow {
  repoId: RepoId
  name: string
  /** NULL = held by the operator (no session to bind the lease to). */
  holderSessionId: LockSessionKey | null
  holderIssueId: IssueId | null
  holderLabel: string
  note: string | null
  acquiredAt: string
  expiresAt: string
}

export interface LockWaiterRow {
  /** rowid — FIFO queue order. */
  id: number
  repoId: RepoId
  name: string
  sessionId: LockSessionKey
  issueId: IssueId | null
  label: string
  ttlSeconds: number
  note: string | null
  enqueuedAt: string
}

/**
 * THE ONE DECISION THIS FILE'S MAPPING STILL MAKES [spec §6 rule 6].
 *
 * `locks.holder_session_id` and `lock_waiters.session_id` are `$type<SessionId>`
 * in the schema, and the domain type is the {@link LockSessionKey} UNION: a real
 * session, the operator sentinel, the unknown-relay sentinel, or `system:<job>`.
 *
 * READING widens and needs nothing — `SessionId` is one member of the union, so
 * drizzle's own row type is assignable to {@link LockRow} as it stands, which is
 * why the per-column mapper this file used to carry is gone rather than ported.
 *
 * WRITING narrows, and that is the decision: storing `'operator'` or
 * `'system:steward'` in a column the schema brands `SessionId` is deliberate and
 * documented (POD-362), not an accident of an untyped driver. It is spelled here,
 * once, so the two write sites do not each re-argue it.
 */
const asColumnSession = (key: LockSessionKey): SessionId => key as SessionId

export class LocksRepository {
  private readonly rootDb: SyncDrizzle
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

  getLock(repoId: RepoId, name: string): LockRow | null {
    return (
      this.db
        .select()
        .from(locks)
        .where(and(eq(locks.repoId, repoId), eq(locks.name, name)))
        .get() ?? null
    )
  }

  listLocks(repoId: RepoId): LockRow[] {
    return this.db
      .select()
      .from(locks)
      .where(eq(locks.repoId, repoId))
      .orderBy(asc(locks.name))
      .all()
  }

  /** Locks in `repoId` whose lease has expired at `nowIso` (lazy-expiry sweep). */
  listExpiredLocks(repoId: RepoId, nowIso: string): LockRow[] {
    // INCLUSIVE at the instant: a lease expiring exactly now is expired.
    return this.db
      .select()
      .from(locks)
      .where(and(eq(locks.repoId, repoId), lte(locks.expiresAt, nowIso)))
      .all()
  }

  /** Every lock a session currently holds (session-bound auto-release). */
  listLocksHeldBySession(sessionId: LockSessionKey): LockRow[] {
    // EQUALITY, not `IS` — and unlike {@link renewLock} that is the point: a
    // NULL holder is the operator's lease, and the session-exit sweep must not
    // pick it up. The two predicates in this file differ on purpose.
    return this.db
      .select()
      .from(locks)
      .where(eq(locks.holderSessionId, asColumnSession(sessionId)))
      .all()
  }

  /** Write (insert or replace) the current lease for (repo_id, name). */
  upsertLock(row: LockRow): void {
    const values = {
      repoId: row.repoId,
      name: row.name,
      holderSessionId: row.holderSessionId === null ? null : asColumnSession(row.holderSessionId),
      holderIssueId: row.holderIssueId,
      holderLabel: row.holderLabel,
      note: row.note,
      acquiredAt: row.acquiredAt,
      expiresAt: row.expiresAt,
    }
    this.db
      .insert(locks)
      .values(values)
      .onConflictDoUpdate({
        target: [locks.repoId, locks.name],
        set: {
          holderSessionId: values.holderSessionId,
          holderIssueId: values.holderIssueId,
          holderLabel: values.holderLabel,
          note: values.note,
          acquiredAt: values.acquiredAt,
          expiresAt: values.expiresAt,
        },
      })
      .run()
  }

  /** Extend the current lease. Guarded on the holder session (atomic renew —
   *  same shape as claimIssueMessage): false when the caller no longer holds it. */
  renewLock(
    repoId: RepoId,
    name: string,
    holderSessionId: LockSessionKey | null,
    expiresAt: string,
  ): boolean {
    // `IS`, NOT `eq`, and it is load-bearing: the operator's lease has a NULL
    // holder, `= NULL` matches no row, and an operator lock would then be
    // unrenewable and expire under its holder. A `sql` FRAGMENT rather than a
    // conditional `isNull`/`eq` so this stays ONE statement text — the branch
    // would put two entries in the statement cache for one call site.
    const r = this.db
      .update(locks)
      .set({ expiresAt })
      .where(
        and(
          eq(locks.repoId, repoId),
          eq(locks.name, name),
          sql`${locks.holderSessionId} IS ${holderSessionId}`,
        ),
      )
      .run()
    return r.changes === 1
  }

  deleteLock(repoId: RepoId, name: string): void {
    this.db
      .delete(locks)
      .where(and(eq(locks.repoId, repoId), eq(locks.name, name)))
      .run()
  }

  /** FIFO queue for one lock, in grant order. */
  listWaiters(repoId: RepoId, name: string): LockWaiterRow[] {
    return this.db
      .select()
      .from(lockWaiters)
      .where(and(eq(lockWaiters.repoId, repoId), eq(lockWaiters.name, name)))
      .orderBy(asc(lockWaiters.id))
      .all()
  }

  /** Enqueue a waiter. Idempotent per (repo_id, name, session_id): re-acquiring
   *  while queued updates the requested lease metadata in place, preserving
   *  the original row id, timestamp, and FIFO position. */
  enqueueWaiter(w: Omit<LockWaiterRow, 'id'>): void {
    this.db
      .insert(lockWaiters)
      .values({
        repoId: w.repoId,
        name: w.name,
        sessionId: asColumnSession(w.sessionId),
        issueId: w.issueId,
        label: w.label,
        ttlSeconds: w.ttlSeconds,
        note: w.note,
        enqueuedAt: w.enqueuedAt,
      })
      .onConflictDoUpdate({
        target: [lockWaiters.repoId, lockWaiters.name, lockWaiters.sessionId],
        // TWO COLUMNS AND ONLY TWO. `label`, `issue_id` and `enqueued_at` are
        // deliberately absent: a re-acquire updates what the waiter is asking
        // for, never its identity or its place in the queue.
        set: { ttlSeconds: w.ttlSeconds, note: w.note },
      })
      .run()
  }

  removeWaiter(id: number): void {
    this.db.delete(lockWaiters).where(eq(lockWaiters.id, id)).run()
  }

  removeWaiterBySession(repoId: RepoId, name: string, sessionId: LockSessionKey): void {
    this.db
      .delete(lockWaiters)
      .where(
        and(
          eq(lockWaiters.repoId, repoId),
          eq(lockWaiters.name, name),
          eq(lockWaiters.sessionId, asColumnSession(sessionId)),
        ),
      )
      .run()
  }

  /** Locks a session is queued on (session-exit queue pruning). */
  listWaitsBySession(sessionId: SessionId): LockWaiterRow[] {
    return this.db
      .select()
      .from(lockWaiters)
      .where(eq(lockWaiters.sessionId, sessionId))
      .orderBy(asc(lockWaiters.id))
      .all()
  }
}
