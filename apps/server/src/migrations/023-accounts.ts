/**
 * Migration 023 — managed accounts [spec:SP-6454].
 *
 * Credentials Podium HOLDS and injects at spawn, as opposed to the native CLI
 * logins it merely observes. Deliberately its own table, NOT the settings blob:
 * `settings.get` round-trips the whole blob to the browser, so a credential
 * placed there would be shipped to every client.
 *
 * `credential` is plaintext in this migration — the same trust posture as the
 * existing settings.apiKeys. Encryption at rest is #218, which rewrites this
 * column in place and gates the refresh-token-bearing credentials (#214, and
 * managed OAuth). Only long-lived, non-refreshing credentials land here today.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      credential TEXT NOT NULL,
      identity TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'role',
      created_at INTEGER NOT NULL
    );
  `)
}
