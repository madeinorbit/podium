/**
 * THE ACCOUNT ROLE READER (POD-1079) — the first reader the `users` table
 * (POD-1075) has had.
 *
 * `roleFloor` on a command contract is "which commands this principal may
 * ATTEMPT" (ADR 3 Amendment 1 D15), and the floor is compared against the
 * INSTANCE-LEVEL account role (ADR 9 D1.4), not against the per-command
 * capability role that already rides on the transport. Two different questions:
 * the capability says what this connection was granted, the account role says
 * what grade of person is behind it.
 *
 * Writes stay out of scope on purpose — invite / disable / remove are ADR 9
 * lifecycle commands and POD-290's, and a repository that could mint an admin
 * would be a privilege-escalation surface this issue has no use for.
 */

import type { CredentialSource, UserId, UserRole } from '@podium/model'
import { asUserId, CREDENTIAL_SOURCES, USER_ROLES } from '@podium/model'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { userCredentials, users } from '../migrations/schema'
import { currentReadScope, readScopeSlot } from './executor/read-scope'
import type { SyncDrizzle, SyncQueries } from './executor/sync-drizzle'

export interface UserAccountRow {
  id: string
  displayName: string
  role: UserRole
  createdAt: string
  /** ADR 9's disable-before-remove. A disabled account is not an actor. */
  disabledAt: string | null
}

/**
 * Role parsing FAILS CLOSED. A `role` column holding something this build does
 * not know — a third role written by a newer version — must not be admitted as
 * `admin`, and must not be silently downgraded to `member` either: it is
 * UNREADABLE, and an unreadable account satisfies no floor.
 */
const parseRole = (raw: unknown): UserRole | undefined =>
  typeof raw === 'string' && (USER_ROLES as readonly string[]).includes(raw)
    ? (raw as UserRole)
    : undefined

export interface UserCredentialRow {
  userId: UserId
  source: CredentialSource
  passwordHash: string | null
  updatedAt: string
}

export class UsersRepository {
  constructor(private readonly queries: SyncQueries) {}

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): SyncDrizzle {
    return this.queries.db
  }

  /**
   * Rule 34a — an arrow FIELD, not `this.transact = queries.transact`. The
   * straight assignment works only while the implementation ignores `this`, and
   * it stops working silently the moment it does not.
   */
  protected transact = <T>(fn: () => T): T => this.queries.transact(fn)

  /**
   * THE FRAME READ CACHE [POD-1931].
   *
   * Every authorization decision asks who the principal is, so the account read
   * rides the publish fan-out: one event-loop frame was measured issuing 1,221
   * `SELECT * FROM users WHERE id = ?` statements — against a table holding ONE
   * row. The answer was identical 1,221 times.
   *
   * An account cannot change inside a read scope, so the second read inside one
   * is the first read's answer.
   *
   * WHAT CHANGED [POD-3261]. The lifetime used to be a `queueMicrotask` — sound
   * only because a microtask cannot run inside a synchronous turn, which is to
   * say sound only while the store is synchronous, and dropped by the first
   * `await` anywhere in the fan-out this exists for. It is a {@link ReadScope}
   * slot now: a pass opens a scope around itself and the cache lives for the
   * scope, which becomes a real read lease at the flip. The microtask turn
   * survives only as the scope's fallback owner, in `read-scope.ts`.
   *
   * THE ACCOUNT READ IS AN AUTHORIZATION INPUT, and reading it through a slot
   * is the PER-PASS form of spec rule 18's open question. It is legitimate here
   * for a reason that does not extend to grants: `create` is the table's ONLY
   * writer in product code — there is no UPDATE or DELETE against `users`
   * anywhere — and it drops the cache, so the only mutation that exists is one
   * this cache already honours. A caller still gets its own object per call;
   * `undefined` is cached as an answer too, because "no account" is the verdict
   * every caller acts on.
   */
  private readonly accountsSlot = readScopeSlot(() => new Map<string, UserAccountRow | undefined>())

  private frameCache(): Map<string, UserAccountRow | undefined> {
    return currentReadScope().slot(this.accountsSlot)
  }

  /**
   * One account, or `undefined` when there is no row, the row is unreadable, or
   * the account is disabled. All three collapse to "no account", because every
   * caller's next move is the same — refuse — and giving the caller three arms
   * to get wrong is how one of them ends up permissive.
   */
  get(userId: UserId): UserAccountRow | undefined {
    const cache = this.frameCache()
    if (cache.has(userId)) {
      const hit = cache.get(userId)
      return hit === undefined ? undefined : { ...hit }
    }
    const account = this.read(userId)
    cache.set(userId, account)
    return account === undefined ? undefined : { ...account }
  }

  private read(userId: UserId): UserAccountRow | undefined {
    const r = this.db.select().from(users).where(eq(users.id, userId)).get()
    if (!r) return undefined
    const role = parseRole(r.role)
    if (role === undefined) return undefined
    const disabledAt = r.disabledAt
    if (disabledAt !== null) return undefined
    return {
      id: r.id,
      displayName: r.displayName,
      role,
      createdAt: r.createdAt,
      disabledAt,
    }
  }

  /** The account role, or `undefined` for an account that cannot act. */
  roleOf(userId: UserId): UserRole | undefined {
    return this.get(userId)?.role
  }

  list(): UserAccountRow[] {
    const rows = this.db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).all()
    return rows.flatMap((row) => {
      const account = this.get(row.id)
      return account ? [account] : []
    })
  }

  credentialFor(userId: UserId): UserCredentialRow | undefined {
    if (!this.get(userId)) return undefined
    const row = this.db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId))
      .get()
    if (!row) return undefined
    // Source parsing FAILS CLOSED for the same reason `parseRole` does, and it is
    // load-bearing here rather than defensive: a leftover `'instance-password'` row from
    // before POD-1554 must read as NO CREDENTIAL, never as one this build might verify
    // against. The SQL migration deletes those rows; this is what happens if one survives.
    if (!(CREDENTIAL_SOURCES as readonly string[]).includes(row.source)) return undefined
    return {
      userId: row.userId,
      source: row.source as CredentialSource,
      passwordHash: row.passwordHash,
      updatedAt: row.updatedAt,
    }
  }

  hasPerUserCredentials(): boolean {
    const row = this.db
      .select({ present: sql<number>`1` })
      .from(userCredentials)
      .where(
        and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
      )
      .limit(1)
      .get()
    return row?.present === 1
  }

  create(account: UserAccountRow, passwordHash: string): void {
    // The table's only writer drops the scope's cache, so the read after a mint
    // sees the account rather than the "no account" this scope had cached.
    currentReadScope().clear(this.accountsSlot)
    try {
      this.transact(() => {
        this.db
          .insert(users)
          .values({
            id: asUserId(account.id),
            displayName: account.displayName,
            role: account.role,
            createdAt: account.createdAt,
            disabledAt: null,
          })
          .run()
        this.db
          .insert(userCredentials)
          .values({
            userId: asUserId(account.id),
            source: 'per-user-scrypt',
            passwordHash,
            updatedAt: account.createdAt,
          })
          .run()
      })
    } finally {
      // And again on the way out — in a `finally`, because the case that needs
      // it is the ROLLBACK. A read taken inside the transaction would otherwise
      // outlive it and hold an account that does not exist.
      currentReadScope().clear(this.accountsSlot)
    }
  }

  setPasswordHash(userId: UserId, passwordHash: string, updatedAt: string): void {
    if (!this.get(userId)) throw new Error(`unknown user: ${userId}`)
    this.db
      .insert(userCredentials)
      .values({ userId, source: 'per-user-scrypt', passwordHash, updatedAt })
      .onConflictDoUpdate({
        target: userCredentials.userId,
        set: { source: 'per-user-scrypt', passwordHash, updatedAt },
      })
      .run()
  }
}
