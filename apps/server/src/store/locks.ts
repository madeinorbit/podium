/**
 * Locks aggregate [spec:SP-85d1] — owns the `locks` and `lock_waiters` tables
 * (advisory named lease locks, migration 011). Pure persistence: lease/queue
 * SEMANTICS (grant, renew, FIFO advance, expiry sweep, steal) live in
 * modules/lock/service.ts.
 */

import type { IssueId, RepoId, SessionId } from '@podium/model'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { locks, lockWaiters } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

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
 * POLYMORPHIC WRITE BRAND DECODE. Writing narrows, and that is the decision:
 * storing `'operator'` or
 * `'system:steward'` in a column the schema brands `SessionId` is deliberate and
 * documented (POD-362), not an accident of an untyped driver. It is spelled here,
 * once, so the two write sites do not each re-argue it.
 */
const asColumnSession = (key: LockSessionKey): SessionId => key as SessionId

// Every query this repository runs, prepared once per store [POD-6147].

const lockIs = () =>
  and(eq(locks.repoId, param(locks.repoId, 'repoId')), eq(locks.name, param(locks.name, 'name')))

const lockByName = prepared((db: StoreDrizzle) => db.select().from(locks).where(lockIs()).prepare())

const locksOfRepo = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(locks)
    .where(eq(locks.repoId, param(locks.repoId, 'repoId')))
    .orderBy(asc(locks.name))
    .prepare(),
)

// INCLUSIVE at the instant: a lease expiring exactly now is expired.
const expiredLocksOfRepo = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(locks)
    .where(and(eq(locks.repoId, param(locks.repoId, 'repoId')), lte(locks.expiresAt, param(locks.expiresAt, 'nowIso'))))
    .prepare(),
)

// EQUALITY, not `IS` — and unlike `renewLockOf` that is the point: a NULL
// holder is the operator's lease, and the session-exit sweep must not pick it
// up. The two predicates in this file differ on purpose.
const locksHeldBy = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(locks)
    .where(eq(locks.holderSessionId, param(locks.holderSessionId, 'sessionId')))
    .prepare(),
)

const upsertLockRow = prepared((db: StoreDrizzle) =>
  db
    .insert(locks)
    .values({
      repoId: sql.placeholder('repoId'),
      name: sql.placeholder('name'),
      holderSessionId: sql.placeholder('holderSessionId'),
      holderIssueId: sql.placeholder('holderIssueId'),
      holderLabel: sql.placeholder('holderLabel'),
      note: sql.placeholder('note'),
      acquiredAt: sql.placeholder('acquiredAt'),
      expiresAt: sql.placeholder('expiresAt'),
    })
    .onConflictDoUpdate({
      target: [locks.repoId, locks.name],
      set: {
        holderSessionId: sql.placeholder('holderSessionId'),
        holderIssueId: sql.placeholder('holderIssueId'),
        holderLabel: sql.placeholder('holderLabel'),
        note: sql.placeholder('note'),
        acquiredAt: sql.placeholder('acquiredAt'),
        expiresAt: sql.placeholder('expiresAt'),
      },
    })
    .prepare(),
)

// `IS`, NOT `eq`, and it is load-bearing: the operator's lease has a NULL
// holder, `= NULL` matches no row, and an operator lock would then be
// unrenewable and expire under its holder. A `sql` FRAGMENT rather than a
// conditional `isNull`/`eq` so this stays ONE statement text — the branch
// would put two entries in the statement cache for one call site.
const renewLockOf = prepared((db: StoreDrizzle) =>
  db
    .update(locks)
    .set({ expiresAt: sql.placeholder('expiresAt') })
    .where(and(lockIs(), sql`${locks.holderSessionId} IS ${sql.placeholder('holderSessionId')}`))
    .prepare(),
)

const deleteLockRow = prepared((db: StoreDrizzle) => db.delete(locks).where(lockIs()).prepare())

const waitersOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(lockWaiters)
    .where(and(eq(lockWaiters.repoId, param(lockWaiters.repoId, 'repoId')), eq(lockWaiters.name, param(lockWaiters.name, 'name'))))
    .orderBy(asc(lockWaiters.id))
    .prepare(),
)

const enqueueWaiterRow = prepared((db: StoreDrizzle) =>
  db
    .insert(lockWaiters)
    .values({
      repoId: sql.placeholder('repoId'),
      name: sql.placeholder('name'),
      sessionId: sql.placeholder('sessionId'),
      issueId: sql.placeholder('issueId'),
      label: sql.placeholder('label'),
      ttlSeconds: sql.placeholder('ttlSeconds'),
      note: sql.placeholder('note'),
      enqueuedAt: sql.placeholder('enqueuedAt'),
    })
    .onConflictDoUpdate({
      target: [lockWaiters.repoId, lockWaiters.name, lockWaiters.sessionId],
      // TWO COLUMNS AND ONLY TWO. `label`, `issue_id` and `enqueued_at` are
      // deliberately absent: a re-acquire updates what the waiter is asking
      // for, never its identity or its place in the queue.
      set: { ttlSeconds: sql.placeholder('ttlSeconds'), note: sql.placeholder('note') },
    })
    .prepare(),
)

const deleteWaiterById = prepared((db: StoreDrizzle) =>
  db.delete(lockWaiters).where(eq(lockWaiters.id, param(lockWaiters.id, 'id'))).prepare(),
)

const deleteWaiterOfSession = prepared((db: StoreDrizzle) =>
  db
    .delete(lockWaiters)
    .where(
      and(
        eq(lockWaiters.repoId, param(lockWaiters.repoId, 'repoId')),
        eq(lockWaiters.name, param(lockWaiters.name, 'name')),
        eq(lockWaiters.sessionId, param(lockWaiters.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const waitsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(lockWaiters)
    .where(eq(lockWaiters.sessionId, param(lockWaiters.sessionId, 'sessionId')))
    .orderBy(asc(lockWaiters.id))
    .prepare(),
)

export class LocksRepository {
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

  async getLock(repoId: RepoId, name: string): Promise<LockRow | null> {
    return (
      await lockByName(this.db).get({ repoId, name }) ?? null
    )
  }

  async listLocks(repoId: RepoId): Promise<LockRow[]> {
    return await locksOfRepo(this.db).all({ repoId })
  }

  /** Locks in `repoId` whose lease has expired at `nowIso` (lazy-expiry sweep). */
  async listExpiredLocks(repoId: RepoId, nowIso: string): Promise<LockRow[]> {
    // INCLUSIVE at the instant (see `expiredLocksOfRepo`).
    return await expiredLocksOfRepo(this.db).all({ repoId, nowIso })
  }

  /** Every lock a session currently holds (session-bound auto-release). */
  async listLocksHeldBySession(sessionId: LockSessionKey): Promise<LockRow[]> {
    // EQUALITY, not `IS` (see `locksHeldBy` and {@link renewLock}).
    return await locksHeldBy(this.db).all({ sessionId: asColumnSession(sessionId) })
  }

  /** Write (insert or replace) the current lease for (repo_id, name). */
  async upsertLock(row: LockRow): Promise<void> {
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
    await upsertLockRow(this.db).run(values)
  }

  /** Extend the current lease. Guarded on the holder session (atomic renew —
   *  same shape as claimIssueMessage): false when the caller no longer holds it. */
  async renewLock(
    repoId: RepoId,
    name: string,
    holderSessionId: LockSessionKey | null,
    expiresAt: string,
  ): Promise<boolean> {
    // `IS`, NOT `eq`, and it is load-bearing (see `renewLockOf`).
    const r = await renewLockOf(this.db).run({ repoId, name, holderSessionId, expiresAt })
    return r.changes === 1
  }

  async deleteLock(repoId: RepoId, name: string): Promise<void> {
    await deleteLockRow(this.db).run({ repoId, name })
  }

  /** FIFO queue for one lock, in grant order. */
  async listWaiters(repoId: RepoId, name: string): Promise<LockWaiterRow[]> {
    return await waitersOf(this.db).all({ repoId, name })
  }

  /** Enqueue a waiter. Idempotent per (repo_id, name, session_id): re-acquiring
   *  while queued updates the requested lease metadata in place, preserving
   *  the original row id, timestamp, and FIFO position. */
  async enqueueWaiter(w: Omit<LockWaiterRow, 'id'>): Promise<void> {
    await enqueueWaiterRow(this.db).run({
      repoId: w.repoId,
      name: w.name,
      sessionId: asColumnSession(w.sessionId),
      issueId: w.issueId,
      label: w.label,
      ttlSeconds: w.ttlSeconds,
      note: w.note,
      enqueuedAt: w.enqueuedAt,
    })
  }

  async removeWaiter(id: number): Promise<void> {
    await deleteWaiterById(this.db).run({ id })
  }

  async removeWaiterBySession(repoId: RepoId, name: string, sessionId: LockSessionKey): Promise<void> {
    await deleteWaiterOfSession(this.db).run({
      repoId,
      name,
      sessionId: asColumnSession(sessionId),
    })
  }

  /** Locks a session is queued on (session-exit queue pruning). */
  async listWaitsBySession(sessionId: SessionId): Promise<LockWaiterRow[]> {
    return await waitsOfSession(this.db).all({ sessionId })
  }
}
