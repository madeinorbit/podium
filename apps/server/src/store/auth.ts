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

import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { UserId } from '@podium/model'

export class AuthRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Record a login session for `userId`, keyed by the SHA-256 of its cookie
   *  token. `userId` is the person the device resolves to — today always the
   *  first admin, because the shared-password transport cannot authenticate a
   *  second one (POD-315). */
  createClientSession(tokenHash: string, userId: UserId, expiresAt: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO client_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, userId, new Date().toISOString(), expiresAt)
  }

  getClientSession(tokenHash: string): { userId: UserId; expiresAt: string } | undefined {
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM client_sessions WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: string } | undefined
    return row ? { userId: row.user_id as UserId, expiresAt: row.expires_at } : undefined
  }

  /** Push out an existing session's expiry (sliding/rolling renewal). No-op if absent. */
  extendClientSession(tokenHash: string, expiresAt: string): void {
    this.db
      .prepare('UPDATE client_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(expiresAt, tokenHash)
  }

  /** True iff the session exists and has not expired as of `nowIso`. */
  isClientSessionValid(tokenHash: string, nowIso: string): boolean {
    const session = this.getClientSession(tokenHash)
    return Boolean(session && session.expiresAt > nowIso)
  }

  deleteClientSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM client_sessions WHERE token_hash = ?').run(tokenHash)
  }

  /** Revoke every client login session ("sign out everywhere"). */
  deleteAllClientSessions(): void {
    this.db.prepare('DELETE FROM client_sessions').run()
  }

  /** Housekeeping: drop sessions whose expiry has passed. */
  deleteExpiredClientSessions(nowIso: string): void {
    this.db.prepare('DELETE FROM client_sessions WHERE expires_at <= ?').run(nowIso)
  }
}
