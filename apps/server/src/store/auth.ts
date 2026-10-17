/**
 * Auth aggregate — owns `client_sessions` (persistent human-client login
 * sessions for the web/desktop UI). We store only the SHA-256 of the cookie
 * token, never the token itself, so a DB read can't mint a valid cookie.
 * Persisted (not in-memory) so a server redeploy doesn't force every device
 * to re-login.
 *
 * ---------------------------------------------------------------------------
 * A ROW IS A DEVICE THAT RESOLVES TO A USER (POD-1075, ADR 9 D1.3)
 * ---------------------------------------------------------------------------
 *
 * Every row now carries a `user_id`. That does NOT mean the login can tell two
 * people apart — `auth-store.ts` is still one shared password, so every session
 * this repository mints belongs to the first admin, and
 * `CLIENT_PRINCIPAL_GRADE` stays `'device'` accordingly. What it means is that
 * "which device" and "who" are two answers in storage instead of one, which is
 * what makes per-user login (POD-315) a change to the AUTHENTICATOR rather than
 * a second table migration after the wire cutover.
 *
 * `createClientSession` takes the user as a REQUIRED parameter rather than
 * defaulting it here. A default would be the one place a future per-user login
 * could silently keep writing the first admin's id for everybody, and the
 * failure would be invisible: every session would work, and every session would
 * belong to the wrong person.
 */

import type { UserId } from '@podium/model'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { clientSessions, users } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { executeRaw, param, prepared } from './executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

const memberDisabledAt = prepared((db: StoreDrizzle) =>
  db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, param(users.id, 'userId')))
    .prepare(),
)

// REPLACE-STATEMENT POD-3403 — rule 31b: path + token + SQL shape, all three.
const replaceClientSession = prepared((db: StoreDrizzle) =>
  db.run(
    sql`INSERT OR REPLACE INTO client_sessions
          (token_hash, user_id, created_at, expires_at, label, session_id, device_id, device_name, platform, last_seen_at)
        VALUES (${sql.placeholder('tokenHash')}, ${sql.placeholder('userId')}, ${sql.placeholder('createdAt')}, ${sql.placeholder('expiresAt')}, ${sql.placeholder('label')},
                ${sql.placeholder('sessionId')}, ${sql.placeholder('deviceId')}, ${sql.placeholder('deviceName')},
                ${sql.placeholder('platform')}, ${sql.placeholder('lastSeenAt')})`,
  ),
)

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

const deleteClientSessionsWithLabel = prepared((db: StoreDrizzle) =>
  db
    .delete(clientSessions)
    .where(eq(clientSessions.label, param(clientSessions.label, 'label')))
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

const setClientSessionExpiresAt = prepared((db: StoreDrizzle) =>
  db
    .update(clientSessions)
    .set({ expiresAt: sql.placeholder('expiresAt') })
    .where(eq(clientSessions.tokenHash, param(clientSessions.tokenHash, 'tokenHash')))
    .prepare(),
)

const setClientSessionLastSeenAt = prepared((db: StoreDrizzle) =>
  db
    .update(clientSessions)
    .set({ lastSeenAt: sql.placeholder('lastSeenAt') })
    .where(eq(clientSessions.tokenHash, param(clientSessions.tokenHash, 'tokenHash')))
    .prepare(),
)

const ownedMobileClientSessionTokenHash = prepared((db: StoreDrizzle) =>
  db
    .select({ tokenHash: clientSessions.tokenHash })
    .from(clientSessions)
    .where(
      and(
        eq(clientSessions.sessionId, param(clientSessions.sessionId, 'sessionId')),
        eq(clientSessions.userId, param(clientSessions.userId, 'userId')),
        eq(clientSessions.label, 'mobile'),
      ),
    )
    .prepare(),
)

const deleteClientSessionByTokenHash = prepared((db: StoreDrizzle) =>
  db
    .delete(clientSessions)
    .where(eq(clientSessions.tokenHash, param(clientSessions.tokenHash, 'tokenHash')))
    .prepare(),
)

const deleteEveryClientSession = prepared((db: StoreDrizzle) => db.delete(clientSessions).prepare())

const deleteClientSessionsExpiredBy = prepared((db: StoreDrizzle) =>
  db
    .delete(clientSessions)
    .where(lte(clientSessions.expiresAt, param(clientSessions.expiresAt, 'nowIso')))
    .prepare(),
)

export interface ClientSessionMetadata {
  sessionId?: string
  deviceId?: string
  deviceName?: string
  platform?: string
  lastSeenAt?: string
}

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

export class DisabledMemberError extends Error {
  constructor() { super('Member disabled') }
}

export class AuthRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The store's one drizzle instance; the executor routes each statement to the current transaction. */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  /** Record a login session for `userId`, keyed by the SHA-256 of its cookie
   *  token. `userId` is the person the device resolves to — today always the
   *  first admin, because the shared-password transport cannot authenticate a
   *  second one (POD-315). `label` says WHY the row exists so the classes stay
   *  separately revocable (POD-1376): the default 'login' is a browser sign-in,
   *  'upstream' a node⇄hub provisioning token, 'break-glass' a session minted
   *  from local state-dir access. */
  async createClientSession(
    tokenHash: string,
    userId: UserId,
    expiresAt: string,
    label = 'login',
    metadata: ClientSessionMetadata = {},
  ): Promise<void> {
    // `client_sessions` carries a second uniqueness constraint
    // (`idx_client_sessions_session_id`) besides its primary key. `INSERT OR
    // REPLACE` resolves a conflict on EITHER, while drizzle's targeted
    // `onConflictDoUpdate` raises on the other. Rule 31b therefore preserves
    // this atomic statement instead of changing mobile re-pair behaviour on the
    // auth path.
    await this.createOrJoinTransaction(async () => {
      const member = await memberDisabledAt(this.db).get({ userId })
      if (member?.disabledAt != null) throw new DisabledMemberError()
      // REPLACE-STATEMENT POD-3403 — rule 31b: path + token + SQL shape, all three.
      await executeRaw(replaceClientSession(this.db), {
        tokenHash,
        userId,
        createdAt: new Date().toISOString(),
        expiresAt,
        label,
        sessionId: metadata.sessionId ?? null,
        deviceId: metadata.deviceId ?? null,
        deviceName: metadata.deviceName ?? null,
        platform: metadata.platform ?? null,
        lastSeenAt: metadata.lastSeenAt ?? null,
      })
    })
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

  /** Revoke every session minted under `label`, leaving the other classes alone.
   *  Returns how many rows went. */
  async deleteClientSessionsByLabel(label: string): Promise<number> {
    // `changes` is number|bigint across the two drivers; the count here is always small.
    return Number(
      (await deleteClientSessionsWithLabel(this.db).run({ label })).changes,
    )
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

  /** Push out an existing session's expiry (sliding/rolling renewal). No-op if absent. */
  async extendClientSession(tokenHash: string, expiresAt: string): Promise<void> {
    await setClientSessionExpiresAt(this.db).run({ tokenHash, expiresAt })
  }

  async touchClientSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    await setClientSessionLastSeenAt(this.db).run({ tokenHash, lastSeenAt })
  }

  async listMobileClientSessions(userId: UserId): Promise<ClientSessionRow[]> {
    return (await this.listClientSessionsOfUser(userId)).filter((session) => session.label === 'mobile')
  }

  async deleteOwnedMobileClientSession(sessionId: string, userId: UserId): Promise<string | undefined> {
    const row = await ownedMobileClientSessionTokenHash(this.db).get({ sessionId, userId })
    if (!row) return undefined
    await deleteClientSessionByTokenHash(this.db).run({ tokenHash: row.tokenHash })
    return row.tokenHash
  }

  /** True iff the session exists and has not expired as of `nowIso`. */
  async isClientSessionValid(tokenHash: string, nowIso: string): Promise<boolean> {
    const session = await this.getClientSession(tokenHash)
    return Boolean(session && session.expiresAt > nowIso)
  }

  async deleteClientSession(tokenHash: string): Promise<void> {
    await deleteClientSessionByTokenHash(this.db).run({ tokenHash })
  }

  /** Revoke every client login session ("sign out everywhere"). */
  async deleteAllClientSessions(): Promise<void> {
    await deleteEveryClientSession(this.db).run()
  }

  /** Housekeeping: drop sessions whose expiry has passed. */
  async deleteExpiredClientSessions(nowIso: string): Promise<void> {
    await deleteClientSessionsExpiredBy(this.db).run({ nowIso })
  }
}
