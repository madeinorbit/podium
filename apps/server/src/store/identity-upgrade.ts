// LEGACY(remove-after: 2027-06): boot-only readers of pre-upgrade passwords and invitations; removal ends import from older databases.
// workspace-scoped (POD-6959)
/**
 * The boot import is the only reader of pre-identity credentials and links. Those
 * pre-upgrade tables are the install's (read once, for the one workspace `local`), so their
 * reads are global; the retired product sessions are the workspace's own.
 */
import { asUserId } from '@podium/model'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { memberInvites, userCredentials } from '../migrations/identity-import-schema'
import {
  inWorkspace,
  prepared,
  preparedGlobal,
  type WorkspaceQueries,
} from './executor/sync-drizzle'

const passwords = preparedGlobal((db) =>
  db
    .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(
      and(eq(userCredentials.source, 'per-user-scrypt'), isNotNull(userCredentials.passwordHash)),
    )
    .prepare(),
)
const links = preparedGlobal((db) =>
  db.select().from(memberInvites).orderBy(asc(memberInvites.createdAt)).prepare(),
)
const retiredSessions = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(
      inWorkspace(
        t.clientSessions,
        inArray(t.clientSessions.label, ['upstream', 'server-transfer-claim']),
      ),
    )
    .prepare(),
)

export class IdentityUpgradeRepository {
  /**
   * `legacyStorage` is false on a store that never held the pre-identity tables (a
   * Postgres baseline, POD-6994): there is nothing to import, so the two legacy reads
   * answer empty without a statement.
   */
  constructor(
    private readonly queries: WorkspaceQueries,
    private readonly options: { readonly legacyStorage: boolean } = { legacyStorage: true },
  ) {}

  async passwordHashes() {
    if (!this.options.legacyStorage) return new Map<ReturnType<typeof asUserId>, string>()
    const rows = await passwords(this.queries.db).all()
    return new Map(
      rows.flatMap(({ userId, passwordHash }) =>
        passwordHash ? [[asUserId(userId), passwordHash] as const] : [],
      ),
    )
  }

  async pendingLinks() {
    if (!this.options.legacyStorage) return []
    return await links(this.queries.db).all()
  }
  async retireSessions() {
    return Number((await retiredSessions(this.queries.db).run()).changes)
  }
}
