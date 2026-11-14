/**
 * A MEMBER'S PASSWORD AND ADDRESS, THROUGH THEIR ACCOUNT (POD-6746;
 * docs/design/people-and-sign-in.md, section 4.6).
 *
 * A password belongs to an account of the identity package, not to a member
 * row. The server's own code still speaks about members: "the caller sets
 * their password", "setup gives the first admin one". This is the one place
 * that goes from the member to their account, so no caller writes a password
 * anywhere else.
 *
 * The account of a member is the account id on their member row, which only
 * apply-membership writes.
 */
import type { AccountOperations } from '@podium/identity'
import type { UserId } from '@podium/model'

/** The member has no account: no membership has been applied to their row. */
export class MemberHasNoAccount extends Error {
  constructor(readonly memberId: UserId) {
    super('this member has no account to sign in with')
    this.name = 'MemberHasNoAccount'
  }
}

export interface MemberCredentials {
  /** False for a member without an account. */
  hasPassword(memberId: UserId): Promise<boolean>
  /** False for a member without an account or without a password. */
  verifyPassword(memberId: UserId, password: string): Promise<boolean>
  setPassword(memberId: UserId, password: string): Promise<void>
  /**
   * From a hash this edition's own password functions made: a password staged
   * before the server ran, or one hashed before the caller's transaction.
   */
  setPasswordHash(memberId: UserId, passwordHash: string): Promise<void>
  setEmail(memberId: UserId, email: string): Promise<void>
}

export function memberCredentials(
  users: {
    get(
      id: UserId,
    ):
      | { accountId?: string | null }
      | undefined
      | Promise<{ accountId?: string | null } | undefined>
  },
  /**
   * Read per call: the server opens its identity after the registry that holds
   * these credentials (POD-6939).
   */
  accounts: () => AccountOperations,
): MemberCredentials {
  const accountOf = async (memberId: UserId): Promise<string | undefined> =>
    (await users.get(memberId))?.accountId ?? undefined
  const requireAccount = async (memberId: UserId): Promise<string> => {
    const accountId = await accountOf(memberId)
    if (!accountId) throw new MemberHasNoAccount(memberId)
    return accountId
  }
  return {
    async hasPassword(memberId) {
      const accountId = await accountOf(memberId)
      return accountId ? await accounts().hasPassword(accountId) : false
    },
    async verifyPassword(memberId, password) {
      const accountId = await accountOf(memberId)
      return accountId ? await accounts().verifyPassword(accountId, password) : false
    },
    async setPassword(memberId, password) {
      await accounts().setPassword(await requireAccount(memberId), password)
    },
    async setPasswordHash(memberId, passwordHash) {
      await accounts().setPasswordHash(await requireAccount(memberId), passwordHash)
    },
    async setEmail(memberId, email) {
      await accounts().setEmail(await requireAccount(memberId), email)
    },
  }
}
