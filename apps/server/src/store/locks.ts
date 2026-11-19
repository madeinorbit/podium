// workspace-scoped (POD-6959)
/**
 * Locks aggregate [spec:SP-85d1] — owns the `locks` and `lock_waiters` tables
 * (advisory named lease locks, migration 011). Pure persistence: lease/queue
 * SEMANTICS (grant, renew, FIFO advance, expiry sweep, steal) live in
 * modules/lock/service.ts.
 */

import type { IssueId, RepoId, SessionId } from '@podium/model'
import { asc, eq, lte, sql } from 'drizzle-orm'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

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

const lockIs = (t: StoreTables) =>
  inWorkspace(
    t.locks,
    eq(t.locks.repoId, param(t.locks.repoId, 'repoId')),
    eq(t.locks.name, param(t.locks.name, 'name')),
  )

/** The lease's own columns: a read hands back no `workspace_id` (POD-6959). */
const lockColumns = (t: StoreTables) => ({
  repoId: t.locks.repoId,
  name: t.locks.name,
  holderSessionId: t.locks.holderSessionId,
  holderIssueId: t.locks.holderIssueId,
  holderLabel: t.locks.holderLabel,
  note: t.locks.note,
  acquiredAt: t.locks.acquiredAt,
  expiresAt: t.locks.expiresAt,
})

/** The waiter's own columns, likewise. */
const waiterColumns = (t: StoreTables) => ({
  id: t.lockWaiters.id,
  repoId: t.lockWaiters.repoId,
  name: t.lockWaiters.name,
  sessionId: t.lockWaiters.sessionId,
  issueId: t.lockWaiters.issueId,
  label: t.lockWaiters.label,
  ttlSeconds: t.lockWaiters.ttlSeconds,
  note: t.lockWaiters.note,
  enqueuedAt: t.lockWaiters.enqueuedAt,
})

const lockByName = prepared((db, t) =>
  db.select(lockColumns(t)).from(t.locks).where(lockIs(t)).prepare(),
)

const locksOfRepo = prepared((db, t) =>
  db
    .select(lockColumns(t))
    .from(t.locks)
    .where(inWorkspace(t.locks, eq(t.locks.repoId, param(t.locks.repoId, 'repoId'))))
    .orderBy(asc(t.locks.name))
    .prepare(),
)

// INCLUSIVE at the instant: a lease expiring exactly now is expired.
const expiredLocksOfRepo = prepared((db, t) =>
  db
    .select(lockColumns(t))
    .from(t.locks)
    .where(
      inWorkspace(
        t.locks,
        eq(t.locks.repoId, param(t.locks.repoId, 'repoId')),
        lte(t.locks.expiresAt, param(t.locks.expiresAt, 'nowIso')),
      ),
    )
    .prepare(),
)

// EQUALITY, not `IS` — and unlike `renewLockOf` that is the point: a NULL
// holder is the operator's lease, and the session-exit sweep must not pick it
// up. The two predicates in this file differ on purpose.
const locksHeldBy = prepared((db, t) =>
  db
    .select(lockColumns(t))
    .from(t.locks)
    .where(
      inWorkspace(
        t.locks,
        eq(t.locks.holderSessionId, param(t.locks.holderSessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const upsertLockRow = prepared((db, t) =>
  db
    .insert(t.locks)
    .values({
      workspaceId: WORKSPACE,
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
      target: [t.locks.workspaceId, t.locks.repoId, t.locks.name],
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

// `IS NOT DISTINCT FROM`, NOT `eq`, and it is load-bearing: the operator's
// lease has a NULL holder, `= NULL` matches no row, and an operator lock would
// then be unrenewable and expire under its holder. A `sql` FRAGMENT rather than
// a conditional `isNull`/`eq` so this stays ONE statement text — the branch
// would put two entries in the statement cache for one call site. Spelled out
// rather than SQLite's bare `IS ?`, which Postgres accepts only before NULL,
// TRUE or FALSE; SQLite reads the long form as `IS`.
const renewLockOf = prepared((db, t) =>
  db
    .update(t.locks)
    .set({ expiresAt: sql.placeholder('expiresAt') })
    .where(
      inWorkspace(
        t.locks,
        eq(t.locks.repoId, param(t.locks.repoId, 'repoId')),
        eq(t.locks.name, param(t.locks.name, 'name')),
        sql`${t.locks.holderSessionId} IS NOT DISTINCT FROM ${sql.placeholder('holderSessionId')}`,
      ),
    )
    .prepare(),
)

const deleteLockRow = prepared((db, t) => db.delete(t.locks).where(lockIs(t)).prepare())

const waitersOf = prepared((db, t) =>
  db
    .select(waiterColumns(t))
    .from(t.lockWaiters)
    .where(
      inWorkspace(
        t.lockWaiters,
        eq(t.lockWaiters.repoId, param(t.lockWaiters.repoId, 'repoId')),
        eq(t.lockWaiters.name, param(t.lockWaiters.name, 'name')),
      ),
    )
    .orderBy(asc(t.lockWaiters.id))
    .prepare(),
)

const enqueueWaiterRow = prepared((db, t) =>
  db
    .insert(t.lockWaiters)
    .values({
      workspaceId: WORKSPACE,
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
      target: [
        t.lockWaiters.workspaceId,
        t.lockWaiters.repoId,
        t.lockWaiters.name,
        t.lockWaiters.sessionId,
      ],
      // TWO COLUMNS AND ONLY TWO. `label`, `issue_id` and `enqueued_at` are
      // deliberately absent: a re-acquire updates what the waiter is asking
      // for, never its identity or its place in the queue.
      set: { ttlSeconds: sql.placeholder('ttlSeconds'), note: sql.placeholder('note') },
    })
    .prepare(),
)

const deleteWaiterById = prepared((db, t) =>
  db
    .delete(t.lockWaiters)
    .where(inWorkspace(t.lockWaiters, eq(t.lockWaiters.id, param(t.lockWaiters.id, 'id'))))
    .prepare(),
)

const deleteWaiterOfSession = prepared((db, t) =>
  db
    .delete(t.lockWaiters)
    .where(
      inWorkspace(
        t.lockWaiters,
        eq(t.lockWaiters.repoId, param(t.lockWaiters.repoId, 'repoId')),
        eq(t.lockWaiters.name, param(t.lockWaiters.name, 'name')),
        eq(t.lockWaiters.sessionId, param(t.lockWaiters.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const waitsOfSession = prepared((db, t) =>
  db
    .select(waiterColumns(t))
    .from(t.lockWaiters)
    .where(
      inWorkspace(
        t.lockWaiters,
        eq(t.lockWaiters.sessionId, param(t.lockWaiters.sessionId, 'sessionId')),
      ),
    )
    .orderBy(asc(t.lockWaiters.id))
    .prepare(),
)

export class LocksRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
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
  protected get db(): WorkspaceDb {
    return this.scope
  }

  async getLock(repoId: RepoId, name: string): Promise<LockRow | null> {
    return (await lockByName(this.db).get({ repoId, name })) ?? null
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
    // `IS NOT DISTINCT FROM`, NOT `eq`, and it is load-bearing (see `renewLockOf`).
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

  async removeWaiterBySession(
    repoId: RepoId,
    name: string,
    sessionId: LockSessionKey,
  ): Promise<void> {
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
