/** Member-row fixtures for repository tests. Transport tests use real memberships. */
import { applyMembership, type MembershipSnapshot } from '@podium/identity'
import { asUserId, LoginEmail, type UserId, type UserRole } from '@podium/model'
import { eq } from 'drizzle-orm'
import { memberInvites, userCredentials } from '../../migrations/identity-import-schema'
import { users } from '../../migrations/schema'
import type { SessionStore } from '../../store'
import { captureWrite } from '../../sync/capture-pg'
import { seedRows } from '../../test-support/seed-rows'
import { type StoreDrizzle, storeTables } from '../executor/sync-drizzle'
import type { UserAccountRow } from '../users'

/**
 * Member-row facts on either engine [POD-6994]: the store's own drizzle instance and the
 * engine's tables (`storeTables`), so the same fixture writes SQLite and Postgres. The
 * historical insert of a member row goes through `captureWrite`, so Postgres captures it
 * as SQLite's triggers do.
 */
export function memberFacts(store: SessionStore) {
  const db = store.identityDatabase().db as unknown as StoreDrizzle
  const t = storeTables(db)
  async function write(id: string, change: Partial<MembershipSnapshot>) {
    await store.transact(async () => {
      const [row] = await db
        .select()
        .from(t.users)
        .where(eq(t.users.id, asUserId(id)))
      await applyMembership(store.users.memberRows, {
        memberId: id,
        version: (row?.membershipVersion ?? 0) + 1,
        authorizationVersion: 0,
        status: row?.disabledAt ? 'disabled' : 'active',
        role: (row?.role as UserRole) ?? 'member',
        accountId: row?.cloudAccountId ?? null,
        profile: {
          name: row?.displayName ?? 'Member',
          email: row?.email ?? null,
          image: row?.avatar ?? null,
        },
        actor: { system: 'upgrade' },
        ...change,
      })
    })
  }
  return {
    async verifyAccountEmail(accountId: string) {
      await db
        .update(t.identityUser)
        .set({ emailVerified: true })
        .where(eq(t.identityUser.id, accountId))
    },
    async create(
      account: Omit<UserAccountRow, 'email'> & { email?: string | null },
      _unusedHash?: string,
    ) {
      // Historical repository facts first (the given creation time), then the
      // one member writer. One change-log commit, as a member joining is (POD-6920): the row's
      // capture reaches the machine access and per-user records, the member
      // gets the global thread the joining hook makes, and the member writer
      // joins the same commit.
      const id = asUserId(account.id)
      await store.grants.machineRecordWrites.compare(async () => {
        await store.transact(async () => {
          await captureWrite(
            db.insert(t.users).values({
              workspaceId: store.workspaceId,
              id,
              displayName: account.displayName,
              email: account.email == null ? null : LoginEmail.parse(account.email),
              role: account.role,
              createdAt: account.createdAt,
            }),
          )
          await store.superagent.seedMemberGlobalThread(id)
          await write(account.id, { role: account.role, status: 'active' })
          if (account.disabledAt) await write(account.id, { status: 'disabled' })
        })
      })
    },
    async disable(id: UserId, _at?: string, actor?: UserId) {
      await write(id, { status: 'disabled', ...(actor ? { actor: { memberId: actor } } : {}) })
    },
    async enable(id: UserId, _at?: string, actor?: UserId) {
      await write(id, { status: 'active', ...(actor ? { actor: { memberId: actor } } : {}) })
    },
    async removeMember(id: UserId, actor: UserId) {
      await write(id, { status: 'removed', actor: { memberId: actor } })
    },
    async setRole(id: UserId, role: UserRole, actor?: UserId) {
      await write(id, { role, ...(actor ? { actor: { memberId: actor } } : {}) })
    },
    async writeProfile(id: UserId, name: string, image: string | null) {
      const row = (await store.users.listIncludingDisabled()).find((row) => row.id === id)
      await write(id, { profile: { name, image, email: row?.email ?? null } })
    },
    async setEmail(id: UserId, email: string) {
      const row = (await store.users.listIncludingDisabled()).find((row) => row.id === id)
      await write(id, {
        profile: {
          name: row?.displayName ?? 'Member',
          image: row?.avatar ?? null,
          email: LoginEmail.parse(email),
        },
      })
    },
  }
}

/**
 * The pre-identity tables a SQLite install may still hold until its boot import retires
 * them. SQLite only: a Postgres baseline never had them (`legacyIdentityStorage`).
 */
export function legacyIdentity(store: SessionStore) {
  const database = store.identityDatabase()
  if (database.dialect !== 'sqlite') {
    throw new Error('legacyIdentity: the pre-identity tables exist on SQLite installs only')
  }
  const db = database.db
  async function setPasswordHash(id: UserId, hash: string, at: string) {
    await db
      .insert(userCredentials)
      .values({ userId: id, source: 'per-user-scrypt', passwordHash: hash, updatedAt: at })
      .onConflictDoUpdate({
        target: userCredentials.userId,
        set: { passwordHash: hash, updatedAt: at },
      })
  }
  return {
    setPasswordHash,
    async create(
      account: Omit<UserAccountRow, 'email'> & { email?: string | null },
      hash?: string,
    ) {
      // Legacy rows are seeded below the change log (POD-6920).
      await seedRows(store, async () => {
        await db.insert(users).values({
          workspaceId: store.workspaceId,
          id: asUserId(account.id),
          displayName: account.displayName,
          role: account.role,
          email: account.email == null ? null : LoginEmail.parse(account.email),
          createdAt: account.createdAt,
          disabledAt: account.disabledAt,
        })
      })
      if (hash) await setPasswordHash(asUserId(account.id), hash, account.createdAt)
    },
    async disable(id: UserId, at: string) {
      await seedRows(store, async () => {
        await db.update(users).set({ disabledAt: at }).where(eq(users.id, id))
      })
    },
    async setEmail(id: UserId, email: string) {
      await db
        .update(users)
        .set({ email: LoginEmail.parse(email) })
        .where(eq(users.id, id))
    },
    async insertInvite(link: typeof memberInvites.$inferInsert) {
      await db.insert(memberInvites).values(link)
    },
  }
}
