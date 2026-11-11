/** Link ceremonies use the shared identity core; no local credential or invite store. */
import { MembershipRefused, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, LoginEmail, type UserId } from '@podium/model'
import { z } from 'zod'
import type { UsersRepository } from './store/users'

export const InvitePassword = z.string().min(8).max(1024)
export const CreateMemberInvite = z.object({
  memberId: z.string().min(1).optional(),
  email: LoginEmail.optional(),
  role: z.enum(['admin', 'member']).default('member'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
})
export const ADMIN_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000

/** The routes and the user-only host socket share these link ceremonies. */
export function memberLinks(options: {
  identity: WorkspaceIdentity
  users: UsersRepository
  onDeviceSignInEnded?: (id: string) => void
}) {
  const { identity, users } = options
  const { core, memberships } = identity
  const invalid = () =>
    new MembershipRefused('invitation-invalid', 'Link is invalid or no longer available')
  const requireAdmin = async (actor: UserId) => {
    const member = (await memberships.list()).find((m) => m.memberId === actor)
    if (member?.status !== 'active' || member.role !== 'admin')
      throw new MembershipRefused('admin-required')
  }
  const recoveryFor = async (memberId: string, actor: UserId | null) => {
    if (core.capabilities().passwordReset !== 'admin-link')
      throw new MembershipRefused('not-allowed')
    const member = (await memberships.list()).find((m) => m.memberId === memberId)
    if (member?.status !== 'active' || !member.account || !member.hasPassword)
      throw new MembershipRefused('unavailable', 'Member has no active password to recover')
    const code = await core.codes.issue({
      purpose: 'password-reset',
      accountId: member.account.id,
      createdBy: actor ?? 'host',
      ttlMs: ADMIN_RECOVERY_TTL_MS,
    })
    await users.audit('members.recoveryIssued', actor, {
      memberId,
      ...(actor ? {} : { by: 'host' }),
    })
    return {
      id: code.id,
      token: code.code,
      memberId,
      email: member.account.email,
      expiresAt: code.expiresAt.toISOString(),
    }
  }
  return {
    async createRecovery(actor: UserId, memberId: string) {
      return await core.transaction(async () => {
        await requireAdmin(actor)
        return await recoveryFor(memberId, actor)
      })
    },
    async createHostRecovery(email: string) {
      const address = LoginEmail.parse(email)
      return await core.transaction(async () => {
        const member = (await memberships.list()).find(
          (m) => m.status === 'active' && m.account?.email === address,
        )
        if (!member) throw new MembershipRefused('unavailable', 'No enabled member has that email')
        return await recoveryFor(member.memberId, null)
      })
    },
    async inspect(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid()
      try {
        return { kind: 'invitation' as const, ...(await memberships.inspectInvitation(token)) }
      } catch (error) {
        if (!(error instanceof MembershipRefused) || error.code !== 'invitation-invalid')
          throw error
      }
      const reset = await core.codes.inspectPasswordReset(token)
      if (!reset || core.capabilities().passwordReset !== 'admin-link') throw invalid()
      return { kind: 'password-reset' as const, ...reset }
    },
    async complete(input: {
      token: string
      password: string
      email?: string
      displayName?: string
    }) {
      const link = await this.inspect(input.token)
      if (link.kind === 'invitation') {
        const email = LoginEmail.parse(input.email)
        const name = z.string().trim().min(1).max(200).parse(input.displayName)
        const accepted = await memberships.accept({
          token: input.token,
          account: { kind: 'new', email, name, password: input.password },
        })
        return { userId: accepted.memberId }
      }
      // One transaction: the new password, the end of every device sign-in and
      // the end of every sign-in from before shared sign-in (POD-6751, R16).
      const { reset, member } = await core.transaction(async () => {
        const reset = await core.codes.redeemPasswordReset({
          code: input.token,
          password: input.password,
        })
        if (!reset) throw invalid()
        const member = (await memberships.list()).find((m) => m.account?.id === reset.accountId)
        if (!member) throw invalid()
        await users.endOldSignIns(asUserId(member.memberId))
        await users.audit('members.recover', asUserId(member.memberId), {
          memberId: member.memberId,
        })
        return { reset, member }
      })
      for (const id of reset.endedSignInIds) options.onDeviceSignInEnded?.(id)
      return { userId: member.memberId }
    },
  }
}
