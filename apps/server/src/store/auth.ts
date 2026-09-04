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
import { clientSessions } from '../migrations/schema'
import type { SyncDrizzle } from './executor/sync-drizzle'

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

export class AuthRepository {
  constructor(private readonly db: SyncDrizzle) {}

  /** Record a login session for `userId`, keyed by the SHA-256 of its cookie
   *  token. `userId` is the person the device resolves to — today always the
   *  first admin, because the shared-password transport cannot authenticate a
   *  second one (POD-315). `label` says WHY the row exists so the classes stay
   *  separately revocable (POD-1376): the default 'login' is a browser sign-in,
   *  'upstream' a node⇄hub provisioning token, 'break-glass' a session minted
   *  from local state-dir access. */
  createClientSession(
    tokenHash: string,
    userId: UserId,
    expiresAt: string,
    label = 'login',
    metadata: ClientSessionMetadata = {},
  ): void {
    // DECISION POD-3403 — NOT converted. `client_sessions` carries a second
    // uniqueness constraint (`idx_client_sessions_session_id`) besides its
    // primary key, and `INSERT OR REPLACE` resolves a conflict on EITHER of
    // them. drizzle offers only `onConflictDoUpdate`, which names ONE target and
    // raises on the other: measured on bun:sqlite, a re-pair that reuses a
    // `session_id` under a new `token_hash` replaces the row today and would
    // throw after the conversion. That is a behaviour change on the auth path,
    // so the statement stays raw until the rule lands.
    this.db.run(
      sql`INSERT OR REPLACE INTO client_sessions
            (token_hash, user_id, created_at, expires_at, label, session_id, device_id, device_name, platform, last_seen_at)
          VALUES (${tokenHash}, ${userId}, ${new Date().toISOString()}, ${expiresAt}, ${label},
                  ${metadata.sessionId ?? null}, ${metadata.deviceId ?? null}, ${metadata.deviceName ?? null},
                  ${metadata.platform ?? null}, ${metadata.lastSeenAt ?? null})`,
    )
  }

  /** Every session row, newest first — the read behind `podium auth sessions`. Returns
   *  hashes, never tokens: the plaintext is not stored and cannot be recovered. */
  listClientSessions(): ClientSessionRow[] {
    const rows = this.db
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
      .orderBy(desc(clientSessions.createdAt))
      .all()
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
  deleteClientSessionsByLabel(label: string): number {
    // `changes` is number|bigint across the two drivers; the count here is always small.
    return Number(
      this.db.delete(clientSessions).where(eq(clientSessions.label, label)).run().changes,
    )
  }

  getClientSession(
    tokenHash: string,
  ): Omit<ClientSessionRow, 'tokenHash' | 'createdAt'> | undefined {
    const row = this.db
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
      .where(eq(clientSessions.tokenHash, tokenHash))
      .get()
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
  extendClientSession(tokenHash: string, expiresAt: string): void {
    this.db
      .update(clientSessions)
      .set({ expiresAt })
      .where(eq(clientSessions.tokenHash, tokenHash))
      .run()
  }

  touchClientSession(tokenHash: string, lastSeenAt: string): void {
    this.db
      .update(clientSessions)
      .set({ lastSeenAt })
      .where(eq(clientSessions.tokenHash, tokenHash))
      .run()
  }

  listMobileClientSessions(userId: UserId): ClientSessionRow[] {
    return this.listClientSessions().filter(
      (session) => session.userId === userId && session.label === 'mobile',
    )
  }

  deleteOwnedMobileClientSession(sessionId: string, userId: UserId): string | undefined {
    const row = this.db
      .select({ tokenHash: clientSessions.tokenHash })
      .from(clientSessions)
      .where(
        and(
          eq(clientSessions.sessionId, sessionId),
          eq(clientSessions.userId, userId),
          eq(clientSessions.label, 'mobile'),
        ),
      )
      .get()
    if (!row) return undefined
    this.db.delete(clientSessions).where(eq(clientSessions.tokenHash, row.tokenHash)).run()
    return row.tokenHash
  }

  /** True iff the session exists and has not expired as of `nowIso`. */
  isClientSessionValid(tokenHash: string, nowIso: string): boolean {
    const session = this.getClientSession(tokenHash)
    return Boolean(session && session.expiresAt > nowIso)
  }

  deleteClientSession(tokenHash: string): void {
    this.db.delete(clientSessions).where(eq(clientSessions.tokenHash, tokenHash)).run()
  }

  /** Revoke every client login session ("sign out everywhere"). */
  deleteAllClientSessions(): void {
    this.db.delete(clientSessions).run()
  }

  /** Housekeeping: drop sessions whose expiry has passed. */
  deleteExpiredClientSessions(nowIso: string): void {
    this.db.delete(clientSessions).where(lte(clientSessions.expiresAt, nowIso)).run()
  }
}
