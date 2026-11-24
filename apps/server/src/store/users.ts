// workspace-scoped (POD-6959)
import { captureWrite } from '../sync/capture-pg'
import { CommittedRows } from './committed-rows'
import { GrantsRepository } from './grants'
import { MachinesRepository } from './machines'
import { SignInCarryOverRepository } from './sign-in-carry-over'
/** Member rows and authority. Identity changes arrive only through apply-membership. */

import type { MemberRows, MemberWrite } from '@podium/identity'
import type { UserId, UserRole } from '@podium/model'
import { asUserId, LoginEmail, USER_ROLES } from '@podium/model'
import { asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { users } from '../migrations/schema'
import { dialectOf } from './executor/dialect-prepared'
import { applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
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
const accountById = prepared((db, t) =>
  db
    .select()
    .from(t.users)
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
    .prepare(),
)

/** The accounts of a set of ids: the per-operation loader's batch [POD-6218]. */
const accountsByIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.users)
    .where(inWorkspace(t.users, inListOf(t.users.id, size)))
    .prepare(),
)

// Two rows are enough to tell "exactly one" from "more than one".
/** Machine access records need only enabled members' ids and roles. */
const activeRecordMembers = prepared((db, t) =>
  db
    .select({ id: t.users.id, role: t.users.role })
    .from(t.users)
    .where(inWorkspace(t.users, isNull(t.users.disabledAt), inArray(t.users.role, [...USER_ROLES])))
    .prepare(),
)

const firstTwoActiveMembers = prepared((db, t) =>
  db
    .select()
    .from(t.users)
    .where(inWorkspace(t.users, isNull(t.users.disabledAt), inArray(t.users.role, [...USER_ROLES])))
    .limit(2)
    .prepare(),
)

// Retained disabled/removed people still own their historical usage. Read at
// most two ids from the covering primary-key index, regardless of roster size.
const firstTwoMemberIds = prepared((db, t) =>
  db.select({ id: t.users.id }).from(t.users).where(inWorkspace(t.users)).limit(2).prepare(),
)

const earliestAdminRow = prepared((db, t) =>
  db
    .select()
    .from(t.users)
    .where(inWorkspace(t.users, eq(t.users.role, 'admin'), isNull(t.users.disabledAt)))
    .orderBy(asc(t.users.createdAt), asc(t.users.id))
    .limit(1)
    .prepare(),
)

/** Every admin who can act: the readers of an instance-wide effect (POD-6358). */
const activeAdminIdRows = prepared((db, t) =>
  db
    .select({ id: t.users.id })
    .from(t.users)
    .where(inWorkspace(t.users, eq(t.users.role, 'admin'), isNull(t.users.disabledAt)))
    .prepare(),
)

/** The one key of the earliest-admin loader: the instance has one earliest admin. */
const EARLIEST_ADMIN = 'earliest-admin'

/**
 * A member's email folded as `users_email_unique` folds it, for a lookup by an
 * already folded address. On Postgres the folded text is compared in byte order,
 * as SQLite compares it (`COLLATE "C"`, POD-6958 design 2.3 rule 13); `lower()` of
 * a C-collated value folds ASCII only there, exactly as SQLite's `lower()` does.
 */
const foldedEmail = (db: StoreDrizzle, t: StoreTables): SQL =>
  dialectOf(db) === 'pg' ? sql`lower(${t.users.email}) COLLATE "C"` : sql`lower(${t.users.email})`

const userIdByEmail = prepared((db, t) =>
  db
    .select({ id: t.users.id })
    .from(t.users)
    .where(inWorkspace(t.users, eq(foldedEmail(db, t), sql.placeholder('email'))))
    .prepare(),
)

const setUserProfile = prepared((db, t) =>
  db
    .update(t.users)
    .set({ displayName: sql.placeholder('displayName'), avatar: sql.placeholder('avatar') })
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
    .prepare(),
)

const userIdByAccount = prepared((db, t) =>
  db
    .select({ id: t.users.id })
    .from(t.users)
    .where(
      inWorkspace(t.users, eq(t.users.cloudAccountId, param(t.users.cloudAccountId, 'accountId'))),
    )
    .prepare(),
)

const userIdsByCreation = prepared((db, t) =>
  db
    .select({ id: t.users.id })
    .from(t.users)
    .where(inWorkspace(t.users))
    .orderBy(asc(t.users.createdAt))
    .prepare(),
)

/** Every member row, disabled ones included, for the admins' member list (POD-6298). */
const everyUserByCreation = prepared((db, t) =>
  db
    .select()
    .from(t.users)
    .where(inWorkspace(t.users))
    .orderBy(asc(t.users.createdAt), asc(t.users.id))
    .prepare(),
)

/** One step of the member's authorization generation, returning the row (POD-6293). */
const bumpAuthzGeneration = prepared((db, t) =>
  db
    .update(t.users)
    .set({
      authzGeneration: sql`${t.users.authzGeneration} + 1`,
      authzChangedAt: sql.placeholder('changedAt'),
    })
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
    .returning()
    .prepare(),
)

/**
 * POD-7552 — a member's authority changed (a role change, a disable, a
 * removal): their access moved. Recorded at the feed's next number, so a
 * device whose cursor is the current head counts as from before the change.
 * No visibility edge carries this move, so the Authority's delivery pass
 * cannot record it; this runs in the change's own transaction instead.
 */
const recordMemberAccessMove = prepared((db, t) =>
  db
    .insert(t.syncAccessMoves)
    .values({
      workspaceId: WORKSPACE,
      humanId: sql.placeholder('id'),
      seq: sql`coalesce((select ${t.syncFeed.headSeq} from ${t.syncFeed} where ${t.syncFeed.workspaceId} = ${WORKSPACE}), 0) + 1`,
    })
    .onConflictDoUpdate({
      target: [t.syncAccessMoves.workspaceId, t.syncAccessMoves.humanId],
      set: {
        seq: sql`case when ${t.syncAccessMoves.seq} > excluded.seq then ${t.syncAccessMoves.seq} else excluded.seq end`,
      },
    })
    .prepare(),
)

/** Another enabled admin than `id`: a demotion must not leave the instance without one. */
const stampMemberVersion = prepared((db, t) =>
  db
    .update(t.users)
    .set({ membershipVersion: sql.placeholder('version') })
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
    .prepare(),
)

const insertSettingsAudit = prepared((db, t) =>
  db
    .insert(t.settingsAuditEvents)
    .values({
      workspaceId: WORKSPACE,
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

const custodyMachinesOf = prepared((db, t) =>
  db
    .select({ id: t.grants.resourceId })
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.resourceKind, 'machine'),
        eq(t.grants.custody, true),
        eq(t.grants.grantee, param(t.grants.grantee, 'grantee')),
      ),
    )
    .prepare(),
)

// ---- the member row as apply-membership writes it (POD-6745) ---------------

/** A member row made by a membership that became active. */
const insertMemberRow = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.users)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        displayName: sql.placeholder('displayName'),
        email: sql.placeholder('email'),
        cloudAccountId: sql.placeholder('accountId'),
        avatar: sql.placeholder('avatar'),
        role: sql.placeholder('role'),
        createdAt: sql.placeholder('createdAt'),
        disabledAt: null,
        membershipVersion: sql.placeholder('membershipVersion'),
      })
      .returning(),
  ).prepare(),
)

/** Every identity fact of one member row, with the membership version applied. */
const writeMemberFacts = prepared((db, t) =>
  captureWrite(
    db
      .update(t.users)
      .set({
        role: sql.placeholder('role'),
        disabledAt: sql.placeholder('disabledAt'),
        displayName: sql.placeholder('displayName'),
        avatar: sql.placeholder('avatar'),
        email: sql.placeholder('email'),
        cloudAccountId: sql.placeholder('accountId'),
        membershipVersion: sql.placeholder('membershipVersion'),
      })
      .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
      .returning(),
  ).prepare(),
)

/** The member row that holds an address, in any state. */
const memberHoldingEmail = prepared((db, t) =>
  db
    .select({ id: t.users.id, disabledAt: t.users.disabledAt })
    .from(t.users)
    .where(inWorkspace(t.users, eq(foldedEmail(db, t), sql.placeholder('email'))))
    .prepare(),
)

/** The member row that holds an account id, in any state. */
const memberHoldingAccount = prepared((db, t) =>
  db
    .select({ id: t.users.id, disabledAt: t.users.disabledAt })
    .from(t.users)
    .where(
      inWorkspace(t.users, eq(t.users.cloudAccountId, param(t.users.cloudAccountId, 'accountId'))),
    )
    .prepare(),
)

const clearMemberEmail = prepared((db, t) =>
  db
    .update(t.users)
    .set({ email: null })
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
    .prepare(),
)

const clearMemberAccount = prepared((db, t) =>
  db
    .update(t.users)
    .set({ cloudAccountId: null })
    .where(inWorkspace(t.users, eq(t.users.id, param(t.users.id, 'id'))))
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

/**
 * WHAT CHANGED ABOUT A MEMBER'S AUTHORITY, AS COMMITTED (POD-6293; design §4.5).
 *
 * Published from the commit of the transaction that stepped the member's
 * authorization generation, so a listener acts within that commit's publication
 * and a rolled-back change publishes nothing.
 *
 * - `revoked`: the member can no longer act through anything they had open
 *   (disabled or removed). Their connections close.
 * - `rescoped`: the member still acts, with different rights (role change,
 *   re-enable). Their open connections keep going under the new rights.
 */
export interface MemberAccessChange {
  readonly memberId: UserId
  readonly generation: number
  readonly reason: 'disabled' | 'enabled' | 'role' | 'removed'
  readonly effect: 'revoked' | 'rescoped'
  /** The member's role after the change, or `null` when they cannot act. */
  readonly role: UserRole | null
}

export type MemberAccessListener = (change: MemberAccessChange) => void

export class UsersRepository {
  readonly committed: CommittedRows<typeof users.$inferSelect>

  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(
    queries: WorkspaceQueries,
    private readonly machinesRepository = new MachinesRepository(queries),
    private readonly grantsRepository = new GrantsRepository(queries),
    // LEGACY(remove-after: 2027-06): end pre-upgrade sign-ins on a membership change.
    private readonly oldSignIns = new SignInCarryOverRepository(queries),
  ) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'users')
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  private readonly accessListeners = new Set<MemberAccessListener>()
  private memberCreated: ((userId: UserId) => Promise<void>) | undefined

  /** Create member defaults in the account's source transaction. */
  setMemberCreated(capture: (userId: UserId) => Promise<void>): void {
    this.memberCreated = capture
  }

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
    await recordMemberAccessMove(this.db).run({ id: userId })
    const role = row.disabledAt === null ? (parseRole(row.role) ?? null) : null
    const change: MemberAccessChange = {
      memberId: userId,
      generation: row.authzGeneration,
      reason,
      effect: role === null ? 'revoked' : 'rescoped',
      role,
    }
    applyAfterCommit(() => {
      for (const listener of this.accessListeners) listener(change)
    }, 'users:access-change')
    return row
  }

  /** The store's one drizzle instance; the executor routes each statement to the current transaction. */
  protected get db(): WorkspaceDb {
    return this.scope
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

  /**
   * The ids of every admin who can act (not disabled). The readers of an
   * instance-wide effect record (a software update, a server move), read once
   * per visibility pass that holds one (POD-6358).
   */
  async activeAdminIds(): Promise<ReadonlySet<string>> {
    return new Set((await activeAdminIdRows(this.db).all()).map((row) => row.id))
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

  async recordMembers(): Promise<{ id: UserId; role: UserRole }[]> {
    return (await activeRecordMembers(this.db).all()).flatMap((row) => {
      const role = parseRole(row.role)
      return role ? [{ id: asUserId(row.id), role }] : []
    })
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

  /** Includes retained disabled/removed members: their history stays private. */
  async hasSeveralMembers(): Promise<boolean> {
    return (await firstTwoMemberIds(this.db).all()).length > 1
  }

  async findMemberByAccount(accountId: string): Promise<UserAccountRow | undefined> {
    const row = await userIdByAccount(this.db).get({ accountId })
    return row ? await this.get(row.id) : undefined
  }

  /** A member edits their own name and avatar (Account → Profile); never credentials. */
  async writeProfile(userId: UserId, name: string, avatar: string | null): Promise<void> {
    if (!(await this.get(userId))) throw new Error('Member unavailable')
    await setUserProfile(this.db).run({ id: userId, displayName: name, avatar })
    this.accountsWritten()
  }

  /**
   * THE MEMBER ROWS OF THE IDENTITY PACKAGE (POD-6745;
   * docs/design/people-and-sign-in.md section 2.6). The package's
   * apply-membership is the only caller of `write`.
   */
  readonly memberRows: MemberRows = {
    write: (change) => this.writeMemberRow(change),
    exists: async (memberId) =>
      (await accountById(this.db).get({ id: asUserId(memberId) })) !== undefined,
  }

  /**
   * ONE MEMBERSHIP, APPLIED TO ITS MEMBER ROW (POD-6745). The only writer of a
   * member's identity facts: role, disabled, removed, name, picture, email and
   * account id. In one transaction with the membership change where the two
   * share a database.
   *
   * A change of what the member may do steps the authorization generation,
   * which publishes the access change that closes sockets and refuses queued
   * work (POD-6293). A change of name, picture, email or account id does not.
   * A removed member is a disabled member row; only the membership tells the
   * two apart, so no gate learns a new fact. Removal releases machine custody
   * and deletes the member's incoming grants, as removing a member always did.
   *
   * `membership_version` makes it safe to apply a membership twice, or an
   * older one after a newer one: such a change does nothing.
   */
  private async writeMemberRow(change: MemberWrite): Promise<void> {
    // A member's role and disabled state feed the machine access records: the
    // write is one change-log commit that appends what it reached (POD-6920).
    await this.machinesRepository.machineRecordWrites.compare(
      async () => await this.applyMemberRow(change),
    )
  }

  private async applyMemberRow(change: MemberWrite): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const memberId = asUserId(change.memberId)
      const existing = await accountById(this.db).get({ id: memberId })
      if (existing && change.version <= existing.membershipVersion) return
      if (change.state === 'invited') {
        if (existing) {
          await stampMemberVersion(this.db).run({ id: memberId, version: change.version })
          this.accountsWritten()
        }
        return
      }
      const at = new Date().toISOString()
      const actor = 'memberId' in change.actor ? asUserId(change.actor.memberId) : null
      const removed = change.state === 'removed'

      // The address and the account id are unique among member rows. A removed
      // member keeps neither, so the person can come back as a new member. A
      // row that is no longer active gives way to the member being written;
      // an active one keeps what it holds.
      let email = removed ? null : change.profile ? change.profile.email : (existing?.email ?? null)
      if (email !== null) {
        const parsed = LoginEmail.safeParse(email)
        if (parsed.success) email = parsed.data
        const holder = await memberHoldingEmail(this.db).get({ email: email.toLowerCase() })
        if (holder && holder.id !== memberId) {
          if (holder.disabledAt !== null) await clearMemberEmail(this.db).run({ id: holder.id })
          else email = null
        }
      }
      let accountId = removed ? null : change.accountId
      if (accountId !== null) {
        const holder = await memberHoldingAccount(this.db).get({ accountId })
        if (holder && holder.id !== memberId) {
          if (holder.disabledAt !== null) await clearMemberAccount(this.db).run({ id: holder.id })
          else accountId = null
        }
      }

      if (!existing) {
        // No member exists before a membership is active.
        if (change.state !== 'active') return
        await this.committed.write(
          async () =>
            await insertMemberRow(this.db).all({
              id: memberId,
              displayName: change.profile?.name ?? 'Member',
              email,
              accountId,
              avatar: change.profile?.image ?? null,
              role: change.role,
              createdAt: at,
              membershipVersion: change.version,
            }),
          'upsert',
        )
        this.accountsWritten()
        await this.memberCreated?.(memberId)
        await this.audit('members.join', actor, { memberId, role: change.role }, at)
        return
      }

      const wasDisabled = existing.disabledAt !== null
      const disabled = change.state !== 'active'
      const roleChanged = existing.role !== change.role
      // The strongest change names the step; one applied snapshot steps once.
      // A durable authority revision also captures changes between catch-ups
      // that returned to the same role/state. Gates still read only this generation.
      const reason: MemberAccessChange['reason'] | undefined = removed
        ? 'removed'
        : disabled !== wasDisabled
          ? disabled
            ? 'disabled'
            : 'enabled'
          : roleChanged || (change.authorizationVersion ?? 0) > existing.membershipVersion
            ? 'role'
            : undefined

      await this.committed.write(async () => {
        const [written] = await writeMemberFacts(this.db).all({
          id: memberId,
          role: change.role,
          disabledAt: disabled ? (existing.disabledAt ?? at) : null,
          displayName: change.profile?.name ?? existing.displayName,
          avatar: change.profile ? change.profile.image : existing.avatar,
          email,
          accountId,
          membershipVersion: change.version,
        })
        this.accountsWritten()
        const bumped = reason ? await this.bumpAuthorization(memberId, reason) : undefined
        const row = bumped ?? written
        return row ? [row] : []
      }, 'upsert')

      // A member who may not act keeps no sign-in from before shared sign-in
      // either (POD-6751, R16). Enabling them again brings none back.
      if (disabled) await this.oldSignIns.endForMember(memberId)

      if (roleChanged) {
        await this.audit(
          'members.setRole',
          actor,
          { memberId, from: existing.role, to: change.role },
          at,
        )
      }
      if (disabled !== wasDisabled && !removed) {
        await this.audit(
          disabled ? 'members.disable' : 'members.enable',
          actor,
          { memberId, runningAgentPolicy: 'let-finish' },
          at,
        )
      }
      if (removed) {
        const held = await custodyMachinesOf(this.db).all({ grantee: memberId })
        // A custody release is its own event, with no recipient.
        for (const machine of held) {
          await this.machinesRepository.setMachineOwner(machine.id, null)
          await this.audit(
            'machines.transferOwnership',
            actor,
            {
              memberId,
              machineId: machine.id,
              previousOwnerUserId: memberId,
              newOwnerUserId: null,
            },
            at,
          )
        }
        // One member event per successful removal, even when no custody changed.
        // Detail contains only the public id, never credentials or profile data.
        await this.audit('members.remove', actor, { memberId }, at)
        // Keep other members' shares, including shares granted by this member.
        // Only the removed member's incoming grants are invalidated.
        await this.grantsRepository.removeAllForGrantee(memberId)
      }
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

  /**
   * Ends every sign-in a member still holds from before shared sign-in, and
   * its carry records (POD-6751, R16). For the paths that end all device
   * sign-ins of a member without changing the membership; call it in their
   * transaction.
   */
  async endOldSignIns(memberId: UserId): Promise<void> {
    await this.oldSignIns.endForMember(memberId)
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
