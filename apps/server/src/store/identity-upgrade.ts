// LEGACY(remove-after: 2027-06): boot-only readers of pre-upgrade passwords and invitations; removal ends import from older databases.
/** The boot import is the only reader of pre-identity credentials and links. */
import { asUserId } from '@podium/model'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { memberInvites, userCredentials } from '../migrations/identity-import-schema'
import { prepared, type StoreQueries } from './executor/sync-drizzle'

const passwords = prepared((db) =>
  db
    .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(
      and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
    )
    .prepare(),
)
const links = prepared((db) =>
  db.select().from(memberInvites).orderBy(asc(memberInvites.createdAt)).prepare(),
)
const retiredSessions = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(inArray(t.clientSessions.label, ['upstream', 'server-transfer-claim']))
    .prepare(),
)

export class IdentityUpgradeRepository {
  constructor(private readonly queries: StoreQueries) {}

  async passwordHashes() {
    const rows = await passwords(this.queries.rootDb).all()
    return new Map(
      rows.flatMap(({ userId, passwordHash }) =>
        passwordHash ? [[asUserId(userId), passwordHash] as const] : [],
      ),
    )
  }

  async pendingLinks() {
    return await links(this.queries.rootDb).all()
  }
  async retireSessions() {
    return Number((await retiredSessions(this.queries.rootDb).run()).changes)
  }
}
