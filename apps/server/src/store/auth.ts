// LEGACY(remove-after: 2027-06): reads of pre-upgrade device sign-ins; new sign-ins live in the shared identity core.
import type { UserId } from '@podium/model'
import { desc, eq } from 'drizzle-orm'
import { clientSessions } from '../migrations/schema'
import { param, prepared, type StoreDrizzle, type StoreQueries } from './executor/sync-drizzle'

/** One person's sign-ins, newest first, through `idx_client_sessions_user` (POD-6172). */
const clientSessionsOfUserNewestFirst = prepared((db: StoreDrizzle) =>
  db
    .select({
      tokenHash: clientSessions.tokenHash,
      userId: clientSessions.userId,
      createdAt: clientSessions.createdAt,
      expiresAt: clientSessions.expiresAt,
      label: clientSessions.label,
      sessionId: clientSessions.sessionId,
      deviceId: clientSessions.deviceId,
      deviceName: clientSessions.deviceName,
      platform: clientSessions.platform,
      lastSeenAt: clientSessions.lastSeenAt,
    })
    .from(clientSessions)
    .where(eq(clientSessions.userId, param(clientSessions.userId, 'userId')))
    .orderBy(desc(clientSessions.createdAt))
    .prepare(),
)

const clientSessionByTokenHash = prepared((db: StoreDrizzle) =>
  db
    .select({
      userId: clientSessions.userId,
      expiresAt: clientSessions.expiresAt,
      label: clientSessions.label,
      sessionId: clientSessions.sessionId,
      deviceId: clientSessions.deviceId,
      deviceName: clientSessions.deviceName,
      platform: clientSessions.platform,
      lastSeenAt: clientSessions.lastSeenAt,
    })
    .from(clientSessions)
    .where(eq(clientSessions.tokenHash, param(clientSessions.tokenHash, 'tokenHash')))
    .prepare(),
)

export interface ClientSessionRow {
  tokenHash: string
  sessionId?: string
  userId: UserId
  createdAt: string
  expiresAt: string
  label: string
  deviceId?: string
  deviceName?: string
  platform?: string
  lastSeenAt?: string
}

/** Historical rows for upgrade fixtures and diagnostics. Never used to admit a request. */
export class AuthRepository {
  constructor(private readonly queries: StoreQueries) {}

  private get db() {
    return this.queries.rootDb
  }

  /** One person's session rows, newest first. Returns hashes, never tokens: the
   *  plaintext is not stored and cannot be recovered. */
  async listClientSessionsOfUser(userId: UserId): Promise<ClientSessionRow[]> {
    const rows = await clientSessionsOfUserNewestFirst(this.db).all({ userId })
    return rows.map((r) => ({
      tokenHash: r.tokenHash,
      userId: r.userId,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      label: r.label,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.deviceId ? { deviceId: r.deviceId } : {}),
      ...(r.deviceName ? { deviceName: r.deviceName } : {}),
      ...(r.platform ? { platform: r.platform } : {}),
      ...(r.lastSeenAt ? { lastSeenAt: r.lastSeenAt } : {}),
    }))
  }

  async getClientSession(
    tokenHash: string,
  ): Promise<Omit<ClientSessionRow, 'tokenHash' | 'createdAt'> | undefined> {
    const row = await clientSessionByTokenHash(this.db).get({ tokenHash })
    return row
      ? {
          userId: row.userId,
          expiresAt: row.expiresAt,
          label: row.label,
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
          ...(row.deviceId ? { deviceId: row.deviceId } : {}),
          ...(row.deviceName ? { deviceName: row.deviceName } : {}),
          ...(row.platform ? { platform: row.platform } : {}),
          ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
        }
      : undefined
  }
}
