/**
 * THE ACCOUNT ROLE READER (POD-1079) — the first reader the `users` table
 * (POD-1075) has had.
 *
 * `roleFloor` on a command contract is "which commands this principal may
 * ATTEMPT" (ADR 3 Amendment 1 D15), and the floor is compared against the
 * INSTANCE-LEVEL account role (ADR 9 D1.4), not against the per-command
 * capability role that already rides on the transport. Two different questions:
 * the capability says what this connection was granted, the account role says
 * what grade of person is behind it.
 *
 * Writes stay out of scope on purpose — invite / disable / remove are ADR 9
 * lifecycle commands and POD-290's, and a repository that could mint an admin
 * would be a privilege-escalation surface this issue has no use for.
 */

import type { CredentialSource, UserId, UserRole } from '@podium/model'
import { CREDENTIAL_SOURCES, USER_ROLES } from '@podium/model'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'

export interface UserAccountRow {
  id: string
  displayName: string
  role: UserRole
  createdAt: string
  /** ADR 9's disable-before-remove. A disabled account is not an actor. */
  disabledAt: string | null
}

/**
 * Role parsing FAILS CLOSED. A `role` column holding something this build does
 * not know — a third role written by a newer version — must not be admitted as
 * `admin`, and must not be silently downgraded to `member` either: it is
 * UNREADABLE, and an unreadable account satisfies no floor.
 */
const parseRole = (raw: unknown): UserRole | undefined =>
  typeof raw === 'string' && (USER_ROLES as readonly string[]).includes(raw)
    ? (raw as UserRole)
    : undefined

export interface UserCredentialRow {
  userId: UserId
  source: CredentialSource
  passwordHash: string | null
  updatedAt: string
}

export class UsersRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * One account, or `undefined` when there is no row, the row is unreadable, or
   * the account is disabled. All three collapse to "no account", because every
   * caller's next move is the same — refuse — and giving the caller three arms
   * to get wrong is how one of them ends up permissive.
   */
  get(userId: string): UserAccountRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | Record<string, unknown>
      | undefined
    if (!r) return undefined
    const role = parseRole(r.role)
    if (role === undefined) return undefined
    const disabledAt = (r.disabled_at as string | null | undefined) ?? null
    if (disabledAt !== null) return undefined
    return {
      id: r.id as string,
      displayName: r.display_name as string,
      role,
      createdAt: r.created_at as string,
      disabledAt,
    }
  }

  /** The account role, or `undefined` for an account that cannot act. */
  roleOf(userId: string): UserRole | undefined {
    return this.get(userId)?.role
  }

  list(): UserAccountRow[] {
    const rows = this.db.prepare('SELECT id FROM users ORDER BY created_at ASC').all() as {
      id: string
    }[]
    return rows.flatMap((row) => {
      const account = this.get(row.id)
      return account ? [account] : []
    })
  }

  credentialFor(userId: string): UserCredentialRow | undefined {
    if (!this.get(userId)) return undefined
    const row = this.db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(userId) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    // Source parsing FAILS CLOSED for the same reason `parseRole` does, and it is
    // load-bearing here rather than defensive: a leftover `'instance-password'` row from
    // before POD-1554 must read as NO CREDENTIAL, never as one this build might verify
    // against. The SQL migration deletes those rows; this is what happens if one survives.
    if (!(CREDENTIAL_SOURCES as readonly string[]).includes(row.source as string)) return undefined
    return {
      userId: row.user_id as UserId,
      source: row.source as CredentialSource,
      passwordHash: (row.password_hash as string | null | undefined) ?? null,
      updatedAt: row.updated_at as string,
    }
  }

  hasPerUserCredentials(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM user_credentials WHERE source = 'per-user-scrypt' AND password_hash IS NOT NULL LIMIT 1",
      )
      .get() as { present?: number } | undefined
    return row?.present === 1
  }

  create(account: UserAccountRow, passwordHash: string): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, NULL)',
        )
        .run(account.id, account.displayName, account.role, account.createdAt)
      this.db
        .prepare(
          "INSERT INTO user_credentials (user_id, source, password_hash, updated_at) VALUES (?, 'per-user-scrypt', ?, ?)",
        )
        .run(account.id, passwordHash, account.createdAt)
    })
  }

  setPasswordHash(userId: string, passwordHash: string, updatedAt: string): void {
    if (!this.get(userId)) throw new Error(`unknown user: ${userId}`)
    this.db
      .prepare(
        "INSERT INTO user_credentials (user_id, source, password_hash, updated_at) VALUES (?, 'per-user-scrypt', ?, ?) ON CONFLICT(user_id) DO UPDATE SET source = excluded.source, password_hash = excluded.password_hash, updated_at = excluded.updated_at",
      )
      .run(userId, passwordHash, updatedAt)
  }
}
