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

import type { UserRole } from '@podium/model'
import { USER_ROLES } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'

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
}
