import { randomBytes } from 'node:crypto'
import {
  InviteId,
  LoginEmail,
  newInviteId,
  newMemberId,
  userIdFromMemberId,
  type UserId,
  type UserRole,
} from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { z } from 'zod'
import { hashToken } from './auth-route'
import type { UsersRepository } from './store/users'

export const InvitePassword = z.string().min(8).max(1024)
export const CreateMemberInvite = z.object({
  memberId: z.string().min(1).optional(),
  email: LoginEmail.optional(),
  role: z.enum(['admin', 'member']).default('member'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
})
export type InviteIdentity =
  | { kind: 'password'; password: string; email: string; displayName: string }
  | { kind: 'account'; accountId: string; displayName?: string }
export type InviteClaim =
  | { token: string; identity: InviteIdentity }
  // Only a trusted in-process hook may construct this arm. Never accepted over HTTP.
  | { preAuthorizedMemberId: UserId; identity: Extract<InviteIdentity, { kind: 'account' }> }

/** Shared by local invite completion and the hosted principal source. */
export class MemberInvites {
  constructor(
    private readonly users: UsersRepository,
    private readonly now = () => Date.now(),
  ) {}

  async create(actor: UserId, input: z.input<typeof CreateMemberInvite>) {
    const data = CreateMemberInvite.parse(input)
    return await this.users.claimTransaction(async () => {
      if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      const member = data.memberId ? await this.users.get(data.memberId as UserId) : undefined
      if (data.memberId && !member) throw new Error('Member unavailable')
      if (member?.accountId) throw new Error('Member is already claimed')
      if (member?.email && data.email && member.email !== data.email)
        throw new Error('Use the member’s existing email')
      const token = randomBytes(32).toString('base64url')
      const invite = {
        id: newInviteId(),
        tokenHash: hashToken(token),
        memberId: member ? (member.id as UserId) : null,
        email: member?.email ?? data.email ?? null,
        role: member?.role ?? data.role,
        createdBy: actor,
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + data.expiresInDays * 86_400_000).toISOString(),
      }
      await this.users.insertInvite(invite)
      const { tokenHash: _, ...publicInvite } = invite
      return { ...publicInvite, token }
    })
  }

  async list(actor: UserId) {
    if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
    return (await this.users.pendingInvites()).map(({ tokenHash: _, ...invite }) => invite)
  }

  async revoke(actor: UserId, id: string): Promise<void> {
    await this.users.claimTransaction(async () => {
      if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      await this.users.deleteInvite(InviteId.parse(id))
    })
  }

  async inspect(token: string) {
    const invite = await this.validInvite(token)
    return { email: invite.email, expiresAt: invite.expiresAt }
  }

  private async validInvite(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('Invite is invalid or no longer available')
    const invite = await this.users.inviteByHash(hashToken(token))
    if (!invite || Date.parse(invite.expiresAt) <= this.now())
      throw new Error('Invite is invalid or no longer available')
    return invite
  }

  async complete(claim: InviteClaim) {
    const identity = claim.identity
    if ('preAuthorizedMemberId' in claim && identity.kind !== 'account')
      throw new Error('Trusted claims require an account')
    // Hash before entering the serialized write transaction. Recheck the token inside it.
    if ('token' in claim) await this.validInvite(claim.token)
    const passwordHash =
      identity.kind === 'password'
        ? await hashPassword(InvitePassword.parse(identity.password))
        : undefined
    const email = identity.kind === 'password' ? LoginEmail.parse(identity.email) : undefined
    if (
      identity.kind === 'account' &&
      (!identity.accountId.trim() || identity.accountId.length > 255)
    )
      throw new Error('Account id is required')
    return await this.users.claimTransaction(async () => {
      const invite = 'token' in claim ? await this.validInvite(claim.token) : undefined
      const memberId =
        invite?.memberId ??
        ('preAuthorizedMemberId' in claim ? claim.preAuthorizedMemberId : undefined)
      let member = memberId ? await this.users.get(memberId) : undefined
      if (memberId && !member) throw new Error('Member unavailable')
      if (member?.accountId) throw new Error('Member is already claimed')
      if (email && (invite?.email ?? member?.email) && email !== (invite?.email ?? member?.email))
        throw new Error('Use the invited email')
      if (
        identity.kind === 'password' &&
        member &&
        (await this.users.credentialFor(member.id as UserId))
      )
        throw new Error('Member already has a password')
      if (!member) {
        member = {
          id: userIdFromMemberId(newMemberId()),
          email: email ?? invite?.email ?? null,
          displayName:
            identity.displayName?.trim().slice(0, 200) || email || invite?.email || 'Member',
          role: invite?.role ?? ('member' as UserRole),
          createdAt: new Date(this.now()).toISOString(),
          disabledAt: null,
        }
        await this.users.createUnclaimed(member)
      } else if (email && !member.email) {
        await this.users.setEmail(member.id as UserId, email)
      }
      if (identity.kind === 'account')
        await this.users.attachAccount(member.id as UserId, identity.accountId)
      else
        await this.users.setPasswordHash(
          member.id as UserId,
          passwordHash!,
          new Date(this.now()).toISOString(),
        )
      if (invite && !(await this.users.deleteInvite(invite.id)))
        throw new Error('Invite is no longer available')
      return (await this.users.get(member.id as UserId))!
    })
  }
}
