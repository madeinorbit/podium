import { CommittedRows } from './committed-rows'
import { GrantsRepository } from './grants'
import { MachinesRepository } from './machines'
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

import { createLogger } from '@podium/logger'
import type { CredentialSource, UserId, UserRole } from '@podium/model'
import { asUserId, CREDENTIAL_SOURCES, LoginEmail, USER_ROLES } from '@podium/model'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  clientSessions,
  grants,
  memberInvites,
  settingsAuditEvents,
  userCredentials,
  users,
} from '../migrations/schema'
import { afterCommit, applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
} from './executor/sync-drizzle'

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
  db
    .select()
    .from(users)
    .where(eq(users.id, param(users.id, 'id')))
    .prepare(),
)

/** The accounts of a set of ids: the per-operation loader's batch [POD-6218]. */
const accountsByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select().from(users).where(inListOf(users.id, size)).prepare(),
)

// Two rows are enough to tell "exactly one" from "more than one".
const firstTwoActiveMembers = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(users)
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

/** Every member row, disabled ones included, for the admins' member list (POD-6298). */
const everyUserByCreation = prepared((db: StoreDrizzle) =>
  db.select().from(users).orderBy(asc(users.createdAt), asc(users.id)).prepare(),
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

const log = createLogger('server:users')

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

const setUserRole = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({ role: sql.placeholder('role') })
    .where(eq(users.id, param(users.id, 'id')))
    .prepare(),
)

/** One step of the member's authorization generation, returning the row (POD-6293). */
const bumpAuthzGeneration = prepared((db: StoreDrizzle) =>
  db
    .update(users)
    .set({
      authzGeneration: sql`${users.authzGeneration} + 1`,
      authzChangedAt: sql.placeholder('changedAt'),
    })
    .where(eq(users.id, param(users.id, 'id')))
    .returning()
    .prepare(),
)

/** Another enabled admin than `id`: a demotion must not leave the instance without one. */
const otherActiveAdmin = prepared((db: StoreDrizzle) =>
  db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        isNull(users.disabledAt),
        sql`${users.id} <> ${param(users.id, 'id')}`,
      ),
    )
    .limit(1)
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
    .where(
      and(
        eq(users.id, param(users.id, 'id')),
        isNull(users.cloudAccountId),
        isNull(users.disabledAt),
      ),
    )
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
    .where(
      and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
    )
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
  db
    .delete(memberInvites)
    .where(eq(memberInvites.id, param(memberInvites.id, 'id')))
    .prepare(),
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

/**
 * WHAT CHANGED ABOUT A MEMBER'S AUTHORITY, AS COMMITTED (POD-6293; design §4.5).
 *
 * Published from the commit of the transaction that stepped the member's
 * authorization generation, so a listener acts within that commit's publication
 * and a rolled-back change publishes nothing.
 *
 * - `revoked`: the member can no longer act through anything they had open
 *   (disabled, removed, or every sign-in ended). Their connections close.
 * - `rescoped`: the member still acts, with different rights (role change,
 *   re-enable). Their open connections keep going under the new rights.
 */
export interface MemberAccessChange {
  readonly memberId: UserId
  readonly generation: number
  readonly reason: 'disabled' | 'enabled' | 'role' | 'signed-out' | 'removed'
  readonly effect: 'revoked' | 'rescoped'
  /** The member's role after the change, or `null` when they cannot act. */
  readonly role: UserRole | null
}

export type MemberAccessListener = (change: MemberAccessChange) => void

/**
 * WHY A MEMBER CHANGE WAS REFUSED (POD-6298). Thrown inside the change's own
 * transaction, so the check and the write cannot be separated by another
 * request's commit; the member routes turn the code into the HTTP status.
 *
 * - `admin-required`: the actor is not an enabled admin when the change applies.
 * - `last-admin`: the change would leave the instance with no enabled admin.
 * - `self`: an admin cannot disable or remove their own account.
 * - `unavailable`: no such member, or one the change cannot apply to.
 */
export class MemberChangeRefused extends Error {
  constructor(
    readonly code: 'admin-required' | 'last-admin' | 'self' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'MemberChangeRefused'
  }
}

const adminRequired = () => new MemberChangeRefused('admin-required', 'Administrator required')
const lastAdmin = (what: string) =>
  new MemberChangeRefused('last-admin', `The last administrator cannot be ${what}`)

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

  private readonly accessListeners = new Set<MemberAccessListener>()
  private readonly accessEffects = new Set<(change: MemberAccessChange) => Promise<void>>()

  /**
   * Hear every committed change to a member's authority (POD-6293). The
   * listener runs in the commit's application step: it must not query or
   * await, and it hears only changes whose transaction committed.
   */
  onAccessChange(listener: MemberAccessListener): () => void {
    this.accessListeners.add(listener)
    return () => {
      this.accessListeners.delete(listener)
    }
  }

  /**
   * Run `effect` after every committed change to a member's authority, as an
   * external effect of that commit: it may read and await, and its failure
   * never undoes the change. For work that re-sends what a rescoped connection
   * shows (its machine listing, say) rather than what it may do.
   */
  afterAccessChange(effect: (change: MemberAccessChange) => Promise<void>): () => void {
    this.accessEffects.add(effect)
    return () => {
      this.accessEffects.delete(effect)
    }
  }

  /**
   * The member's current authorization generation, or `undefined` for no such
   * row. A disabled member keeps theirs.
   */
  async authzGenerationOf(userId: UserId): Promise<number | undefined> {
    return (await accountById(this.db).get({ id: userId }))?.authzGeneration
  }

  /**
   * Was work queued at `queuedAtMs` on this member's behalf authorized under
   * rights that have changed since (design §4.5)? A dispatcher refuses such
   * work rather than replaying it because it was in the queue. True also when
   * the member row is gone.
   */
  async queuedBeforeAuthorityChange(userId: UserId, queuedAtMs: number): Promise<boolean> {
    const row = await accountById(this.db).get({ id: userId })
    if (!row) return true
    return row.authzChangedAt !== null && queuedAtMs <= Date.parse(row.authzChangedAt)
  }

  /**
   * Step the member's authorization generation inside the caller's transaction
   * and publish the change from its commit. Every authority change goes
   * through here, so the generation and the change cannot commit apart.
   */
  private async bumpAuthorization(
    userId: UserId,
    reason: MemberAccessChange['reason'],
  ): Promise<typeof users.$inferSelect | undefined> {
    const [row] = await bumpAuthzGeneration(this.db).all({
      id: userId,
      changedAt: new Date().toISOString(),
    })
    this.accountsWritten()
    if (!row) return undefined
    const role = row.disabledAt === null ? (parseRole(row.role) ?? null) : null
    const change: MemberAccessChange = {
      memberId: userId,
      generation: row.authzGeneration,
      reason,
      effect: role === null || reason === 'signed-out' ? 'revoked' : 'rescoped',
      role,
    }
    applyAfterCommit(() => {
      for (const listener of this.accessListeners) listener(change)
    }, 'users:access-change')
    afterCommit(async () => {
      for (const effect of this.accessEffects) {
        try {
          await effect(change)
        } catch (error) {
          log.warn('an access-change effect failed after its commit', { error, reason })
        }
      }
    }, 'users:access-change-effects')
    return row
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
  private readonly earliestAdminOfOperation = operationLoader<
    typeof EARLIEST_ADMIN,
    UserAccountRow
  >(
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

  /**
   * Every member with a readable role, DISABLED ONES INCLUDED, oldest first: the
   * admins' member list, where a disabled or removed member is one to enable or
   * re-invite (POD-6298). Not an authorization read; `get` stays the one that
   * answers "may this member act".
   */
  async listIncludingDisabled(): Promise<UserAccountRow[]> {
    return (await everyUserByCreation(this.db).all()).flatMap((row) => {
      const role = parseRole(row.role)
      if (role === undefined) return []
      return [
        {
          id: row.id,
          displayName: row.displayName,
          email: row.email,
          accountId: row.cloudAccountId,
          avatar: row.avatar,
          role,
          createdAt: row.createdAt,
          disabledAt: row.disabledAt,
        },
      ]
    })
  }

  /**
   * The actor is an enabled admin, read from the row inside the caller's
   * transaction rather than from the per-operation memo: a concurrent request
   * that demoted or disabled the actor has committed before this one's write
   * lane opened, and that commit is what must decide (POD-6298, MU-03).
   */
  private async requireActiveAdmin(actor: UserId): Promise<void> {
    const row = await accountById(this.db).get({ id: actor })
    if (!row || userFromRow(row)?.role !== 'admin') throw adminRequired()
  }

  /** Whether removing `userId`'s admin rights would leave no enabled admin. */
  private async isLastActiveAdmin(row: typeof users.$inferSelect): Promise<boolean> {
    if (row.disabledAt !== null || parseRole(row.role) !== 'admin') return false
    return !(await otherActiveAdmin(this.db).get({ id: asUserId(row.id) }))
  }

  /** The only enabled, readable member, or `undefined` when there are none or several. */
  async soleActiveMember(): Promise<UserAccountRow | undefined> {
    const rows = await firstTwoActiveMembers(this.db).all()
    return rows.length === 1 ? userFromRow(rows[0]!) : undefined
  }

  /** Whether at least two enabled members exist: the instance is shared, so open
   *  mode is over whatever the login setting says (POD-6285, MU-01). */
  async hasSeveralActiveMembers(): Promise<boolean> {
    return (await firstTwoActiveMembers(this.db).all()).length > 1
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
    userId: UserId,
    disabledAt: string | null,
    at: string,
    actor?: UserId,
  ): Promise<void> {
    await this.claimTransaction(async () => {
      if (actor) await this.requireActiveAdmin(actor)
      const existing = await accountById(this.db).get({ id: userId })
      if (!existing) throw new MemberChangeRefused('unavailable', `unknown user: ${userId}`)
      if ((existing.disabledAt !== null) === (disabledAt !== null)) return
      // An admin disabling through member administration (every route passes
      // the actor) cannot disable themselves or the last enabled admin. A
      // system disable, in-process only, is not member administration.
      if (disabledAt !== null && actor) {
        if (actor === userId) throw new MemberChangeRefused('self', 'You cannot disable yourself')
        if (await this.isLastActiveAdmin(existing)) throw lastAdmin('disabled')
      }
      await this.committed.write(async () => {
        await setUserDisabledAt(this.db).all({ id: userId, disabledAt })
        this.accountsWritten()
        if (disabledAt !== null) {
          await deleteClientSessionsOf(this.db).run({ userId })
        }
        const bumped = await this.bumpAuthorization(
          userId,
          disabledAt === null ? 'enabled' : 'disabled',
        )
        const rows = bumped ? [bumped] : []
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
      await this.committed.write(
        async () =>
          await insertUserReturning(this.db).all({
            // EXTERNAL INPUT BRAND DECODE: UserAccountRow is the account-import
            // boundary and deliberately carries its source id as a string.
            id: asUserId(account.id),
            displayName: account.displayName,
            email: account.email == null ? null : LoginEmail.parse(account.email),
            role: account.role,
            createdAt: account.createdAt,
          }),
        'upsert',
      )
      this.accountsWritten()
      await insertCredential(this.db).run({
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
      await this.requireActiveAdmin(actor)
      if (userId === actor) throw new MemberChangeRefused('self', 'You cannot remove yourself')
      // Read the retained row: a disabled member can still hold custody, and
      // retrying removal by member id must succeed without duplicate audits.
      const existing = await accountById(this.db).get({ id: userId })
      if (!existing) throw new MemberChangeRefused('unavailable', 'Member unavailable')
      if (await this.isLastActiveAdmin(existing)) throw lastAdmin('removed')
      const at = new Date().toISOString()
      await this.disable(userId, at, actor)
      const held = await custodyMachinesOf(this.db).all({ grantee: userId })
      for (const machine of held) {
        await this.machinesRepository.setMachineOwner(machine.id, null)
        await insertSettingsAudit(this.db).run({
          command: 'members.remove',
          outcome: 'applied',
          actorKind: 'user',
          actorId: actor,
          onBehalfOf: actor,
          detailJson: JSON.stringify({
            memberId: userId,
            machineId: machine.id,
            previousOwnerUserId: userId,
            newOwnerUserId: null,
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
      await this.bumpAuthorization(userId, 'removed')
    })
  }

  /**
   * Change a member's role (POD-6293). The role, the generation step and the
   * audit row commit together; open connections are rescoped from the commit.
   * The last enabled admin cannot be demoted, so the instance always keeps one.
   */
  async setRole(userId: UserId, role: UserRole, actor?: UserId): Promise<void> {
    await this.claimTransaction(async () => {
      if (actor) await this.requireActiveAdmin(actor)
      const existing = await accountById(this.db).get({ id: userId })
      if (!existing || existing.disabledAt !== null) {
        throw new MemberChangeRefused('unavailable', 'Member unavailable')
      }
      if (existing.role === role) return
      if (existing.role === 'admin' && (await this.isLastActiveAdmin(existing))) {
        throw lastAdmin('demoted')
      }
      await setUserRole(this.db).run({ id: userId, role })
      this.accountsWritten()
      await this.bumpAuthorization(userId, 'role')
      await insertSettingsAudit(this.db).run({
        command: 'members.setRole',
        outcome: 'applied',
        actorKind: actor ? 'user' : 'system',
        actorId: actor ?? null,
        onBehalfOf: actor ?? null,
        detailJson: JSON.stringify({ memberId: userId, from: existing.role, to: role }),
        createdAt: new Date().toISOString(),
      })
    })
  }

  /**
   * Sign a member out everywhere (POD-6293): every sign-in session goes, the
   * generation steps, and every open connection of theirs closes at the commit.
   * Signing out one device is that credential's own revocation (`/auth/logout`),
   * which closes that credential's connections and leaves the others.
   */
  async signOutEverywhere(userId: UserId, actor?: UserId): Promise<void> {
    await this.claimTransaction(async () => {
      if (actor && actor !== userId) await this.requireActiveAdmin(actor)
      if (!(await accountById(this.db).get({ id: userId }))) {
        throw new MemberChangeRefused('unavailable', 'Member unavailable')
      }
      await deleteClientSessionsOf(this.db).run({ userId })
      await this.bumpAuthorization(userId, 'signed-out')
      await insertSettingsAudit(this.db).run({
        command: 'members.signOut',
        outcome: 'applied',
        actorKind: actor ? 'user' : 'system',
        actorId: actor ?? null,
        onBehalfOf: actor ?? null,
        detailJson: JSON.stringify({ memberId: userId }),
        createdAt: new Date().toISOString(),
      })
    })
  }

  /**
   * A recovery link was used (POD-6298): the member's password is replaced,
   * every sign-in of theirs ends with their open connections, and every other
   * outstanding link for them goes, all in the caller's transaction. The
   * member keeps their id, role and history.
   */
  async recoverPassword(userId: UserId, passwordHash: string, at: string): Promise<void> {
    await this.claimTransaction(async () => {
      await this.setPasswordHash(userId, passwordHash, at)
      await deleteClientSessionsOf(this.db).run({ userId })
      await deleteInvitesOfMember(this.db).run({ memberId: userId })
      await this.bumpAuthorization(userId, 'signed-out')
      await this.audit('members.recover', null, { memberId: userId }, at)
    })
  }

  /** One applied member-administration audit row; `actor` null is the host or the member. */
  async audit(
    command: string,
    actor: UserId | null,
    detail: Record<string, unknown>,
    at = new Date().toISOString(),
  ): Promise<void> {
    await insertSettingsAudit(this.db).run({
      command,
      outcome: 'applied',
      actorKind: actor ? 'user' : 'system',
      actorId: actor,
      onBehalfOf: actor,
      detailJson: JSON.stringify(detail),
      createdAt: at,
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
    return Number((await deleteInviteById(this.db).run({ id })).changes) === 1
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
