/** Pre-upgrade fixture rows. Production code no longer mints these credentials. */
import type { UserId } from '@podium/model'
import { clientSessions } from '../migrations/schema'
import type { SessionStore } from '../store'

export async function seedLegacyClientSession(
  store: SessionStore,
  tokenHash: string,
  userId: UserId,
  expiresAt: string,
  label = 'login',
  device: Partial<
    Pick<
      typeof clientSessions.$inferInsert,
      'sessionId' | 'deviceId' | 'deviceName' | 'platform' | 'lastSeenAt'
    >
  > = {},
): Promise<void> {
  const database = store.identityDatabase()
  if (database.dialect !== 'sqlite') throw new Error('Expected a server database')
  await database.db.insert(clientSessions).values({
    workspaceId: store.workspaceId,
    tokenHash,
    userId,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
    label,
    ...device,
  })
}
