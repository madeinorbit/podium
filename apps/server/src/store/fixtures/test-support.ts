/** Member-row fixtures for repository tests. Transport tests use real memberships. */
import { applyMembership, type MembershipSnapshot } from '@podium/identity'
import { identityUser } from '@podium/identity/schema/sqlite'
import { asUserId, LoginEmail, type UserId, type UserRole } from '@podium/model'
import { eq } from 'drizzle-orm'
import { memberInvites, userCredentials } from '../../migrations/identity-import-schema'
import { users } from '../../migrations/schema'
import type { SessionStore } from '../../store'
import { seedRows } from '../../test-support/seed-rows'
import type { UserAccountRow } from '../users'

export function memberFacts(store: SessionStore) {
  const database = store.identityDatabase()
  if (database.dialect !== 'sqlite') throw new Error('Expected SQLite')
  const db = database.db
  async function write(id: string, change: Partial<MembershipSnapshot>) {
    await store.transact(async () => {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, asUserId(id)))
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
        .update(identityUser)
        .set({ emailVerified: true })
        .where(eq(identityUser.id, accountId))
    },
    async create(
      account: Omit<UserAccountRow, 'email'> & { email?: string | null },
      _unusedHash?: string,
    ) {
      // Seed historical repository facts first, then publish through the one
      // member writer. Fixture setup does not represent a membership joining.
      // The historical row is seeded below the change log (POD-6920); the
      // member writer's own commit then publishes what it changed.
      await store.transact(async () => {
        await seedRows(store, async () => {
          await db.insert(users).values({
            id: asUserId(account.id),
            displayName: account.displayName,
            email: account.email == null ? null : LoginEmail.parse(account.email),
            role: account.role,
            createdAt: account.createdAt,
          })
        })
        await write(account.id, { role: account.role, status: 'active' })
        if (account.disabledAt) await write(account.id, { status: 'disabled' })
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

export function legacyIdentity(store: SessionStore) {
  const database = store.identityDatabase()
  if (database.dialect !== 'sqlite') throw new Error('Expected SQLite')
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
