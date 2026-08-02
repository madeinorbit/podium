/**
 * Auth aggregate — owns `client_sessions` (persistent human-client login
 * sessions for the web/desktop UI). We store only the SHA-256 of the cookie
 * token, never the token itself, so a DB read can't mint a valid cookie.
 * Persisted (not in-memory) so a server redeploy doesn't force every device
 * to re-login.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export class AuthRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Record a login session keyed by the SHA-256 of its cookie token. `label` says WHY
   *  the row exists so the classes stay separately revocable (POD-1376): the default
   *  'login' is a browser sign-in, 'upstream' a node⇄hub provisioning token,
   *  'break-glass' a session minted from local state-dir access. */
  createClientSession(tokenHash: string, expiresAt: string, label = 'login'): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO client_sessions (token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, new Date().toISOString(), expiresAt, label)
  }

  /** Every session row, newest first — the read behind `podium auth sessions`. Returns
   *  hashes, never tokens: the plaintext is not stored and cannot be recovered. */
  listClientSessions(): {
    tokenHash: string
    createdAt: string
    expiresAt: string
    label: string
  }[] {
    const rows = this.db
      .prepare(
        'SELECT token_hash, created_at, expires_at, label FROM client_sessions ORDER BY created_at DESC',
      )
      .all() as { token_hash: string; created_at: string; expires_at: string; label: string }[]
    return rows.map((r) => ({
      tokenHash: r.token_hash,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      label: r.label,
    }))
  }

  /** Revoke every session minted under `label`, leaving the other classes alone.
   *  Returns how many rows went. */
  deleteClientSessionsByLabel(label: string): number {
    // `changes` is number|bigint across the two drivers; the count here is always small.
    return Number(this.db.prepare('DELETE FROM client_sessions WHERE label = ?').run(label).changes)
  }

  getClientSession(tokenHash: string): { expiresAt: string } | undefined {
    const row = this.db
      .prepare('SELECT expires_at FROM client_sessions WHERE token_hash = ?')
      .get(tokenHash) as { expires_at: string } | undefined
    return row ? { expiresAt: row.expires_at } : undefined
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
