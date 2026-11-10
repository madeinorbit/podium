/**
 * THE IDENTITY SEAM (POD-6746; docs/design/people-and-sign-in.md, section 3).
 *
 * A hosted composition root builds one identity core on Postgres for its
 * process and hands the server the workspace half of it through
 * `startServer({ identity })`. The option is a function because what it needs
 * from the server exists only after the server has opened its store.
 *
 * This file is everything the server gives that function. All of it is over
 * the workspace database; none of it is a secret or an address.
 */
import type { AppliedCursor, MemberRows, WorkspaceIdentity } from '@podium/identity'
import type { SessionStore } from '../store'

/** One member row of the workspace database, as the seam shows it. */
export interface ExistingMember {
  memberId: string
  role: 'admin' | 'member'
  /** A removed member is a disabled row too; only a membership tells the two apart. */
  disabled: boolean
  /** The account id on the row, which only apply-membership writes. */
  accountId: string | null
}

export interface IdentitySeamDeps {
  /** The server's member rows. The package's apply-membership is the only caller of `write`. */
  memberRows: MemberRows
  /**
   * One number in the workspace database's `meta` table (key
   * `identity.appliedMembershipVersion`): every membership change up to it has
   * been applied to the member rows. 0 before the first write.
   */
  appliedCursor: AppliedCursor
  /**
   * Every member row of the workspace database, disabled ones included, IN
   * CREATION ORDER, EARLIEST FIRST (rows created at the same instant are
   * ordered by member id). Read-only. A hosted root calls it once per boot,
   * before the server serves, to adopt the rows that carry an account id and
   * to find the earliest enabled admin row without one.
   */
  existingMembers(): Promise<ExistingMember[]>
}

/** What a hosted composition root passes as `startServer({ identity })`. */
export type IdentitySeam = (
  deps: IdentitySeamDeps,
) => WorkspaceIdentity | Promise<WorkspaceIdentity>

export function identitySeamDeps(store: SessionStore): IdentitySeamDeps {
  return {
    memberRows: store.users.memberRows,
    appliedCursor: {
      read: () => store.settings.appliedMembershipVersion(),
      write: (version) => store.settings.recordAppliedMembershipVersion(version),
    },
    existingMembers: async () =>
      (await store.users.listIncludingDisabled()).map((row) => ({
        memberId: row.id,
        role: row.role,
        disabled: row.disabledAt !== null,
        accountId: row.accountId ?? null,
      })),
  }
}
