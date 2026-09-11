import { CommittedRows } from './committed-rows'
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
 * Account creation, disablement and credential replacement publish the account
 * through the mandatory commit application. Credential hashes stay out of the
 * world index; disabled accounts and unknown roles still fail closed.
 */

import type { CredentialSource, UserId, UserRole } from '@podium/model'
import { asUserId, CREDENTIAL_SOURCES, USER_ROLES } from '@podium/model'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { userCredentials, users } from '../migrations/schema'
import { currentReadScope, readScopeSlot } from './executor/read-scope'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction, preparedPerDb } from './executor/sync-drizzle'

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
  readonly committed: CommittedRows<typeof users.$inferSelect>

  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'users')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
  }

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
   * scope across awaits. Unscoped reads get a fresh cache per read.
   *
   * THE ACCOUNT READ IS AN AUTHORIZATION INPUT, and reading it through a slot
   * is the PER-PASS form of spec rule 18's open question. It is legitimate here
   * because account writes clear this scope cache. WorldIndex maintains its
   * separate committed view through the write funnel. A caller gets its own object;
   * `undefined` is cached as an answer too, because "no account" is the verdict
   * every caller acts on.
   */
  private readonly accountsSlot = readScopeSlot(() => new Map<string, UserAccountRow | undefined>())

  private async frameCache(): Promise<Map<string, UserAccountRow | undefined>> {
    return currentReadScope().slot(this.accountsSlot)
  }

  /**
   * One account, or `undefined` when there is no row, the row is unreadable, or
   * the account is disabled. All three collapse to "no account", because every
   * caller's next move is the same — refuse — and giving the caller three arms
   * to get wrong is how one of them ends up permissive.
   */
  async get(userId: UserId): Promise<UserAccountRow | undefined> {
    const cache = await this.frameCache()
    if (cache.has(userId)) {
      const hit = cache.get(userId)
      return hit === undefined ? undefined : { ...hit }
    }
    const account = await this.read(userId)
    cache.set(userId, account)
    return account === undefined ? undefined : { ...account }
  }

  /**
   * THE MOST-EXECUTED STATEMENT IN THE SERVER, PREPARED ONCE [POD-3854].
   *
   * Seven minutes of a live instance issued this 180,660 times — the frame cache
   * above absorbs the repeats inside one read scope, and what is left is still
   * the top statement by count. The fluent form re-serialised the SQL and
   * regenerated the row mapper on every one of them; measured on the migrated
   * schema it cost 48.9 us per call against 12.4 us prepared.
   *
   * See {@link preparedPerDb} for why the cache is keyed on the drizzle instance
   * and not held as one query per repository.
   */
  private readonly accountById = preparedPerDb((db) =>
    db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare(),
  )

  private async read(userId: UserId): Promise<UserAccountRow | undefined> {
    const r = await this.accountById(this.db).get({ id: userId })
    if (!r) return undefined
    return userFromRow(r)
  }

  /** The account role, or `undefined` for an account that cannot act. */
  async roleOf(userId: UserId): Promise<UserRole | undefined> {
    return (await this.get(userId))?.role
  }

  /**
   * THE EARLIEST ADMIN MEMBER — who open mode acts as, who the break-glass CLI
   * mints for, and who `firstAdminMemberId()` is primed with [A2].
   *
   * ONE RULE, TWO SPELLINGS, TIED BY A TEST. `@podium/runtime`'s
   * `EARLIEST_ADMIN_MEMBER_SQL` asks this same question on a raw handle, because
   * the break-glass CLI has no drizzle in the process. Splicing that constant in
   * here through `sql.raw` would read as the tidier answer and is refused by
   * rule 16 for a good reason: `sql.raw` splices UNBOUND, so a reviewer cannot
   * rule out an injection by reading the line, and an exemption for a statement
   * that happens to be safe today is an exemption for whatever it becomes.
   *
   * So this is the builder's spelling, and `users-earliest-admin.test.ts` pins
   * the two together the way that actually matters — by running both against one
   * database and asserting the same member comes back. A textual tie would have
   * been weaker: it would catch an edit to the string and miss a divergence in
   * what the two executors do with it.
   *
   * `undefined` means no member may act as this instance's first admin: a
   * database from before accounts, or one whose admins are all disabled. A
   * caller decides what that means; it is never smoothed into a default, which
   * is the whole point of retiring the constant.
   */
  async earliestAdmin(): Promise<UserAccountRow | undefined> {
    const row = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1)
      .get()
    return row ? await this.get(asUserId(row.id)) : undefined
  }

  async list(): Promise<UserAccountRow[]> {
    const rows = await this.db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).all()
    const accounts = await Promise.all(rows.map(async (row) => await this.get(row.id)))
    return accounts.filter((account): account is UserAccountRow => account !== undefined)
  }

  /** One grouped boot read; disabled/unknown roles stay fail-closed. */
  async loadWorldUsers(): Promise<UserAccountRow[]> {
    return (await this.db.select().from(users).all())
      .flatMap((row) => { const account = userFromRow(row); return account ? [account] : [] })
  }

  async disable(userId: UserId, disabledAt: string): Promise<void> {
    currentReadScope().clear(this.accountsSlot)
    await this.committed.write(async () => this.db.update(users).set({ disabledAt })
      .where(eq(users.id, userId)).returning().all(), 'upsert')
  }

  async credentialFor(userId: UserId): Promise<UserCredentialRow | undefined> {
    if (!await this.get(userId)) return undefined
    const row = await this.db
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

  async hasPerUserCredentials(): Promise<boolean> {
    const row = await this.db
      .select({ present: sql<number>`1` })
      .from(userCredentials)
      .where(
        and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
      )
      .limit(1)
      .get()
    return row?.present === 1
  }

  async create(account: UserAccountRow, passwordHash: string): Promise<void> {
    // Account writes drop the scope's cache, so the read after a mint
    // sees the account rather than the "no account" this scope had cached.
    currentReadScope().clear(this.accountsSlot)
    try {
      await this.createOrJoinTransaction(async () => {
        ;await this.committed.write(async () => (this.db
          .insert(users)
          .values({
            // EXTERNAL INPUT BRAND DECODE: UserAccountRow is the account-import
            // boundary and deliberately carries its source id as a string.
            id: asUserId(account.id),
            displayName: account.displayName,
            role: account.role,
            createdAt: account.createdAt,
            disabledAt: null,
          })).returning().all(), 'upsert')
        ;await (this.db
          .insert(userCredentials)
          .values({
            // Same external account id, branded independently for this write.
            userId: asUserId(account.id),
            source: 'per-user-scrypt',
            passwordHash,
            updatedAt: account.createdAt,
          }))
          .run()
      })
    } finally {
      // And again on the way out — in a `finally`, because the case that needs
      // it is the ROLLBACK. A read taken inside the transaction would otherwise
      // outlive it and hold an account that does not exist.
      currentReadScope().clear(this.accountsSlot)
    }
  }

  async setPasswordHash(userId: UserId, passwordHash: string, updatedAt: string): Promise<void> {
    await this.committed.write(async () => {
      // A credential write must not republish an older pass-scoped account.
      const account = await this.read(userId)
      if (!account) throw new Error(`unknown user: ${userId}`)
      await (this.db
      .insert(userCredentials)
      .values({ userId, source: 'per-user-scrypt', passwordHash, updatedAt }))
      .onConflictDoUpdate({
        target: userCredentials.userId,
        set: { source: 'per-user-scrypt', passwordHash, updatedAt },
      })
      .run()
      return [{ ...account, id: userId }]
    }, 'upsert')
  }
}

export function userFromRow(r: typeof users.$inferSelect): UserAccountRow | undefined {
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
