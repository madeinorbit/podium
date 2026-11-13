// LEGACY(remove-after: 2027-06): boot-only readers of pre-upgrade passwords and invitations; removal ends import from older databases.
/** The boot import is the only reader of pre-identity credentials and links. */
import { asUserId } from '@podium/model'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { memberInvites, userCredentials } from '../migrations/identity-import-schema'
import { clientSessions } from '../migrations/schema'
import { prepared, type StoreDrizzle, type StoreQueries } from './executor/sync-drizzle'

const passwords = prepared((db: StoreDrizzle) =>
  db
    .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(
      and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
    )
    .prepare(),
)
const links = prepared((db: StoreDrizzle) =>
  db.select().from(memberInvites).orderBy(asc(memberInvites.createdAt)).prepare(),
)
const retiredSessions = prepared((db: StoreDrizzle) =>
  db
    .delete(clientSessions)
    .where(inArray(clientSessions.label, ['upstream', 'server-transfer-claim']))
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
