import { asUserId, newMemberId, userIdFromMemberId, type UserRole } from '@podium/model'
import { MemberInvites } from './member-invites'
import type { UsersRepository } from './store/users'

/** A workspace member identity; future workspace and run scopes can extend this object. */
export interface Principal {
  memberId: string
  role: UserRole
}

export interface PrincipalRequest {
  cookieHeader?: string
  authorizationHeader?: string
  url: string
}

export function createPluginAuth(users: UsersRepository) {
  const invites = new MemberInvites(users)
  return {
    principalSource: undefined as
      | ((request: PrincipalRequest) => Promise<Principal | null>)
      | undefined,
    async createMemberForAccount(
      accountId: string,
      role: UserRole,
      name: string,
      avatar: string | null,
    ) {
      if (!accountId.trim() || accountId.length > 255) throw new Error('Account id is required')
      return await users.claimTransaction(async () => {
        const id = userIdFromMemberId(newMemberId())
        await users.createUnclaimed({
          id,
          displayName: name,
          email: null,
          role,
          createdAt: new Date().toISOString(),
          disabledAt: null,
        })
        await users.attachAccount(id, accountId)
        await users.writeProfile(id, name, avatar)
        return (await users.get(id))!
      })
    },
    async claimMemberForAccount(memberId: string, accountId: string) {
      return await invites.complete({
        preAuthorizedMemberId: asUserId(memberId),
        identity: { kind: 'account', accountId },
      })
    },
    writeProfile: (memberId: string, name: string, avatar: string | null) =>
      users.writeProfile(asUserId(memberId), name, avatar),
    findMemberByAccount: (accountId: string) => users.findMemberByAccount(accountId),
  }
}

export type PluginAuth = ReturnType<typeof createPluginAuth>

/** null means no provider identity; false means a supplied identity must be refused. */
export type ProviderPrincipal = Principal | null | undefined | false

export async function enabledProviderPrincipal(
  supplied: Principal | null | undefined,
  users?: {
    get(
      id: ReturnType<typeof asUserId>,
    ): Promise<{ role: UserRole; disabledAt?: string | null } | undefined>
  },
): Promise<ProviderPrincipal> {
  if (supplied == null) return supplied
  if (typeof supplied.memberId !== 'string' || !supplied.memberId) return false
  const member = await users?.get(asUserId(supplied.memberId))
  return member && !member.disabledAt ? { memberId: supplied.memberId, role: member.role } : false
}
