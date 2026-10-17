import { CommittedRows } from './committed-rows'
import { MachinesRepository } from './machines'
import { GrantsRepository } from './grants'
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
 *
 * Member writes are also used by the invite-and-claim service. Its public
 * routes enforce admin access; trusted account claims are an in-process
 * capability.
 */

import type { CredentialSource, UserId, UserRole } from '@podium/model'
import { asUserId, CREDENTIAL_SOURCES, LoginEmail, USER_ROLES } from '@podium/model'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { clientSessions, grants, memberInvites, settingsAuditEvents, userCredentials, users } from '../migrations/schema'
import { applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { inListOf, inListSize, inListValues, param, placeholdersFor, prepared, preparedFamily, shapeOf } from './executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

/**
 * THE MOST-EXECUTED STATEMENT IN THE SERVER, PREPARED ONCE [POD-3854].
 *
 * Seven minutes of a live instance issued this 180,660 times — the frame cache
 * above absorbs the repeats inside one read scope, and what is left is still
 * the top statement by count. The fluent form re-serialised the SQL and
 * regenerated the row mapper on every one of them; measured on the migrated
 * schema it cost 48.9 us per call against 12.4 us prepared.
 *
 * Prepared once per store (see {@link prepared}); inside a transaction the
 * executor's router runs it on that transaction.
 */
const accountById = prepared((db: StoreDrizzle) =>
  db.select().from(users).where(eq(users.id, param(users.id, 'id'))).prepare(),
)

/** The accounts of a set of ids: the per-operation loader's batch [POD-6218]. */
const accountsByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select().from(users).where(inListOf(users.id, size)).prepare(),
)

// Two rows are enough to tell "exactly one" from "more than one".
const firstTwoActiveMembers = prepared((db: StoreDrizzle) =>
  db.select().from(users)
    .where(and(isNull(users.disabledAt), inArray(users.role, [...USER_ROLES])))
    .limit(2)
    .prepare(),
)

const earliestAdminRow = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1)
    .prepare(),
)

/** The one key of the earliest-admin loader: the instance has one earliest admin. */
const EARLIEST_ADMIN = 'earliest-admin'

const userIdByEmail = prepared((db: StoreDrizzle) =>
  db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, sql.placeholder('email')))
    .prepare(),
)

const userIdByAccount = prepared((db: StoreDrizzle) =>
  db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.cloudAccountId, param(users.cloudAccountId, 'accountId')))
    .prepare(),
)

const userIdsByCreation = prepared((db: StoreDrizzle) =>
  db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).prepare(),
)

const insertUserValues = {
  id: sql.placeholder('id'),
  displayName: sql.placeholder('displayName'),
  email: sql.placeholder('email'),
  role: sql.placeholder('role'),
  createdAt: sql.placeholder('createdAt'),
  disabledAt: null,
}

const insertUser = prepared((db: StoreDrizzle) =>
  db.insert(users).values(insertUserValues).prepare(),
)

const insertUserReturning = prepared((db: StoreDrizzle) =>
  db.insert(users).values(insertUserValues).returning().prepare(),
)

const setUserEmail = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({ email: sql.placeholder('email') })
    .where(eq(users.id, param(users.id, 'id')))
    .prepare(),
)

const setUserDisabledAt = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({ disabledAt: sql.placeholder('disabledAt') })
    .where(eq(users.id, param(users.id, 'id')))
    .returning()
    .prepare(),
)

const setUserProfile = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({ displayName: sql.placeholder('displayName'), avatar: sql.placeholder('avatar') })
    .where(eq(users.id, param(users.id, 'id')))
    .prepare(),
)

const claimUserAccount = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({ cloudAccountId: sql.placeholder('cloudAccountId') })
    .where(and(eq(users.id, param(users.id, 'id')), isNull(users.cloudAccountId), isNull(users.disabledAt)))
    .prepare(),
)

const credentialByUser = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, param(userCredentials.userId, 'userId')))
    .prepare(),
)

const anyPerUserCredential = prepared((db: StoreDrizzle) =>
  db
    .select({ present: sql<number>`1` })
    .from(userCredentials)
    .where(and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)))
    .limit(1)
    .prepare(),
)

const insertCredential = prepared((db: StoreDrizzle) =>
  db
    .insert(userCredentials)
    .values({
      userId: sql.placeholder('userId'),
      source: 'per-user-scrypt',
      passwordHash: sql.placeholder('passwordHash'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .prepare(),
)

const upsertCredential = prepared((db: StoreDrizzle) =>
  db
    .insert(userCredentials)
    .values({
      userId: sql.placeholder('userId'),
      source: 'per-user-scrypt',
      passwordHash: sql.placeholder('passwordHash'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: userCredentials.userId,
      set: {
        source: 'per-user-scrypt',
        passwordHash: sql.placeholder('passwordHash'),
        updatedAt: sql.placeholder('updatedAt'),
      },
    })
    .prepare(),
)

const deleteCredentialOf = prepared((db: StoreDrizzle) =>
  db
    .delete(userCredentials)
    .where(eq(userCredentials.userId, param(userCredentials.userId, 'userId')))
    .prepare(),
)

const deleteClientSessionsOf = prepared((db: StoreDrizzle) =>
  db
    .delete(clientSessions)
    .where(eq(clientSessions.userId, param(clientSessions.userId, 'userId')))
    .prepare(),
)

const insertSettingsAudit = prepared((db: StoreDrizzle) =>
  db
    .insert(settingsAuditEvents)
    .values({
      command: sql.placeholder('command'),
      outcome: sql.placeholder('outcome'),
      actorKind: sql.placeholder('actorKind'),
      actorId: sql.placeholder('actorId'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
      detailJson: sql.placeholder('detailJson'),
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

const custodyMachinesOf = prepared((db: StoreDrizzle) =>
  db
    .select({ id: grants.resourceId })
    .from(grants)
    .where(
      and(
        eq(grants.resourceKind, 'machine'),
        eq(grants.custody, true),
        eq(grants.grantee, param(grants.grantee, 'grantee')),
      ),
    )
    .prepare(),
)

/** The invite row is the caller's insert model, so its optional columns decide the shape. */
const insertInvite = preparedFamily((db: StoreDrizzle, shape: string) =>
  db
    .insert(memberInvites)
    .values(placeholdersFor(shape) as unknown as typeof memberInvites.$inferInsert)
    .prepare(),
)

const invitesByCreation = prepared((db: StoreDrizzle) =>
  db.select().from(memberInvites).orderBy(asc(memberInvites.createdAt)).prepare(),
)

const inviteByTokenHash = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(memberInvites)
    .where(eq(memberInvites.tokenHash, param(memberInvites.tokenHash, 'tokenHash')))
    .prepare(),
)

const deleteInviteById = prepared((db: StoreDrizzle) =>
  db.delete(memberInvites).where(eq(memberInvites.id, param(memberInvites.id, 'id'))).prepare(),
)

const deleteInvitesOfMember = prepared((db: StoreDrizzle) =>
  db
    .delete(memberInvites)
    .where(eq(memberInvites.memberId, param(memberInvites.memberId, 'memberId')))
    .prepare(),
)

export interface UserAccountRow {
  id: string
  displayName: string
  email: string | null
  accountId?: string | null
  avatar?: string | null
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

  constructor(
    queries: StoreQueries,
    private readonly machinesRepository = new MachinesRepository(queries),
    private readonly grantsRepository = new GrantsRepository(queries),
  ) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'users')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The store's one drizzle instance; the executor routes each statement to the current transaction. */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  /**
   * THE ACCOUNT READ, ONCE PER OPERATION [POD-1931, POD-6218].
   *
   * Every authorization decision asks who the principal is, so the account read
   * rides the publish fan-out: one event-loop frame was measured issuing 1,221
   * `SELECT * FROM users WHERE id = ?` statements against a table holding ONE
   * row (POD-1931). That became a read-scope cache (POD-3261); since POD-6218
   * it is a per-operation loader, like the grants loader: an id asked again in
   * the same operation (a daemon frame, a tRPC call, a delivery pass), before,
   * inside or after its write spans, is answered from the operation's memo, and
   * ids asked in the same tick are one `IN (…)` read. A delivery pass read the
   * sender's account once per held row (POD-6229).
   *
   * THE ACCOUNT READ IS AN AUTHORIZATION INPUT, so the memo must be exact: every
   * write of `users` below invalidates it after the write and after its commit
   * ({@link accountsWritten}), so a read after a create, a disable or a profile
   * write sees it, and a rolled-back span's reads go with it. Outside an
   * operation and an explicit read scope each call is one live read. A caller
   * gets its own object per call; "no account" is memoised too, because it is
   * the verdict every caller acts on.
   */
  private readonly accounts = operationLoader<string, UserAccountRow>(
    async (ids) => {
      const size = inListSize(ids.length)
      const rows = await accountsByIds(this.db, size).all(inListValues(ids, size))
      const found = new Map<string, UserAccountRow>()
      for (const row of rows) {
        const account = userFromRow(row)
        if (account) found.set(row.id, account)
      }
      return found
    },
    { copy: (row) => ({ ...row }), perOperation: true },
  )

  /**
   * One account, or `undefined` when there is no row, the row is unreadable, or
   * the account is disabled. All three collapse to "no account", because every
   * caller's next move is the same — refuse — and giving the caller three arms
   * to get wrong is how one of them ends up permissive.
   */
  async get(userId: UserId): Promise<UserAccountRow | undefined> {
    return await this.accounts.load(userId)
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
    const readAt = this.accounts.version
    const account = await this.earliestAdminOfOperation.load(EARLIEST_ADMIN)
    // The caller usually asks for this member by id next (its role, its
    // principal): hand the row to the account loader unless a write came between.
    if (account) this.accounts.prime(account.id, { ...account }, readAt)
    return account
  }

  /**
   * ONCE PER OPERATION [POD-6218]. Every session projection without an explicit
   * reader acts as this member (`SessionView.defaultPrincipal`), so a runtime
   * event asked about four times, two statements each (the id, then the account
   * by id): about 9.4k statements/min on the server-data bench (POD-6140 result
   * §4). The loader reads the row in one statement and keeps it for the rest of
   * the operation (a daemon frame, a tRPC call, a delivery pass); every write of
   * `users` below invalidates it ({@link accountsWritten}).
   */
  private readonly earliestAdminOfOperation = operationLoader<typeof EARLIEST_ADMIN, UserAccountRow>(
    async () => {
      const row = await earliestAdminRow(this.db).get()
      const account = row ? userFromRow(row) : undefined
      return new Map(account ? [[EARLIEST_ADMIN, account] as const] : [])
    },
    { copy: (row) => ({ ...row }), perOperation: true },
  )

  /** A `users` write: invalidated after it and, inside a span, after its commit. */
  private accountsWritten(): void {
    this.accountsInvalidated()
    if (spanOpen()) applyAfterCommit(() => this.accountsInvalidated(), 'users:account-loaders')
  }

  private accountsInvalidated(): void {
    this.accounts.invalidate()
    this.earliestAdminOfOperation.invalidate()
  }

  async byEmail(email: string): Promise<UserAccountRow | undefined> {
    const parsed = LoginEmail.safeParse(email)
    if (!parsed.success) return undefined
    const row = await userIdByEmail(this.db).get({ email: parsed.data })
    return row ? await this.get(row.id) : undefined
  }

  async setEmail(userId: UserId, email: string): Promise<void> {
    const normalized = LoginEmail.parse(email)
    if (!(await this.get(userId))) throw new Error(`unknown user: ${userId}`)
    await setUserEmail(this.db).run({ id: userId, email: normalized })
    this.accountsWritten()
  }

  async list(): Promise<UserAccountRow[]> {
    const rows = await userIdsByCreation(this.db).all()
    const accounts = await this.accounts.loadMany(rows.map((row) => row.id))
    return rows.flatMap((row) => {
      const account = accounts.get(row.id)
      return account ? [account] : []
    })
  }

  /** The only enabled, readable member, or `undefined` when there are none or several. */
  async soleActiveMember(): Promise<UserAccountRow | undefined> {
    const rows = await firstTwoActiveMembers(this.db).all()
    return rows.length === 1 ? userFromRow(rows[0]!) : undefined
  }

  /**
   * Disable authority, not custody. Agent principals intersect their delegation
   * with this live member row, so publishing it invalidates them in the same
   * commit. Keep delegations and machine grants as historical/access facts.
   * Running processes may finish; they gain no permission for further Podium
   * actions. Re-enabling restores rights, but never restores deleted cookies.
   */
  async disable(userId: UserId, disabledAt: string, actor?: UserId): Promise<void> {
    await this.setDisabled(userId, disabledAt, disabledAt, actor)
  }

  async enable(userId: UserId, enabledAt: string, actor?: UserId): Promise<void> {
    await this.setDisabled(userId, null, enabledAt, actor)
  }

  private async setDisabled(
    userId: UserId, disabledAt: string | null, at: string, actor?: UserId,
  ): Promise<void> {
    await this.claimTransaction(async () => {
      if (actor && (await this.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      const existing = await accountById(this.db).get({ id: userId })
      if (!existing) throw new Error(`unknown user: ${userId}`)
      if ((existing.disabledAt !== null) === (disabledAt !== null)) return
      await this.committed.write(async () => {
        const rows = await setUserDisabledAt(this.db).all({ id: userId, disabledAt })
        this.accountsWritten()
        if (disabledAt !== null) {
          await deleteClientSessionsOf(this.db).run({ userId })
        }
        await insertSettingsAudit(this.db).run({
          command: disabledAt === null ? 'members.enable' : 'members.disable',
          outcome: 'applied',
          actorKind: actor ? 'user' : 'system',
          actorId: actor ?? null,
          onBehalfOf: actor ?? null,
          detailJson: JSON.stringify({ memberId: userId, runningAgentPolicy: 'let-finish' }),
          createdAt: at,
        })
        return rows
      }, 'upsert')
    })
  }

  async credentialFor(userId: UserId): Promise<UserCredentialRow | undefined> {
    if (!(await this.get(userId))) return undefined
    const row = await credentialByUser(this.db).get({ userId })
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
    const row = await anyPerUserCredential(this.db).get()
    return row?.present === 1
  }

  async create(
    account: Omit<UserAccountRow, 'email'> & { email?: string | null },
    passwordHash: string,
  ): Promise<void> {
    // The write invalidates the account loaders, so the read after a mint sees
    // the account rather than a memoised "no account"; a rollback takes what
    // the span read after it with it (see `accounts`).
    await this.createOrJoinTransaction(async () => {
      ;await this.committed.write(async () => await insertUserReturning(this.db).all({
          // EXTERNAL INPUT BRAND DECODE: UserAccountRow is the account-import
          // boundary and deliberately carries its source id as a string.
          id: asUserId(account.id),
          displayName: account.displayName,
          email: account.email == null ? null : LoginEmail.parse(account.email),
          role: account.role,
          createdAt: account.createdAt,
        }), 'upsert')
      this.accountsWritten()
      ;await insertCredential(this.db).run({
          // Same external account id, branded independently for this write.
          userId: asUserId(account.id),
          passwordHash,
          updatedAt: account.createdAt,
        })
    })
  }

  async setPasswordHash(userId: UserId, passwordHash: string, updatedAt: string): Promise<void> {
    await this.committed.write(async () => {
      // A credential write must not republish an older pass-scoped account.
      // The funnel publishes the COMMITTED ROW, not UserAccountRow: the two
      // diverged once accounts grew `accountId` and `avatar` (A4, A5), and the
      // index is keyed on the stored column names.
      const account = await accountById(this.db).get({ id: userId })
      // Gate on the MAPPED read, publish the raw row. userFromRow answers
      // undefined for a disabled account and for a role this build cannot
      // parse; accountById answers the raw row regardless, and disable() sets
      // disabledAt rather than removing the row, so a truthy row is not
      // permission to write a credential.
      if (!account || !userFromRow(account)) throw new Error(`unknown user: ${userId}`)
      await upsertCredential(this.db).run({ userId, passwordHash, updatedAt })
      return [{ ...account, id: userId }]
    }, 'upsert')
  }
  /** Runs invite consumption and identity writes in the same transaction. */
  async claimTransaction<T>(run: () => Promise<T>): Promise<T> {
    return await this.createOrJoinTransaction(run)
  }

  async createUnclaimed(account: UserAccountRow): Promise<void> {
    await insertUser(this.db).run({
      id: asUserId(account.id),
      displayName: account.displayName,
      email: account.email,
      role: account.role,
      createdAt: account.createdAt,
    })
    this.accountsWritten()
  }

  async findMemberByAccount(accountId: string): Promise<UserAccountRow | undefined> {
    const row = await userIdByAccount(this.db).get({ accountId })
    return row ? await this.get(row.id) : undefined
  }

  async writeProfile(userId: UserId, name: string, avatar: string | null): Promise<void> {
    if (!(await this.get(userId))) throw new Error('Member unavailable')
    await setUserProfile(this.db).run({ id: userId, displayName: name, avatar })
    this.accountsWritten()
  }

  async attachAccount(userId: UserId, accountId: string): Promise<void> {
    const result = await claimUserAccount(this.db).run({ id: userId, cloudAccountId: accountId })
    this.accountsWritten()
    if (Number(result.changes) !== 1) throw new Error('Member is already claimed or unavailable')
  }

  async removeMember(userId: UserId, actor: UserId): Promise<void> {
    await this.claimTransaction(async () => {
      if ((await this.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      if (userId === actor) throw new Error('You cannot remove yourself')
      // Read the retained row: a disabled member can still hold custody, and
      // retrying removal by member id must succeed without duplicate audits.
      if (!(await accountById(this.db).get({ id: userId }))) throw new Error('Member unavailable')
      const at = new Date().toISOString()
      await this.disable(userId, at, actor)
      const held = await custodyMachinesOf(this.db).all({ grantee: userId })
      for (const machine of held) {
        await this.machinesRepository.setMachineOwner(machine.id, null)
        await insertSettingsAudit(this.db).run({
          command: 'members.remove', outcome: 'applied',
          actorKind: 'user', actorId: actor, onBehalfOf: actor,
          detailJson: JSON.stringify({
            memberId: userId, machineId: machine.id,
            previousOwnerUserId: userId, newOwnerUserId: null,
          }),
          createdAt: at,
        })
      }
      // Keep other members' shares, including shares granted by this member.
      // Only the removed member's incoming grants are invalidated. Session and
      // issue attribution (and historical grant audiences) are never rewritten.
      await this.grantsRepository.removeAllForGrantee(userId)
      await deleteClientSessionsOf(this.db).run({ userId })
      await deleteCredentialOf(this.db).run({ userId })
      await deleteInvitesOfMember(this.db).run({ memberId: userId })
    })
  }

  async insertInvite(invite: typeof memberInvites.$inferInsert): Promise<void> {
    await insertInvite(this.db, shapeOf(invite)).run(invite)
  }

  async pendingInvites(): Promise<(typeof memberInvites.$inferSelect)[]> {
    return await invitesByCreation(this.db).all()
  }

  async inviteByHash(hash: string): Promise<typeof memberInvites.$inferSelect | undefined> {
    return await inviteByTokenHash(this.db).get({ tokenHash: hash })
  }

  async deleteInvite(id: import('@podium/model').InviteId): Promise<boolean> {
    return (
      Number(
        (await deleteInviteById(this.db).run({ id })).changes,
      ) === 1
    )
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
      email: r.email,
      accountId: r.cloudAccountId,
      avatar: r.avatar,
      role,
      createdAt: r.createdAt,
      disabledAt,
    }
}
